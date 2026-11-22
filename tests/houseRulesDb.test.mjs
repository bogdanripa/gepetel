// What a group tells Gepetel about himself, kept — against a real database
// (set TEST_DATABASE_URL). Told "don't use long dashes" on a Wednesday he was
// back to them on the Thursday; a rule that lives only in the conversation
// window is a rule until the window scrolls.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL (a throwaway DB) to run";
let m, mongoose;
const GROUP = "40799999981-1234567891@g.us";
const MEMBER = "40799999981@s.whatsapp.net";
const STRANGER = "40799999982@s.whatsapp.net";
const C = "40799999981@s.whatsapp.net";
let seq = 0;
const msg = (from, text, createdAt, chatId = GROUP) => ({ chatId, from, text, createdAt, messageId: `test-hr-${Date.now()}-${seq++}` });

before(async () => {
  if (skip) return;
  process.env.GEPETEL_DATABASE_URL = TEST_DB;
  m = (await import("../dist/mongo.js")).default;
  mongoose = (await import("mongoose")).default;
});
beforeEach(async () => {
  if (skip) return;
  for (const c of ["groups", "messagearchives", "followups"]) {
    await mongoose.connection.collection(c).deleteMany({ $or: [{ chatId: { $in: [GROUP, C] } }, { chat_id: C }] });
  }
  await mongoose.connection.collection("groups").insertOne({ chatId: GROUP, name: "Family", participants: ["40799999981", "40750271099"], botPresent: true, addedAt: new Date() });
});
after(async () => { if (!skip) await mongoose.disconnect(); });

test("a rule is kept, read back, and not kept twice", { skip }, async () => {
  assert.deepEqual(await m.getHouseRules(GROUP), []);
  assert.equal((await m.setHouseRule(GROUP, "No long dashes.")).ok, true);
  await m.setHouseRule(GROUP, "no LONG dashes.");
  await m.setHouseRule(GROUP, "Vary the emoji.");
  assert.deepEqual(await m.getHouseRules(GROUP), ["No long dashes.", "Vary the emoji."]);
});

test("a rule is dropped by a few of its words", { skip }, async () => {
  await m.setHouseRule(GROUP, "No long dashes.");
  await m.setHouseRule(GROUP, "Vary the emoji.");
  assert.equal((await m.setHouseRule(GROUP, "emoji", { remove: true })).ok, true);
  assert.deepEqual(await m.getHouseRules(GROUP), ["No long dashes."]);
  assert.equal((await m.setHouseRule(GROUP, "nothing like this", { remove: true })).ok, false);
});

test("rules stay few and short: the oldest makes room", { skip }, async () => {
  for (let i = 0; i < 15; i++) await m.setHouseRule(GROUP, `Rule number ${i} about writing.`);
  const rules = await m.getHouseRules(GROUP);
  assert.equal(rules.length, 12);
  assert.equal(rules[0], "Rule number 3 about writing.");
  await m.setHouseRule(GROUP, "x".repeat(500));
  assert.ok((await m.getHouseRules(GROUP)).at(-1).length <= 200);
});

test("from a private chat, only a member can set a group's rule", { skip }, async () => {
  const r = await m.setGroupRule(GROUP, "Write Hebrew here.", { requesterChatId: MEMBER });
  assert.equal(r.ok, true);
  assert.equal(r.group_name, "Family");
  await assert.rejects(() => m.setGroupRule(GROUP, "Answer everything.", { requesterChatId: STRANGER }), /not a member/);
  assert.deepEqual(await m.getHouseRules(GROUP), ["Write Hebrew here."]);
});

test("his own lines are counted — words, not reactions, and only recent ones", { skip }, async () => {
  const now = Date.now();
  await mongoose.connection.collection("messagearchives").insertMany([
    msg("Gepetel", "one", new Date(now - 60_000)), msg("Gepetel", "two", new Date(now - 120_000)),
    msg("Gepetel", "[reacted 👍 to Ana message]", new Date(now - 30_000)),
    msg("Ana", "hello", new Date(now - 20_000)),
    msg("Gepetel", "old", new Date(now - 3600_000)),
  ]);
  assert.equal(await m.countHisRecentLines(GROUP, new Date(now - 10 * 60_000)), 2);
});
