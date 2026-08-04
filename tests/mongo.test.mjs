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
