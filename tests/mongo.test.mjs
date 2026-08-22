// Integration tests for the MongoDB layer (src/mongo.ts -> dist/mongo.js).
// Gated: only run when TEST_DATABASE_URL points at a DEDICATED / throwaway
// database (these tests create and delete documents).
//   TEST_DATABASE_URL="mongodb+srv://.../gepetel_test" node --test tests/mongo.test.mjs
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL (a throwaway DB) to run integration tests";

let m, mongoose, db;
const GID = "testgrp-001@g.us";
const SGID = "120363000000000001@g.us";   // valid group jid, for scheduled-task tests

before(async () => {
  if (skip) return;
  process.env.GEPETEL_DATABASE_URL = TEST_DB;
  mongoose = (await import("mongoose")).default;
  m = (await import("../dist/mongo.js")).default;
  await mongoose.connection.asPromise();
  db = mongoose.connection.db;
});

after(async () => {
  if (skip || !mongoose) return;
  await cleanup();
  await mongoose.disconnect();
});

async function cleanup() {
  for (const c of ["groups", "reminders", "polls", "memories", "messages", "interactions", "scheduledtasks"]) {
    await db.collection(c).deleteMany({ $or: [{ chatId: { $in: [GID, SGID] } }, { chat_id: { $in: [GID, SGID] } }] });
  }
}
beforeEach(async () => { if (!skip) await cleanup(); });
// Attribution falls back to the People collection, so keep it clean too.
beforeEach(async () => { if (!skip) await db.collection("people").deleteMany({ phoneNumber: "40711111111" }); });

describe("activity + reply-gate bookkeeping", { skip }, () => {
  test("recordActivity bumps the UTC histogram and messagesSinceLastSend", async () => {
    await m.setParticipants(GID, ["40711", "40722"]);
    await m.recordActivity(GID, new Date(Date.UTC(2026, 0, 1, 10, 0)));
    await m.recordActivity(GID, new Date(Date.UTC(2026, 0, 1, 10, 30)));
    const meta = await m.getGroupMetadata(GID);
    assert.equal(meta.numUnsentMessages !== undefined, true);
    const g = await db.collection("groups").findOne({ chatId: GID });
    assert.equal(g.activityByHour["10"], 2);
    assert.equal(g.messagesSinceLastSend, 2);
  });

  test("markGroupReplied resets the counter and stores his last line", async () => {
    await m.setParticipants(GID, ["40711"]);
    await m.recordActivity(GID);
    await m.markGroupReplied(GID, "the number is 021 555 1234");
    const g = await db.collection("groups").findOne({ chatId: GID });
    assert.equal(g.messagesSinceLastSend, 0);
    const meta = await m.getGroupMetadata(GID);
    assert.equal(meta.lastReplyText, "the number is 021 555 1234");
    assert.ok(meta.lastReplyAt);
  });

  test("saveMessage / getCachedMessages / getLastMessagesThenDeleteThem", async () => {
    await m.setParticipants(GID, ["40711"]);
    await m.saveMessage(GID, "Ana", "msg one");
    await m.saveMessage(GID, "Mihai", "msg two");
    const cached = await m.getCachedMessages(GID);
    assert.equal(cached.length, 2);
    const flushed = await m.getLastMessagesThenDeleteThem(GID);
    assert.equal(flushed.length, 2);
    assert.equal((await m.getCachedMessages(GID)).length, 0);
  });
});

describe("reminders tool", { skip }, () => {
  test("create / list / delete", async () => {
    const r = await m.toolFunctions.create_reminder({ chat_id: GID, title: "drink water", due_date: new Date(Date.now() + 3600e3), is_individual: false });
    assert.equal(r.title, "drink water");
    const list = await m.toolFunctions.list_reminders({ chat_id: GID });
    assert.equal(list.length, 1);
    await m.toolFunctions.delete_reminder({ chat_id: GID, reminder_id: r.reminder_id });
    assert.equal((await m.toolFunctions.list_reminders({ chat_id: GID })).length, 0);
  });

  test("individual reminder requires a phone number", async () => {
    await assert.rejects(
      () => m.toolFunctions.create_reminder({ chat_id: GID, title: "ping", due_date: new Date(Date.now() + 3600e3), is_individual: true }),
      /phone_number is required/i
    );
  });

  test("update_reminder can flip is_individual to false and clears the phone", async () => {
    const r = await m.toolFunctions.create_reminder({ chat_id: GID, title: "x", due_date: new Date(Date.now() + 3600e3), is_individual: true, phone_number: "+40750271099" });
    const upd = await m.toolFunctions.update_reminder({ chat_id: GID, reminder_id: r.reminder_id, is_individual: false });
    assert.equal(upd.is_individual, false);
    assert.equal(upd.phone_number ?? null, null);
  });

  test("fireDueReminders delivers due ones and deletes them; future ones stay", async () => {
    await m.toolFunctions.create_reminder({ chat_id: GID, title: "DUE", due_date: new Date(Date.now() - 1000), is_individual: false });
    await m.toolFunctions.create_reminder({ chat_id: GID, title: "FUTURE", due_date: new Date(Date.now() + 3600e3), is_individual: false });
    const sent = [];
    const res = await m.fireDueReminders(async (to, msg) => { sent.push({ to, msg }); return true; });
    assert.equal(res.fired, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].msg, /DUE/);
    assert.equal(sent[0].to, GID); // group reminder goes to the group
    const left = await m.toolFunctions.list_reminders({ chat_id: GID });
    assert.equal(left.length, 1);
    assert.equal(left[0].title, "FUTURE");
  });

  test("failed delivery keeps the reminder for a retry", async () => {
    await m.toolFunctions.create_reminder({ chat_id: GID, title: "RETRY", due_date: new Date(Date.now() - 1000), is_individual: false });
    const res = await m.fireDueReminders(async () => false);
    assert.equal(res.fired, 0);
    // list_reminders only shows FUTURE reminders, so count the doc directly.
    assert.equal(await db.collection("reminders").countDocuments({ chat_id: GID }), 1);
  });

  test("recurring reminder re-arms to a future occurrence instead of being deleted", async () => {
    await m.toolFunctions.create_recurring_reminder({ chat_id: GID, title: "standup", due_date: new Date(Date.now() - 1000), recurrence: "daily", is_individual: false });
    const res = await m.fireDueReminders(async () => true);
    assert.equal(res.fired, 1);
    const docs = await db.collection("reminders").find({ chat_id: GID }).toArray();
    assert.equal(docs.length, 1);                       // still there
    assert.ok(new Date(docs[0].due_date) > new Date()); // advanced to the future
    assert.equal(docs[0].recurrence, "daily");
  });

  test("create_recurring_reminder rejects a bad recurrence", async () => {
    await assert.rejects(
      () => m.toolFunctions.create_recurring_reminder({ chat_id: GID, title: "x", due_date: new Date(), recurrence: "yearly", is_individual: false }),
      /recurrence must be one of/i
    );
  });
});

