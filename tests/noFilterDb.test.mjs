// The "no filter" switch against a real database — set TEST_DATABASE_URL.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL (a throwaway DB) to run";
let m, mongoose;
const G = "40799999993-1700000000@g.us";
const ANA = "40799999993@s.whatsapp.net", DAN = "40799999994@s.whatsapp.net", STRANGER = "40799999995@s.whatsapp.net";

before(async () => {
  if (skip) return;
  mongoose = (await import("mongoose")).default;
  await mongoose.connect(TEST_DB);
  m = (await import("../dist/mongo.js")).default;
});
const wipe = () => mongoose.connection.collection("groups").deleteMany({ chatId: G });
beforeEach(async () => {
  if (skip) return;
  await wipe();
  await mongoose.connection.collection("groups").insertOne({ chatId: G, name: "Schi 2027", participants: [ANA, DAN], houseRules: [] });
});
after(async () => { if (!skip) { await wipe(); await mongoose.disconnect(); } });

const mine = async (who) => (await m.getGroupsByParticipant(who)).find(g => g.chatId === G);

test("off until someone switches it on", { skip }, async () => {
  assert.equal((await mine(ANA)).noFilter, false);
  assert.equal(!!(await m.getGroupByChatId(G)).noFilter, false);
});

test("any member can switch it on, and any other member can switch it off", { skip }, async () => {
  const on = await m.setGroupNoFilter(G, true, { requesterChatId: ANA });
  assert.deepEqual(on, { ok: true, group_name: "Schi 2027", on: true, was: false });
  assert.equal((await mine(DAN)).noFilter, true);
  assert.equal((await m.getGroupByChatId(G)).noFilter, true, "what the group's replies read");
  const off = await m.setGroupNoFilter(G, false, { requesterChatId: DAN });
  assert.deepEqual(off, { ok: true, group_name: "Schi 2027", on: false, was: true });
  assert.equal((await mine(ANA)).noFilter, false);
  const row = await mongoose.connection.collection("groups").findOne({ chatId: G });
  assert.equal(row.noFilterBy, "40799999994", "who flipped it last is kept");
  assert.ok(row.noFilterAt instanceof Date);
});

test("someone who isn't in the group can't, and nothing changes", { skip }, async () => {
  await assert.rejects(m.setGroupNoFilter(G, true, { requesterChatId: STRANGER }), /not a member/);
  await assert.rejects(m.setGroupNoFilter(G, true, {}), /no requester/);
  await assert.rejects(m.setGroupNoFilter("40799999993@s.whatsapp.net", true, { requesterChatId: ANA }), /group id/);
  assert.equal(!!(await m.getGroupByChatId(G)).noFilter, false);
});

test("it leaves the group's house rules alone", { skip }, async () => {
  await m.setHouseRule(G, "No emoji in this group.");
  await m.setGroupNoFilter(G, true, { requesterChatId: ANA });
  assert.deepEqual(await m.getHouseRules(G), ["No emoji in this group."]);
});
