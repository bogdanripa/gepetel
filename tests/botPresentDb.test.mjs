// GEP-92: botPresent goes back to true whenever Gepetel is evidently in a group —
// a roster that contains him, or a group send that went through. Needs a
// throwaway database: set TEST_DATABASE_URL.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL (a throwaway DB) to run";
let m, u, say, whapi, mongoose, groups;
const G = "120363888888888888@g.us";
const UNKNOWN = "120363777777777777@g.us";
const M1 = "40711111111@s.whatsapp.net";

before(async () => {
  if (skip) return;
  process.env.GEPETEL_DATABASE_URL = TEST_DB;
  delete process.env.WA_PROVIDER;   // whapi, whose send we stub below
  mongoose = (await import("mongoose")).default;
  m = (await import("../dist/mongo.js")).default;
  u = (await import("../dist/util.js")).default;
  say = (await import("../dist/say.js")).default;
  whapi = (await import("../dist/whapi.js")).default;
  await new Promise(r => setTimeout(r, 500));
  groups = mongoose.connection.db.collection("groups");
});
const clean = async () => {
  const db = mongoose.connection.db;
  for (const c of ["groups", "messagearchives"]) await db.collection(c).deleteMany({ chatId: { $in: [G, UNKNOWN] } });
};
beforeEach(async () => { if (skip) return; await clean(); await groups.insertOne({ chatId: G, name: "Test", participants: [M1], botPresent: false }); });
after(async () => { if (!skip) { await clean(); await mongoose.disconnect(); } });
const flag = async () => (await groups.findOne({ chatId: G })).botPresent;

test("setParticipants with the bot in the roster sets false → true", { skip }, async () => {
  await m.setParticipants(G, [M1, `${u.BOT_PHONE_DIGITS[0]}@s.whatsapp.net`], "Test");
  assert.equal(await flag(), true);
});

test("setParticipants without the bot leaves false as false", { skip }, async () => {
  await m.setParticipants(G, [M1, "40722222222@s.whatsapp.net"], "Test");
  assert.equal(await flag(), false);
});

test("confirmBotPresent flips once, is a no-op after, never creates a row", { skip }, async () => {
  assert.equal(await m.confirmBotPresent(G, "test"), true);
  assert.equal(await flag(), true);
  assert.equal(await m.confirmBotPresent(G, "test"), false);
  assert.equal(await m.confirmBotPresent(UNKNOWN, "test"), false);
  assert.equal(await groups.findOne({ chatId: UNKNOWN }), null);
});

test("a successful group send restores the flag; a failed one does not", { skip }, async () => {
  const orig = whapi.sendWhatsAppMessage;
  try {
    whapi.sendWhatsAppMessage = async () => null;
    assert.equal(await say.sayAndRemember(G, "hello"), false);
    assert.equal(await flag(), false);
    whapi.sendWhatsAppMessage = async () => "msg-1";
    assert.equal(await say.sayAndRemember(G, "hello", { openWindow: false }), true);
    assert.equal(await flag(), true);
  } finally { whapi.sendWhatsAppMessage = orig; }
});

test("a successful group image restores the flag; a failed one does not", { skip }, async () => {
  const orig = whapi.sendWhatsAppImage;
  try {
    whapi.sendWhatsAppImage = async () => null;
    assert.equal(await say.showAndRemember(G, "https://example.invalid/x.png", "cap"), false);
    assert.equal(await flag(), false);
    whapi.sendWhatsAppImage = async () => "img-1";
    assert.equal(await say.showAndRemember(G, "https://example.invalid/x.png", "cap"), true);
    assert.equal(await flag(), true);
  } finally { whapi.sendWhatsAppImage = orig; }
});