describe("free limit extension (one-time)", { skip }, () => {
  test("adds once, stores email, then refuses", async () => {
    await m.setParticipants(GID, ["40711"]);
    await db.collection("groups").updateOne({ chatId: GID }, { $set: { dailyReplyLimit: 64, freeExtensionUsed: false } });
    const r1 = await m.extendDailyLimitOnce(GID, 200, "x@y.com");
    assert.equal(r1.newLimit, 264);
    const g = await db.collection("groups").findOne({ chatId: GID });
    assert.equal(g.dailyReplyLimit, 264);
    assert.equal(g.freeExtensionUsed, true);
    assert.equal(g.extensionEmail, "x@y.com");
    const r2 = await m.extendDailyLimitOnce(GID, 100);
    assert.equal(r2.alreadyUsed, true);
    // limit unchanged after the refused second attempt
    assert.equal((await db.collection("groups").findOne({ chatId: GID })).dailyReplyLimit, 264);
  });
});

describe("message dedup (idempotency)", { skip }, () => {
  const MID = "wamid-test-001";
  beforeEach(async () => { if (!skip) await db.collection("processedmessages").deleteMany({ messageId: MID }); });

  test("first sighting returns true, redeliveries return false", async () => {
    assert.equal(await m.markMessageProcessed(MID), true);   // first time -> process
    assert.equal(await m.markMessageProcessed(MID), false);  // redelivery -> skip
    assert.equal(await m.markMessageProcessed(MID), false);
  });

  test("a different id is processed independently; empty id is always processed", async () => {
    assert.equal(await m.markMessageProcessed("wamid-test-002"), true);
    assert.equal(await m.markMessageProcessed(""), true);    // nothing to dedup on
    await db.collection("processedmessages").deleteMany({ messageId: "wamid-test-002" });
  });

  test("has a TTL index for auto-expiry", async () => {
    const idx = await db.collection("processedmessages").indexes();
    assert.ok(idx.some(i => i.expireAfterSeconds));
  });
});

describe("wake-up ingest cap (getLastMessagesThenDeleteThem limit)", { skip }, () => {
  test("returns only the most recent N but clears the whole cache", async () => {
    await m.setParticipants(GID, ["40711"]);
    for (let i = 0; i < 5; i++) await m.saveMessage(GID, "Ana", `m${i}`);
    const got = await m.getLastMessagesThenDeleteThem(GID, 3);
    assert.equal(got.length, 3);                 // capped at 3
    assert.equal(got[0].text, "m4");             // newest-first
    assert.equal((await m.getCachedMessages(GID)).length, 0); // surplus dropped too
  });
});

describe("growth nudge (per-person mention counter)", { skip }, () => {
  const PHONE = "40799000111";
  beforeEach(async () => { if (!skip) await db.collection("usergrowths").deleteMany({ phoneNumber: PHONE }); });

  test("counts mentions; only claims once threshold + 1 week are both met, then never again", async () => {
    // 9 mentions, all just now -> never claimed (neither threshold nor age met).
    for (let i = 0; i < 9; i++) {
      const r = await m.recordUserMention(PHONE);
      assert.equal(r.claimedNudge, false);
    }
    let g = await db.collection("usergrowths").findOne({ phoneNumber: PHONE });
    assert.equal(g.mentionCount, 9);

    // 10th mention reaches the count, but firstMentionAt is still "now" -> not aged.
    assert.equal((await m.recordUserMention(PHONE)).claimedNudge, false);

    // Backdate the first mention to 8 days ago -> next mention qualifies.
    await db.collection("usergrowths").updateOne(
      { phoneNumber: PHONE },
      { $set: { firstMentionAt: new Date(Date.now() - 8 * 864e5) } }
    );
    assert.equal((await m.recordUserMention(PHONE)).claimedNudge, true);

    // Flag is set -> no further claims, ever.
    assert.equal((await m.recordUserMention(PHONE)).claimedNudge, false);
    g = await db.collection("usergrowths").findOne({ phoneNumber: PHONE });
    assert.equal(g.nudgeSent, true);
    assert.ok(g.nudgeSentAt);
  });

  test("normalizes the phone (a '+'-prefixed number maps to the same record)", async () => {
    await m.recordUserMention("+" + PHONE);
    await m.recordUserMention(PHONE);
    const docs = await db.collection("usergrowths").find({ phoneNumber: PHONE }).toArray();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].mentionCount, 2);
  });
});

describe("known members roster", { skip }, () => {
  test("returns only members we have names for (digit-normalized match)", async () => {
    await m.setParticipants(GID, ["40711@s.whatsapp.net", "40722@s.whatsapp.net", "40733@s.whatsapp.net"], "Poker Night");
    await m.updatePeople({ phoneNumber: "40711", name: "Ana" });
    await m.updatePeople({ phoneNumber: "+40722", name: "Bo" });
    // 40733 never messaged -> unknown
    const known = await m.getKnownMembers(GID);
    assert.deepEqual(known.sort(), ["Ana", "Bo"]);
    const g = await db.collection("groups").findOne({ chatId: GID });
    assert.equal(g.name, "Poker Night"); // group name stored
  });
});

describe("interaction review log", { skip }, () => {
  test("logs entries and reads them back newest-first", async () => {
    await m.logInteraction({ chatId: GID, groupName: "T", isGroup: true, author: "Ana", incoming: "hi @gepetel", action: "replied", reply: "hey!" });
    await m.logInteraction({ chatId: GID, groupName: "T", isGroup: true, author: "Bo", incoming: "chill", action: "silent:gate-no", reply: "" });
    const got = await m.getInteractions(GID, 50);
    assert.equal(got.length, 2);
    assert.equal(got[0].action, "silent:gate-no"); // newest first
    assert.ok(got[0].createdAt);
  });
  test("has a TTL index for ~2-week auto-expiry", async () => {
    const idx = await db.collection("interactions").indexes();
    assert.ok(idx.some(i => i.expireAfterSeconds));
  });
});

describe("split_bill tool", { skip }, () => {
  test("splits with a tip", async () => {
    const r = await m.toolFunctions.split_bill({ total: 200, people: 4, tip_percent: 10 });
    assert.equal(r.per_person, 55);
  });
});

describe("polls tool + vote recording", { skip }, () => {
  test("create poll, record votes, read results", async () => {
    const poll = await m.toolFunctions.create_poll({ chat_id: GID, question: "Pizza?", options: ["Yes", "No"] });
    await m.setPollWaMessageId(poll.poll_id, "WA_MSG_1");
    await m.recordPollVotes("WA_MSG_1", { total: 3, results: [
      { name: "Yes", count: 2, voters: ["a", "b"] },
      { name: "No", count: 1, voters: ["c"] },
    ]});
    const res = await m.toolFunctions.get_poll_results({ chat_id: GID, poll_id: poll.poll_id });
    assert.equal(res.total, 3);
    const yes = res.results.find(r => r.name === "Yes");
    assert.equal(yes.count, 2);
  });
});

describe("memory tool", { skip }, () => {
  test("remember / list / delete", async () => {
    const mem = await m.toolFunctions.remember_fact({ chat_id: GID, summary: "trip to the mountains on Sat" });
    const list = await m.toolFunctions.list_memories({ chat_id: GID });
    assert.equal(list.length, 1);
    const id = mem._id?.toString?.() || mem.id || list[0]._id?.toString?.();
    await m.toolFunctions.delete_memory({ chat_id: GID, memory_id: id });
    assert.equal((await m.toolFunctions.list_memories({ chat_id: GID })).length, 0);
  });
});

