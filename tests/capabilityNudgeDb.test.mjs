// Capability-nudge selection against a real database — set TEST_DATABASE_URL.
//
// What is actually under test is the set of refusals: this feature messages
// people who asked for nothing, so every guard matters more than the happy path.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL (a throwaway DB) to run";
let m, mongoose;
const C = "40799999991@s.whatsapp.net";
const DIGITS = "40799999991";
const GROUP = "40799999991-1234567890@g.us";

// Noon in Bucharest: inside outreach hours, so the hour guard never decides a
// test that is about something else.
const NOON = new Date("2026-11-02T10:00:00Z");
const hoursAgo = (h) => new Date(NOON.getTime() - h * 3600_000);

async function wipe() {
  for (const c of ["messagearchives", "capabilitynudges", "followups", "mcpconnectors", "usergrowths", "people"]) {
    await mongoose.connection.collection(c).deleteMany({ $or: [{ chat_id: { $in: [C, GROUP] } }, { chatId: { $in: [C, GROUP] } }, { phoneNumber: DIGITS }] });
  }
}
// Four of their own lines (the engagement floor), the newest carrying whatever
// `asked` says, and all of them well outside the quiet period.
async function conversation(asked = "am primit mailul de la Andrei?") {
  const rows = [
    { chatId: C, from: "Ana", text: asked, createdAt: hoursAgo(26) },
    { chatId: C, from: "Ana", text: "ok", createdAt: hoursAgo(27) },
    { chatId: C, from: "Ana", text: "mersi", createdAt: hoursAgo(28) },
    { chatId: C, from: "Ana", text: "salut", createdAt: hoursAgo(29) },
  ];
  await mongoose.connection.collection("messagearchives").insertMany(rows);
}
const claim = (opts = {}) => m.claimDueCapabilityNudges(NOON, { dryRun: true, ...opts });
const mine = async (opts) => (await claim(opts)).filter(x => x.chatId === C);

before(async () => {
  if (skip) return;
  mongoose = (await import("mongoose")).default;
  await mongoose.connect(TEST_DB);
  m = (await import("../dist/mongo.js")).default;
});
beforeEach(async () => { if (!skip) await wipe(); });
after(async () => { if (!skip) { await wipe(); await mongoose.disconnect(); } });

test("a line of theirs about mail, nothing connected: one nudge, carrying that line", { skip }, async () => {
  await conversation();
  const [got] = await mine();
  assert.ok(got, "expected a nudge");
  assert.equal(got.capability, "email");
  assert.match(got.evidence, /mailul de la Andrei/);
});

test("nothing they said points at mail or calendar: no nudge", { skip }, async () => {
  await conversation("ce vreme e mâine?");
  assert.equal((await mine()).length, 0);
});

test("their mail is already connected: no nudge about it", { skip }, async () => {
  await conversation();
  await mongoose.connection.collection("mcpconnectors").insertOne({
    chat_id: C, connector_id: `test-${Date.now()}`, label: "Gmail", server_label: "gmail",
    server_host: "mcp.gmail.com", tool_names: ["search_threads"], active: true,
  });
  assert.equal((await mine()).length, 0);
});

test("already nudged about mail: never a second one", { skip }, async () => {
  await conversation();
  await mongoose.connection.collection("capabilitynudges").insertOne({ chat_id: C, capability: "email", sent_at: hoursAgo(24 * 30), evidence: "x" });
  assert.equal((await mine()).length, 0, "the row is permanent, cooldown or not");
});

test("a calendar line while mail was nudged recently: held by the cooldown", { skip }, async () => {
  await conversation("ce am joi in calendar?");
  await mongoose.connection.collection("capabilitynudges").insertOne({ chat_id: C, capability: "email", sent_at: hoursAgo(24), evidence: "x" });
  assert.equal((await mine()).length, 0, "two unprompted messages inside a fortnight");
});

test("they asked to be left alone: nothing, ever", { skip }, async () => {
  await conversation();
  await mongoose.connection.collection("usergrowths").insertOne({ phoneNumber: DIGITS, outreachOptOut: true });
  assert.equal((await mine()).length, 0);
});

test("a follow-up is owed: that comes first", { skip }, async () => {
  await conversation();
  await mongoose.connection.collection("followups").insertOne({ chat_id: C, due_at: hoursAgo(1), about: "x", sent_at: null, answered: false });
  assert.equal((await mine()).length, 0);
});

test("mid-conversation: not the moment", { skip }, async () => {
  await conversation();
  await mongoose.connection.collection("messagearchives").insertOne({ chatId: C, from: "Ana", text: "si inca ceva", createdAt: new Date(NOON.getTime() - 5 * 60_000) });
  assert.equal((await mine()).length, 0);
});

test("right after something of his: not on top of his own words", { skip }, async () => {
  await conversation();
  await mongoose.connection.collection("messagearchives").insertOne({ chatId: C, from: "Gepetel", text: "uite ce am gasit", createdAt: hoursAgo(2) });
  assert.equal((await mine()).length, 0);
});

test("a drive-by chat: too little of theirs to nudge", { skip }, async () => {
  await mongoose.connection.collection("messagearchives").insertMany([
    { chatId: C, from: "Ana", text: "am primit mailul?", createdAt: hoursAgo(26) },
    { chatId: C, from: "Ana", text: "salut", createdAt: hoursAgo(27) },
  ]);
  assert.equal((await mine()).length, 0);
});

test("a group is never nudged", { skip }, async () => {
  await mongoose.connection.collection("messagearchives").insertMany([
    { chatId: GROUP, from: "Ana", text: "am primit mailul de la Andrei?", createdAt: hoursAgo(26) },
    { chatId: GROUP, from: "Ana", text: "ok", createdAt: hoursAgo(27) },
    { chatId: GROUP, from: "Ana", text: "mersi", createdAt: hoursAgo(28) },
    { chatId: GROUP, from: "Ana", text: "salut", createdAt: hoursAgo(29) },
  ]);
  assert.equal((await claim()).filter(x => x.chatId === GROUP).length, 0);
});

test("a screenshot description is his words about their picture, not their ask", { skip }, async () => {
  await conversation("Screenshot: a Gmail inbox showing 3 unread mails");
  assert.equal((await mine()).length, 0);
});

test("the real claim writes the row once and never offers it again", { skip }, async () => {
  await conversation();
  const first = (await m.claimDueCapabilityNudges(NOON)).filter(x => x.chatId === C);
  assert.equal(first.length, 1, "expected one real claim");
  const again = (await m.claimDueCapabilityNudges(NOON)).filter(x => x.chatId === C);
  assert.equal(again.length, 0, "the claimed row blocks a repeat");
  assert.equal(await mongoose.connection.collection("capabilitynudges").countDocuments({ chat_id: C }), 1);
});
