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
  for (const c of ["groups", "reminders", "polls", "memories", "messages"]) {
    await db.collection(c).deleteMany({ $or: [{ chatId: GID }, { chat_id: GID }] });
  }
}
beforeEach(async () => { if (!skip) await cleanup(); });

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