describe("unprompted scheduling", { skip }, () => {
  test("a due, active group is selected; an on-cooldown one is not", async () => {
    await m.setParticipants(GID, ["40711", "40722"]);
    // Make it due + active.
    await db.collection("groups").updateOne({ chatId: GID }, { $set: { nextUnpromptedAt: new Date(Date.now() - 1000), messagesSinceLastSend: 12 } });
    let due = await m.getGroupsDueForUnprompted(10);
    assert.ok(due.some(g => g.chatId === GID));
    // Reschedule into the future -> no longer due.
    await m.scheduleNextUnprompted(GID);
    due = await m.getGroupsDueForUnprompted(10);
    assert.ok(!due.some(g => g.chatId === GID));
  });

  test("active group below the message threshold is not selected", async () => {
    await m.setParticipants(GID, ["40711"]);
    await db.collection("groups").updateOne({ chatId: GID }, { $set: { nextUnpromptedAt: new Date(Date.now() - 1000), messagesSinceLastSend: 3 } });
    const due = await m.getGroupsDueForUnprompted(10);
    assert.ok(!due.some(g => g.chatId === GID));
  });
});

// --- Scheduled tasks ---------------------------------------------------------

const MEMBER = "40711111111";
const OUTSIDER = "40799999999";

function pollTask(overrides = {}) {
  return {
    chat_id: SGID, kind: "poll",
    payload: { question: "Lunch?", options: ["Pizza", "Sushi"] },
    hour_local: 9, days_of_week: "weekdays",
    ...overrides,
  };
}

// Records what would have been sent, so tests assert on effects not network.
function spyDeps() {
  const sent = { messages: [], polls: [] };
  return {
    sent,
    sendMessage: async (to, message) => { sent.messages.push({ to, message }); return true; },
    sendPoll: async (to, question, options, allowMultiple) => {
      sent.polls.push({ to, question, options, allowMultiple });
      return "wamid.TEST123";
    },
  };
}

describe("scheduled tasks — authorization", { skip }, () => {
  beforeEach(async () => {
    if (!skip) await m.setParticipants(SGID, [`${MEMBER}@s.whatsapp.net`, "40722222222"]);
  });

  test("a member of the group can create a task", async () => {
    const t = await m.createScheduledTask(pollTask(), { requesterChatId: MEMBER });
    assert.equal(t.chat_id, SGID);
    assert.equal(t.created_by, MEMBER);          // attribution comes from the context
    assert.deepEqual(t.days_of_week, [1, 2, 3, 4, 5]);
  });

  test("a non-member CANNOT create a task in that group", async () => {
    await assert.rejects(
      () => m.createScheduledTask(pollTask(), { requesterChatId: OUTSIDER }),
      /not a member/
    );
    assert.equal(await db.collection("scheduledtasks").countDocuments({ chat_id: SGID }), 0);
  });

  test("no context at all is refused (fail-closed)", async () => {
    await assert.rejects(() => m.createScheduledTask(pollTask(), {}), /no requester/);
  });

  test("admin may target any group", async () => {
    const t = await m.createScheduledTask(pollTask(), { admin: true });
    assert.equal(t.chat_id, SGID);
  });

  test("a non-member can neither see, edit nor delete an existing task", async () => {
    const t = await m.createScheduledTask(pollTask(), { admin: true });
    // Same "not found" as a missing id — existence is not confirmed.
    await assert.rejects(() => m.deleteScheduledTask(t.task_id, { requesterChatId: OUTSIDER }), /not found/);
    await assert.rejects(() => m.updateScheduledTask(t.task_id, { active: false }, { requesterChatId: OUTSIDER }), /not found/);
    assert.deepEqual(await m.listScheduledTasks(SGID, { requesterChatId: OUTSIDER }), []);
    // …and it survived all of that.
    assert.equal(await db.collection("scheduledtasks").countDocuments({ task_id: t.task_id }), 1);
  });

  test("a member sees the task and can delete it", async () => {
    const t = await m.createScheduledTask(pollTask(), { requesterChatId: MEMBER });
    const list = await m.listScheduledTasks(undefined, { requesterChatId: MEMBER });
    assert.equal(list.length, 1);
    assert.equal(list[0].schedule, "every workday at 09:00 (Europe/Bucharest)");
    await m.deleteScheduledTask(t.task_id, { requesterChatId: MEMBER });
    assert.equal(await db.collection("scheduledtasks").countDocuments({ task_id: t.task_id }), 0);
  });

  test("a task cannot be re-pointed at another group", async () => {
    const t = await m.createScheduledTask(pollTask(), { requesterChatId: MEMBER });
    await assert.rejects(
      () => m.updateScheduledTask(t.task_id, { chat_id: "120363000000000000@g.us" }, { requesterChatId: MEMBER }),
      /can't be moved/
    );
  });

  test("creating against an unknown group fails", async () => {
    await assert.rejects(
      () => m.createScheduledTask(pollTask({ chat_id: "120363000000000000@g.us" }), { admin: true }),
      /not in a group/
    );
  });
});

describe("scheduled tasks — firing", { skip }, () => {
  // Wed 2026-02-04, 09:00 Europe/Bucharest.
  const DUE = new Date("2026-02-04T07:00:00Z");
  const NOT_DUE = new Date("2026-02-04T09:00:00Z");   // 11:00 local

  beforeEach(async () => {
    if (!skip) await m.setParticipants(SGID, [`${MEMBER}@s.whatsapp.net`, "40722222222"]);
  });

  test("sends the poll when due, and not when it isn't", async () => {
    await m.createScheduledTask(pollTask(), { admin: true });

    let d = spyDeps();
    assert.equal((await m.fireDueScheduledTasks(d, NOT_DUE)).fired, 0);
    assert.equal(d.sent.polls.length, 0);

    d = spyDeps();
    const r = await m.fireDueScheduledTasks(d, DUE);
    assert.equal(r.fired, 1);
    assert.deepEqual(d.sent.polls[0], {
      to: SGID, question: "Lunch?", options: ["Pizza", "Sushi"], allowMultiple: false,
    });
  });

  test("THE SILENCE GUARANTEE: firing never touches the reply gate", async () => {
    // A group Gepetel last spoke in long ago — i.e. currently silent.
    const longAgo = new Date("2026-01-01T00:00:00Z");
    await db.collection("groups").updateOne({ chatId: SGID },
      { $set: { lastReplyAt: longAgo, lastReplyText: "an old line", dailyReplyCount: 3, messagesSinceLastSend: 7 } });

    await m.createScheduledTask(pollTask(), { admin: true });
    await m.fireDueScheduledTasks(spyDeps(), DUE);

    const g = await db.collection("groups").findOne({ chatId: SGID });
    // If any of these moved, the 5-minute continuation window would reopen and
    // Gepetel would start replying to people discussing the poll.
    assert.equal(new Date(g.lastReplyAt).toISOString(), longAgo.toISOString());
    assert.equal(g.lastReplyText, "an old line");
    assert.equal(g.dailyReplyCount, 3);          // scheduled posts don't burn the daily limit
    assert.equal(g.messagesSinceLastSend, 7);    // nor disturb the gossip cadence
  });

  test("what was posted is cached so he has context when he does wake up", async () => {
    await m.createScheduledTask(pollTask(), { admin: true });
    await m.fireDueScheduledTasks(spyDeps(), DUE);
    const cached = await m.getCachedMessages(SGID);
    const mine = cached.filter(c => c.from === "Gepetel");
    assert.equal(mine.length, 1);
    assert.match(mine[0].text, /\[poll\] Lunch\? — options: Pizza, Sushi/);
  });

  test("does not double-post within the same hour", async () => {
    await m.createScheduledTask(pollTask(), { admin: true });
    const d = spyDeps();
    assert.equal((await m.fireDueScheduledTasks(d, DUE)).fired, 1);
    assert.equal((await m.fireDueScheduledTasks(d, new Date("2026-02-04T07:40:00Z"))).fired, 0);
    assert.equal(d.sent.polls.length, 1);
  });

  test("the poll is registered so incoming votes can be tallied", async () => {
    await m.createScheduledTask(pollTask(), { admin: true });
    await m.fireDueScheduledTasks(spyDeps(), DUE);
    const poll = await db.collection("polls").findOne({ chat_id: SGID });
    assert.equal(poll.question, "Lunch?");
    assert.equal(poll.wa_message_id, "wamid.TEST123");
  });

  test("text tasks send their stored copy verbatim", async () => {
    await m.createScheduledTask(
      { chat_id: SGID, kind: "text", payload: { text: "standup in 5" }, hour_local: 9, days_of_week: [3] },
      { admin: true });
    const d = spyDeps();
    await m.fireDueScheduledTasks(d, DUE);
    assert.equal(d.sent.messages[0].message, "standup in 5");
  });

  test("an inactive task never fires", async () => {
    const t = await m.createScheduledTask(pollTask(), { admin: true });
    await m.updateScheduledTask(t.task_id, { active: false }, { admin: true });
    const d = spyDeps();
    assert.equal((await m.fireDueScheduledTasks(d, DUE)).fired, 0);
    assert.equal(d.sent.polls.length, 0);
  });

  test("if Gepetel has left the group the task is paused, not retried forever", async () => {
    await m.createScheduledTask(pollTask(), { admin: true });
    await m.setBotPresent(SGID, false);
    const d = spyDeps();
    const r = await m.fireDueScheduledTasks(d, DUE);
    assert.equal(r.fired, 0);
    assert.equal(d.sent.polls.length, 0);
    const t = await db.collection("scheduledtasks").findOne({ chat_id: SGID });
    assert.equal(t.active, false);
  });

  test("a failed send releases the slot so it can retry within the hour", async () => {
    await m.createScheduledTask(
      { chat_id: SGID, kind: "text", payload: { text: "hi" }, hour_local: 9, days_of_week: [3] },
      { admin: true });
    const failing = { ...spyDeps(), sendMessage: async () => { throw new Error("whapi down"); } };
    const r = await m.fireDueScheduledTasks(failing, DUE);
    assert.equal(r.failed, 1);
    const t = await db.collection("scheduledtasks").findOne({ chat_id: SGID });
    assert.equal(t.last_fired_at, null);          // claim released

    const ok = spyDeps();
    assert.equal((await m.fireDueScheduledTasks(ok, new Date("2026-02-04T07:30:00Z"))).fired, 1);
  });

  test("run-now ignores the schedule and doesn't consume the real slot", async () => {
    const t = await m.createScheduledTask(pollTask(), { admin: true });
    const d = spyDeps();
    const r = await m.runScheduledTaskNow(t.task_id, d, { admin: true });   // 'not due' time irrelevant
    assert.equal(r.sent, true);
    assert.equal(d.sent.polls.length, 1);
    const row = await db.collection("scheduledtasks").findOne({ task_id: t.task_id });
    assert.equal(row.last_fired_at, null);
    // …so the scheduled run still happens later.
    assert.equal((await m.fireDueScheduledTasks(spyDeps(), DUE)).fired, 1);
  });

  test("a member can trigger their own task by hand", async () => {
    const t = await m.createScheduledTask(pollTask(), { requesterChatId: MEMBER });
    const d = spyDeps();
    const r = await m.runScheduledTaskNow(t.task_id, d, { requesterChatId: MEMBER });
    assert.equal(r.sent, true);
    assert.equal(d.sent.polls.length, 1);
  });

  test("run-now reports failure instead of pretending it sent", async () => {
    const t = await m.createScheduledTask(
      { chat_id: SGID, kind: "generated", payload: { instruction: "ceva" }, hour_local: 9, days_of_week: [3] },
      { admin: true });
    const d = spyDeps();
    d.generate = async () => null;              // nothing to say
    const r = await m.runScheduledTaskNow(t.task_id, d, { admin: true });
    assert.equal(r.sent, false);                // caller must be able to tell
    assert.equal(r.reason, "nothing-to-send");
    assert.equal(d.sent.messages.length, 0);
  });

  test("run-now is subject to the same membership check", async () => {
    const t = await m.createScheduledTask(pollTask(), { admin: true });
    await assert.rejects(() => m.runScheduledTaskNow(t.task_id, spyDeps(), { requesterChatId: OUTSIDER }), /not found/);
  });
});

describe("scheduled tasks — generated kind", { skip }, () => {
  const DUE = new Date("2026-02-04T07:00:00Z");   // Wed 09:00 Europe/Bucharest

  beforeEach(async () => {
    if (!skip) await m.setParticipants(SGID, [`${MEMBER}@s.whatsapp.net`, "40722222222"]);
  });

  test("a generated task sends whatever the generator returns", async () => {
    await m.createScheduledTask(
      { chat_id: SGID, kind: "generated", payload: { instruction: "spune o gluma" }, hour_local: 9, days_of_week: [3] },
      { admin: true });
    const d = { ...spyDeps(), generate: async () => "de ce nu joaca ursii poker? prea multi cheetahs" };
    d.sendMessage = async (to, message) => { d.sent.messages.push({ to, message }); return true; };
    const r = await m.fireDueScheduledTasks(d, DUE);
    assert.equal(r.fired, 1);
    assert.match(d.sent.messages[0].message, /prea multi cheetahs/);
  });

  test("the generator gets the task and the group, so it can match the group's language", async () => {
    await m.createScheduledTask(
      { chat_id: SGID, kind: "generated", payload: { instruction: "noutati din Formula 1", web_search: true },
        hour_local: 9, days_of_week: [3] },
      { admin: true });
    let seen = null;
    const d = spyDeps();
    d.generate = async (task, group) => {
      seen = { kind: task.kind, instruction: task.payload.instruction, web: task.payload.web_search, chatId: group.chatId };
      return "ceva";
    };
    await m.fireDueScheduledTasks(d, DUE);
    assert.deepEqual(seen, { kind: "generated", instruction: "noutati din Formula 1", web: true, chatId: SGID });
  });

  test("nothing is posted when the generator has nothing (or the API is down)", async () => {
    await m.createScheduledTask(
      { chat_id: SGID, kind: "generated", payload: { instruction: "nimic" }, hour_local: 9, days_of_week: [3] },
      { admin: true });
    const d = spyDeps();
    d.generate = async () => null;          // what a 429 / "no answer" looks like here
    const r = await m.fireDueScheduledTasks(d, DUE);
    assert.equal(r.fired, 0);
    assert.equal(d.sent.messages.length, 0);
    assert.equal(d.sent.polls.length, 0);
    // Nothing was posted, so there's nothing to remember either.
    assert.equal((await m.getCachedMessages(SGID)).filter(c => c.from === "Gepetel").length, 0);
  });

  test("a missing generator degrades to silence, never to a broken post", async () => {
    await m.createScheduledTask(
      { chat_id: SGID, kind: "generated", payload: { instruction: "o gluma" }, hour_local: 9, days_of_week: [3] },
      { admin: true });
    const d = spyDeps();                     // no `generate` at all
    assert.equal((await m.fireDueScheduledTasks(d, DUE)).fired, 0);
    assert.equal(d.sent.messages.length, 0);
  });
});

describe("scheduled tasks — attribution", { skip }, () => {
  const DUE = new Date("2026-02-04T07:00:00Z");

  beforeEach(async () => {
    if (!skip) await m.setParticipants(SGID, [`${MEMBER}@s.whatsapp.net`, "40722222222"]);
  });

  test("a poll credits whoever scheduled it, in its title", async () => {
    await m.createScheduledTask(pollTask({ created_by_name: "Bogdan Ripa" }), { requesterChatId: MEMBER });
    const d = spyDeps();
    await m.fireDueScheduledTasks(d, DUE);
    assert.equal(d.sent.polls[0].question, "Lunch? (via @Bogdan)");
    // Options are untouched — attribution must never eat a poll answer.
    assert.deepEqual(d.sent.polls[0].options, ["Pizza", "Sushi"]);
  });

  test("a message credits them on its own line", async () => {
    await m.createScheduledTask(
      { chat_id: SGID, kind: "text", payload: { text: "standup in 5" }, hour_local: 9,
        days_of_week: [3], created_by_name: "Bogdan" },
      { requesterChatId: MEMBER });
    const d = spyDeps();
    await m.fireDueScheduledTasks(d, DUE);
    assert.equal(d.sent.messages[0].message, "standup in 5\n\n— via @Bogdan");
  });

  test("falls back to the stored contact name when none was captured", async () => {
    await m.updatePeople({ phoneNumber: MEMBER, name: "Andrei" });
    await m.createScheduledTask(pollTask(), { requesterChatId: MEMBER });   // no created_by_name
    const d = spyDeps();
    await m.fireDueScheduledTasks(d, DUE);
    assert.equal(d.sent.polls[0].question, "Lunch? (via @Andrei)");
  });

  test("an unattributable task still sends, just without a credit", async () => {
    await m.createScheduledTask(pollTask(), { admin: true });   // no requester at all
    const d = spyDeps();
    await m.fireDueScheduledTasks(d, DUE);
    assert.equal(d.sent.polls[0].question, "Lunch?");
  });
});

describe("one-off polls", { skip }, () => {
  // A future date, since creation refuses one in the past. Europe/Bucharest is
  // UTC+2 in December, so 09:00 local is 07:00Z.
  const ONCE_DUE = new Date("2026-12-02T07:00:00Z");

  beforeEach(async () => {
    if (!skip) await m.setParticipants(SGID, [`${MEMBER}@s.whatsapp.net`, "40722222222"]);
  });

  test("send_poll_now posts immediately and stores no schedule", async () => {
    const d = spyDeps();
    const r = await m.sendPollNow(SGID,
      { question: "Bere?", options: ["Da", "Nu"], allow_multiple: false },
      d, { requesterChatId: MEMBER }, "Bogdan");
    assert.equal(r.sent, true);
    assert.equal(d.sent.polls[0].question, "Bere? (via @Bogdan)");
    // The whole point: nothing recurring is left behind.
    assert.equal(await db.collection("scheduledtasks").countDocuments({ chat_id: SGID }), 0);
    // …but the poll itself is tracked, so votes still tally.
    assert.equal(await db.collection("polls").countDocuments({ chat_id: SGID }), 1);
  });

  test("send_poll_now still refuses a group you're not in", async () => {
    await assert.rejects(
      () => m.sendPollNow(SGID, { question: "q", options: ["a", "b"] }, spyDeps(), { requesterChatId: OUTSIDER }),
      /not a member/
    );
  });

  test("send_poll_now validates the poll like any other", async () => {
    await assert.rejects(
      () => m.sendPollNow(SGID, { question: "q", options: ["only"] }, spyDeps(), { admin: true }),
      /at least 2 distinct/
    );
  });

  test("send_poll_now does not wake Gepetel up either", async () => {
    const longAgo = new Date("2026-01-01T00:00:00Z");
    await db.collection("groups").updateOne({ chatId: SGID },
      { $set: { lastReplyAt: longAgo, dailyReplyCount: 3 } });
    await m.sendPollNow(SGID, { question: "q", options: ["a", "b"] }, spyDeps(), { admin: true });
    const g = await db.collection("groups").findOne({ chatId: SGID });
    assert.equal(new Date(g.lastReplyAt).toISOString(), longAgo.toISOString());
    assert.equal(g.dailyReplyCount, 3);
  });

  test("a dated one-off runs on its day, then never again", async () => {
    const t = await m.createScheduledTask(
      { chat_id: SGID, kind: "poll", payload: { question: "Vineri?", options: ["Da", "Nu"] },
        hour_local: 9, run_on_date: "2026-12-02" },
      { admin: true });
    const d = spyDeps();
    assert.equal((await m.fireDueScheduledTasks(d, ONCE_DUE)).fired, 1);
    // Retired, not repeated.
    const row = await db.collection("scheduledtasks").findOne({ task_id: t.task_id });
    assert.equal(row.active, false);
    assert.equal((await m.fireDueScheduledTasks(spyDeps(), ONCE_DUE)).fired, 0);
  });

  test("a dated one-off still fires later the same day if its hour was missed", async () => {
    await m.createScheduledTask(
      { chat_id: SGID, kind: "poll", payload: { question: "q", options: ["a", "b"] },
        hour_local: 9, run_on_date: "2026-12-02" },
      { admin: true });
    // 14:00 local — well past 09:00, same day.
    assert.equal((await m.fireDueScheduledTasks(spyDeps(), new Date("2026-12-02T12:00:00Z"))).fired, 1);
  });

  test("a dated one-off never fires on a different day", async () => {
    await m.createScheduledTask(
      { chat_id: SGID, kind: "poll", payload: { question: "q", options: ["a", "b"] },
        hour_local: 9, run_on_date: "2026-12-02" },
      { admin: true });
    assert.equal((await m.fireDueScheduledTasks(spyDeps(), new Date("2026-12-03T07:00:00Z"))).fired, 0);
  });

  test("a date in the past is rejected at creation", async () => {
    await assert.rejects(
      () => m.createScheduledTask(
        { chat_id: SGID, kind: "poll", payload: { question: "q", options: ["a", "b"] },
          hour_local: 9, run_on_date: "2020-01-01" }, { admin: true }),
      /in the past/
    );
    await assert.rejects(
      () => m.createScheduledTask(
        { chat_id: SGID, kind: "poll", payload: { question: "q", options: ["a", "b"] },
          hour_local: 9, run_on_date: "2026-02-30" }, { admin: true }),
      /real calendar date/
    );
  });
});

describe("monthly scheduling (storage)", { skip }, () => {
  beforeEach(async () => {
    if (!skip) await m.setParticipants(SGID, [`${MEMBER}@s.whatsapp.net`, "40722222222"]);
  });

  test("stores days_of_month and leaves days_of_week empty", async () => {
    const t = await m.createScheduledTask(
      { chat_id: SGID, kind: "poll", payload: { question: "Birou?", options: ["Da", "Nu"] },
        hour_local: 9, days_of_month: [25, 21, 21] },
      { admin: true });
    assert.deepEqual(t.days_of_month, [21, 25]);   // sorted, de-duplicated
    assert.deepEqual(t.days_of_week, []);
    assert.equal(t.run_on_date, null);
  });

  test("fires on the 21st and 25th, and on nothing else", async () => {
    await m.createScheduledTask(
      { chat_id: SGID, kind: "poll", payload: { question: "Birou?", options: ["Da", "Nu"] },
        hour_local: 9, days_of_month: [21, 25] },
      { admin: true });
    // 09:00 Europe/Bucharest in August is 06:00Z.
    assert.equal((await m.fireDueScheduledTasks(spyDeps(), new Date("2026-08-21T06:00:00Z"))).fired, 1);
    assert.equal((await m.fireDueScheduledTasks(spyDeps(), new Date("2026-08-22T06:00:00Z"))).fired, 0);
    assert.equal((await m.fireDueScheduledTasks(spyDeps(), new Date("2026-09-25T06:00:00Z"))).fired, 1);
  });

  test("switching to monthly clears the weekly days, and back again", async () => {
    const t = await m.createScheduledTask(
      { chat_id: SGID, kind: "text", payload: { text: "hi" }, hour_local: 9, days_of_week: [1, 2, 3, 4, 5] },
      { admin: true });
    const monthly = await m.updateScheduledTask(t.task_id, { days_of_month: [21, 25] }, { admin: true });
    assert.deepEqual(monthly.days_of_month, [21, 25]);
    assert.deepEqual(monthly.days_of_week, []);
    const weekly = await m.updateScheduledTask(t.task_id, { days_of_week: [5] }, { admin: true });
    assert.deepEqual(weekly.days_of_week, [5]);
    assert.deepEqual(weekly.days_of_month, []);
  });

  test("an explicit timezone overrides the one guessed from phone numbers", async () => {
    const t = await m.createScheduledTask(
      { chat_id: SGID, kind: "text", payload: { text: "hi" }, hour_local: 9,
        days_of_month: [21], timezone: "America/Los_Angeles" },
      { admin: true });
    assert.equal(t.timezone, "America/Los_Angeles");
    // 09:00 in LA is 16:00Z in August — not 06:00Z, which is Bucharest's.
    assert.equal((await m.fireDueScheduledTasks(spyDeps(), new Date("2026-08-21T06:00:00Z"))).fired, 0);
    assert.equal((await m.fireDueScheduledTasks(spyDeps(), new Date("2026-08-21T16:00:00Z"))).fired, 1);
  });

  test("getGroupsByParticipant reports the timezone and whether to trust it", async () => {
    const single = await m.getGroupsByParticipant(MEMBER);
    const g = single.find(x => x.chatId === SGID);
    assert.equal(g.timezone, "Europe/Bucharest");
    assert.equal(g.timezoneConfident, true);        // everyone is +40

    await m.setParticipants(SGID, [`${MEMBER}@s.whatsapp.net`, "447700900123"]);
    const mixed = (await m.getGroupsByParticipant(MEMBER)).find(x => x.chatId === SGID);
    assert.equal(mixed.timezoneConfident, false);   // RO + UK -> must be confirmed
  });
});

describe("growth nudges", { skip }, () => {
  const PHONE = "40766666666";
  beforeEach(async () => { if (!skip) await db.collection("usergrowths").deleteMany({ phoneNumber: PHONE }); });
  after(async () => { if (!skip) await db.collection("usergrowths").deleteMany({ phoneNumber: PHONE }); });

  // Mentions are counted as they arrive; the age gate is faked by backdating.
  // Returns whether ANY of the n mentions claimed a nudge — the claim lands on
  // the mention that crosses the threshold, not necessarily the last one.
  async function mention(n = 1) {
    let claimed = false, nudgeNumber;
    for (let i = 0; i < n; i++) {
      const r = await m.recordUserMention(PHONE);
      if (r.claimedNudge) { claimed = true; nudgeNumber = r.nudgeNumber; }
    }
    return { claimedNudge: claimed, nudgeNumber };
  }
  const backdate = (field, days) => db.collection("usergrowths").updateOne(
    { phoneNumber: PHONE },
    { $set: { [field]: new Date(Date.now() - days * 24 * 3600 * 1000) } });

  test("not nudged before enough mentions", async () => {
    await mention(2);
    await backdate("firstMentionAt", 30);
    const doc = await db.collection("usergrowths").findOne({ phoneNumber: PHONE });
    assert.equal(doc.nudgeCount || 0, 0);
  });

  test("not nudged before they've been around long enough", async () => {
    const r = await mention(5);          // plenty of mentions, but all just now
    assert.equal(r.claimedNudge, false);
  });

  test("nudged once both gates pass", async () => {
    await mention(2);
    await backdate("firstMentionAt", 30);
    const r = await mention(1);          // third mention crosses the threshold
    assert.equal(r.claimedNudge, true);
    assert.equal(r.nudgeNumber, 1);
  });

  test("never twice in a row — the cooldown holds", async () => {
    await mention(2);
    await backdate("firstMentionAt", 30);
    assert.equal((await mention(1)).claimedNudge, true);
    // Plenty more mentions, but the cooldown hasn't passed.
    assert.equal((await mention(10)).claimedNudge, false);
  });

  test("a follow-up needs BOTH the cooldown and fresh engagement", async () => {
    await mention(2);
    await backdate("firstMentionAt", 30);
    await mention(1);                                  // nudge #1
    await backdate("nudgeSentAt", 90);                 // cooldown long past

    // Cooldown alone isn't enough: they have to have engaged again since.
    assert.equal((await mention(1)).claimedNudge, false);   // 1 fresh mention, needs 3
    assert.equal((await mention(2)).claimedNudge, true);    // now 3 fresh -> nudge #2
    const doc = await db.collection("usergrowths").findOne({ phoneNumber: PHONE });
    assert.equal(doc.nudgeCount, 2);
  });

  test("stops for good at the lifetime cap", async () => {
    await mention(2);
    await backdate("firstMentionAt", 60);
    for (let i = 0; i < 3; i++) {
      await backdate("nudgeSentAt", 90);
      assert.equal((await mention(3)).claimedNudge, true, `nudge ${i + 1} should fire`);
    }
    await backdate("nudgeSentAt", 90);
    assert.equal((await mention(5)).claimedNudge, false);   // capped at 3
  });

  test("someone nudged under the old one-shot rule counts as having had one", async () => {
    // Legacy row: nudgeSent true, no nudgeCount / mentionsAtLastNudge fields.
    await db.collection("usergrowths").insertOne({
      phoneNumber: PHONE, mentionCount: 20,
      firstMentionAt: new Date(Date.now() - 200 * 24 * 3600 * 1000),
      nudgeSent: true, nudgeSentAt: new Date(Date.now() - 200 * 24 * 3600 * 1000),
    });
    const r = await mention(1);
    assert.equal(r.claimedNudge, true);
    assert.equal(r.nudgeNumber, 2);      // counted as the SECOND, not the first
  });
});

describe("group members — code-enforced access", { skip }, () => {
  const OTHER_GROUP = "120363000000000002@g.us";
  beforeEach(async () => {
    if (skip) return;
    await m.setParticipants(SGID, [`${MEMBER}@s.whatsapp.net`, "40722222222", "40733333333"], "Genezio TEAM");
    await m.updatePeople({ phoneNumber: MEMBER, name: "Bogdan" });
    await m.updatePeople({ phoneNumber: "40722222222", name: "Den" });
    // A group the requester is NOT in, with its own member.
    await m.setParticipants(OTHER_GROUP, ["40788888888"], "Secret Group");
    await m.updatePeople({ phoneNumber: "40788888888", name: "Cineva" });
  });
  after(async () => {
    if (skip) return;
    for (const c of ["groups", "scheduledtasks"]) await db.collection(c).deleteMany({ chatId: OTHER_GROUP, chat_id: OTHER_GROUP });
    await db.collection("groups").deleteMany({ chatId: OTHER_GROUP });
    await db.collection("people").deleteMany({ phoneNumber: { $in: ["40722222222", "40733333333", "40788888888"] } });
  });

  test("a member gets the names, and an honest count of who's still unknown", async () => {
    const r = await m.listGroupMembers(SGID, { requesterChatId: MEMBER });
    assert.equal(r.group_name, "Genezio TEAM");
    assert.deepEqual(r.known_names.sort(), ["Bogdan", "Den"]);
    assert.equal(r.total_members, 3);
    assert.equal(r.unknown_count, 1);        // 40733333333 has never spoken
  });

  test("never returns phone numbers", async () => {
    const r = await m.listGroupMembers(SGID, { requesterChatId: MEMBER });
    const blob = JSON.stringify(r);
    for (const p of [MEMBER, "40722222222", "40733333333"]) {
      assert.equal(blob.includes(p), false, `phone ${p} must not be in the response`);
    }
  });

  test("a NON-member is refused, and isn't told the group exists", async () => {
    await assert.rejects(
      () => m.listGroupMembers(OTHER_GROUP, { requesterChatId: MEMBER }),
      /not a member/
    );
  });

  test("refused for a group nobody is in, and for a bogus id", async () => {
    await assert.rejects(() => m.listGroupMembers("120363999999999999@g.us", { requesterChatId: MEMBER }), /not in a group/);
    await assert.rejects(() => m.listGroupMembers("not-a-group", { requesterChatId: MEMBER }), /must be a WhatsApp group id/);
    await assert.rejects(() => m.listGroupMembers(`${MEMBER}@s.whatsapp.net`, { requesterChatId: MEMBER }), /must be a WhatsApp group id/);
  });

  test("fail-closed: no requester at all is refused", async () => {
    await assert.rejects(() => m.listGroupMembers(SGID, {}), /no requester/);
    await assert.rejects(() => m.listGroupMembers(SGID, { requesterChatId: "" }), /no requester/);
  });

  test("a near-miss phone number does not pass as membership", async () => {
    // Prefixes, suffixes and one-digit-off numbers must all fail.
    for (const impostor of ["4071111111", "407111111119", "1111111", "1140711111111"]) {
      await assert.rejects(
        () => m.listGroupMembers(SGID, { requesterChatId: impostor }),
        /not a member/, `"${impostor}" must not pass as ${MEMBER}`
      );
    }
  });

  test("someone removed from the group loses access on the next roster refresh", async () => {
    assert.ok(await m.listGroupMembers(SGID, { requesterChatId: MEMBER }));
    await m.setParticipants(SGID, ["40722222222", "40733333333"], "Genezio TEAM");   // MEMBER removed
    await assert.rejects(() => m.listGroupMembers(SGID, { requesterChatId: MEMBER }), /not a member/);
  });
});

describe("1:1 abuse gate", { skip }, () => {
  const DM = "40755555555@s.whatsapp.net";
  beforeEach(async () => { if (!skip) await db.collection("dmquotas").deleteMany({ chatId: DM }); });
  after(async () => { if (!skip) await db.collection("dmquotas").deleteMany({ chatId: DM }); });

  test("an ordinary conversation is never blocked", async () => {
    // Spread across windows so the burst cap isn't what's being tested.
    let t = new Date("2026-08-16T09:00:00Z");
    for (let i = 0; i < 30; i++) {
      const r = await m.claimDmMessage(DM, t);
      assert.equal(r.allowed, true, `message ${i + 1} should be allowed`);
      t = new Date(t.getTime() + 11 * 60 * 1000);   // 11 min apart
    }
  });

  test("a burst is stopped, and clears by itself", async () => {
    const t0 = new Date("2026-08-16T09:00:00Z");
    let blocked = 0;
    for (let i = 0; i < 20; i++) {
      const r = await m.claimDmMessage(DM, new Date(t0.getTime() + i * 1000));
      if (!r.allowed) { blocked++; assert.equal(r.reason, "burst"); }
    }
    assert.ok(blocked > 0, "a 20-message burst must hit the limit");
    // Once the window has passed, they're served again.
    const later = await m.claimDmMessage(DM, new Date(t0.getTime() + 11 * 60 * 1000));
    assert.equal(later.allowed, true);
  });

  test("the daily cap holds, and resets the next UTC day", async () => {
    let t = new Date("2026-08-16T00:00:00Z");
    let allowed = 0;
    for (let i = 0; i < 60; i++) {
      const r = await m.claimDmMessage(DM, t);
      if (r.allowed) allowed++;
      t = new Date(t.getTime() + 11 * 60 * 1000);   // stay clear of the burst window
    }
    assert.equal(allowed, 40, "exactly the daily allowance should get through");
    // Next day: served again.
    const tomorrow = await m.claimDmMessage(DM, new Date("2026-08-17T08:00:00Z"));
    assert.equal(tomorrow.allowed, true);
  });

  test("we say why at most once an hour, then just stay quiet", async () => {
    const t0 = new Date("2026-08-16T09:00:00Z");
    // Exactly the burst allowance, all allowed — the next one is the first block.
    for (let i = 0; i < 12; i++) await m.claimDmMessage(DM, new Date(t0.getTime() + i * 1000));
    const first = await m.claimDmMessage(DM, new Date(t0.getTime() + 13_000));
    assert.equal(first.allowed, false);
    assert.equal(first.shouldTell, true);            // told once
    const second = await m.claimDmMessage(DM, new Date(t0.getTime() + 15_000));
    assert.equal(second.shouldTell, false);          // not again straight away
  });

  test("one person's budget is their own", async () => {
    const OTHER = "40766666667@s.whatsapp.net";
    const t0 = new Date("2026-08-16T09:00:00Z");
    for (let i = 0; i < 20; i++) await m.claimDmMessage(DM, new Date(t0.getTime() + i * 1000));
    const other = await m.claimDmMessage(OTHER, new Date(t0.getTime() + 21_000));
    assert.equal(other.allowed, true);
    await db.collection("dmquotas").deleteMany({ chatId: OTHER });
  });
});

describe("message archive (reply resolution)", { skip }, () => {
  const CHAT = "120363000000000009@g.us";
  beforeEach(async () => { if (!skip) await db.collection("messagearchives").deleteMany({ chatId: CHAT }); });
  after(async () => { if (!skip) await db.collection("messagearchives").deleteMany({ chatId: CHAT }); });

  test("stores and resolves a message by its WhatsApp id", async () => {
    await m.archiveMessage(CHAT, "wamid.AAA", "Ana", "hai sâmbătă la munte");
    assert.deepEqual(await m.getArchivedMessage("wamid.AAA"), { from: "Ana", text: "hai sâmbătă la munte" });
  });

  test("an unknown id resolves to null, not an error", async () => {
    assert.equal(await m.getArchivedMessage("wamid.NOPE"), null);
    assert.equal(await m.getArchivedMessage(""), null);
  });

  test("a redelivered webhook doesn't duplicate or throw", async () => {
    await m.archiveMessage(CHAT, "wamid.BBB", "Ana", "prima");
    await m.archiveMessage(CHAT, "wamid.BBB", "Ana", "prima");
    assert.equal(await db.collection("messagearchives").countDocuments({ messageId: "wamid.BBB" }), 1);
  });

  test("Gepetel's own messages are archived too, so replies to him resolve", async () => {
    await m.archiveMessage(CHAT, "wamid.CCC", "Gepetel", "am pus poll-ul");
    assert.deepEqual(await m.getArchivedMessage("wamid.CCC"), { from: "Gepetel", text: "am pus poll-ul" });
  });

  test("a very long message is truncated rather than stored whole", async () => {
    await m.archiveMessage(CHAT, "wamid.DDD", "Ana", "y".repeat(5000));
    const got = await m.getArchivedMessage("wamid.DDD");
    assert.equal(got.text.length, 2000);
  });

  test("nothing is stored without an id or without text", async () => {
    await m.archiveMessage(CHAT, "", "Ana", "ceva");
    await m.archiveMessage(CHAT, "wamid.EEE", "Ana", "");
    assert.equal(await db.collection("messagearchives").countDocuments({ chatId: CHAT }), 0);
  });
});

describe("poll results — answering 'who won' and 'did everyone vote'", { skip }, () => {
  const G = "120363000000000012@g.us";
  beforeEach(async () => {
    if (skip) return;
    await db.collection("polls").deleteMany({ chat_id: G });
    await m.setParticipants(G, ["40711111111", "40722222222", "40733333333", "40750271099"], "Poll Group");
    for (const [ph, nm] of [["40711111111","Ana"],["40722222222","Den"],["40733333333","Radu"]]) {
      await m.updatePeople({ phoneNumber: ph, name: nm });
    }
  });
  after(async () => {
    if (skip) return;
    await db.collection("polls").deleteMany({ chat_id: G });
    await db.collection("people").deleteMany({ phoneNumber: { $in: ["40722222222","40733333333"] } });
  });

  const makePoll = async () => {
    const p = await m.toolFunctions.create_poll({ chat_id: G, question: "Ce mancam?", options: ["Pizza", "Sushi"] });
    await m.setPollWaMessageId(p.poll_id, "wamid.POLL1");
    return p.poll_id;
  };

  test("a vote updates the tally, and the winner is readable", async () => {
    const id = await makePoll();
    await m.recordPollVotes("wamid.POLL1", { total: 3, results: [
      { name: "Pizza", count: 2, voters: ["40711111111", "40722222222"] },
      { name: "Sushi", count: 1, voters: ["40733333333"] } ] });
    const r = await m.toolFunctions.get_poll_results({ chat_id: G, poll_id: id });
    assert.deepEqual(r.leading_options, ["Pizza"]);
    assert.equal(r.total_votes, 3);
    assert.deepEqual(r.results[0].voters.sort(), ["Ana", "Den"]);
  });

  test("a tie reports both options rather than inventing a winner", async () => {
    const id = await makePoll();
    await m.recordPollVotes("wamid.POLL1", { total: 2, results: [
      { name: "Pizza", count: 1, voters: ["40711111111"] },
      { name: "Sushi", count: 1, voters: ["40722222222"] } ] });
    const r = await m.toolFunctions.get_poll_results({ chat_id: G, poll_id: id });
    assert.deepEqual(r.leading_options.sort(), ["Pizza", "Sushi"]);
  });

  test("'did everyone vote' — who is missing, excluding Gepetel himself", async () => {
    const id = await makePoll();
    await m.recordPollVotes("wamid.POLL1", { total: 1, results: [
      { name: "Pizza", count: 1, voters: ["40711111111"] }, { name: "Sushi", count: 0, voters: [] } ] });
    const r = await m.toolFunctions.get_poll_results({ chat_id: G, poll_id: id });
    assert.equal(r.group_size, 3);            // the bot is not a voter
    assert.equal(r.people_who_voted, 1);
    assert.equal(r.everyone_voted, false);
    assert.deepEqual(r.not_voted_names.sort(), ["Den", "Radu"]);
  });

  test("everyone_voted flips once the last person votes", async () => {
    const id = await makePoll();
    await m.recordPollVotes("wamid.POLL1", { total: 3, results: [
      { name: "Pizza", count: 3, voters: ["40711111111", "40722222222", "40733333333"] } ] });
    const r = await m.toolFunctions.get_poll_results({ chat_id: G, poll_id: id });
    assert.equal(r.everyone_voted, true);
    assert.deepEqual(r.not_voted_names, []);
  });

  test("a multi-select voter is counted once, not once per option", async () => {
    const id = await makePoll();
    await m.recordPollVotes("wamid.POLL1", { total: 2, results: [
      { name: "Pizza", count: 1, voters: ["40711111111"] },
      { name: "Sushi", count: 1, voters: ["40711111111"] } ] });
    const r = await m.toolFunctions.get_poll_results({ chat_id: G, poll_id: id });
    assert.equal(r.people_who_voted, 1, "one person picking two options is still one voter");
    assert.equal(r.total_votes, 2);
  });

  test("never returns a phone number", async () => {
    const id = await makePoll();
    await m.recordPollVotes("wamid.POLL1", { total: 1, results: [
      { name: "Pizza", count: 1, voters: ["40711111111"] } ] });
    const blob = JSON.stringify(await m.toolFunctions.get_poll_results({ chat_id: G, poll_id: id }));
    for (const ph of ["40711111111", "40722222222", "40733333333"]) {
      assert.equal(blob.includes(ph), false, `phone ${ph} must not appear`);
    }
  });

  test("a vote for an untracked poll is ignored, not an error", async () => {
    assert.equal(await m.recordPollVotes("wamid.UNKNOWN", { total: 1, results: [{ name: "x", count: 1 }] }), null);
  });
});

describe("conversation window", { skip }, () => {
  const C = "120363000000000021@g.us";
  beforeEach(async () => { if (!skip) await db.collection("messagearchives").deleteMany({ chatId: C }); });
  after(async () => { if (!skip) await db.collection("messagearchives").deleteMany({ chatId: C }); });

  test("returns the most recent N, oldest first", async () => {
    for (let i = 1; i <= 60; i++) {
      await m.archiveMessage(C, `id${String(i).padStart(3, "0")}`, "Ana", `msg ${i}`);
      // Distinct timestamps so ordering is deterministic.
      await db.collection("messagearchives").updateOne({ messageId: `id${String(i).padStart(3,"0")}` },
        { $set: { createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) } });
    }
    const w = await m.getRecentMessages(C, 50);
    assert.equal(w.length, 50);
    assert.equal(w[0].text, "msg 11", "should start at the 11th, dropping the oldest 10");
    assert.equal(w[49].text, "msg 60", "and end at the newest");
  });

  test("carries both sides of the conversation", async () => {
    await m.archiveMessage(C, "a1", "Ana", "salut");
    await m.archiveMessage(C, "a2", "Gepetel", "salut si tie");
    const w = await m.getRecentMessages(C, 50);
    assert.deepEqual(w.map(x => x.from), ["Ana", "Gepetel"]);
  });

  test("one enormous message can't crowd out the rest", async () => {
    await m.archiveMessage(C, "big", "Ana", "x".repeat(5000));
    const w = await m.getRecentMessages(C, 50);
    assert.equal(w[0].text.length, 500);
  });

  test("an empty chat gives an empty window, not an error", async () => {
    assert.deepEqual(await m.getRecentMessages("120363000000000099@g.us", 50), []);
  });
});
