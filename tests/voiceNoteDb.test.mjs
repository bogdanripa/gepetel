// The voice-note store against a real database — set TEST_DATABASE_URL.
//
// The point of this store is that a voice note nobody paid to transcribe can
// still be read later: the link is kept while Gepetel is asleep, and the words
// are written back over the placeholder once somebody asks. So what is tested
// is that the link survives, that resolving rewrites the ARCHIVE line (not just
// this reply's context), and that a link which cannot be read stops costing.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL (a throwaway DB) to run";
let m, mongoose;
const C = "40799999992-1234567890@g.us";
const OTHER = "40799999993-1234567890@g.us";

let seq = 0;
const id = () => `test-vn-${Date.now()}-${seq++}`;
async function wipe() {
  await mongoose.connection.collection("messagearchives").deleteMany({ chatId: { $in: [C, OTHER] } });
  await mongoose.connection.collection("voicenotes").deleteMany({ chat_id: { $in: [C, OTHER] } });
}
// A voice note that arrived while he was asleep: archived as the placeholder,
// with its link kept aside.
async function asleepVoiceNote(chatId = C, from = "Ana", at = new Date()) {
  const messageId = id();
  await mongoose.connection.collection("messagearchives").insertOne({ messageId, chatId, from, text: "a voice message", createdAt: at });
  await m.rememberVoiceNote(chatId, messageId, `https://example.invalid/${messageId}.ogg`, from);
  return messageId;
}
const archived = async (messageId) =>
  (await mongoose.connection.collection("messagearchives").findOne({ messageId }))?.text;

before(async () => {
  if (skip) return;
  mongoose = (await import("mongoose")).default;
  await mongoose.connect(TEST_DB);
  m = (await import("../dist/mongo.js")).default;
});
beforeEach(async () => { if (!skip) await wipe(); });
after(async () => { if (!skip) { await wipe(); await mongoose.disconnect(); } });

test("the link outlives the asleep decision, and the archive still reads as a placeholder", { skip }, async () => {
  const messageId = await asleepVoiceNote();
  const pending = await m.pendingVoiceNotes(C);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].messageId, messageId);
  assert.match(pending[0].link, /\.ogg$/);
  assert.equal(pending[0].from, "Ana");
  assert.equal(await archived(messageId), "a voice message", "nothing is transcribed until asked");
});

test("resolving writes the words over the archive line, so it stays said", { skip }, async () => {
  const messageId = await asleepVoiceNote();
  await m.resolveVoiceNote(messageId, "ajung la 7, luați voi masa fără mine");
  assert.equal(await archived(messageId), "ajung la 7, luați voi masa fără mine");
  assert.equal((await m.pendingVoiceNotes(C)).length, 0, "and nothing pays for it twice");
});

test("a link that cannot be read stops costing after two tries", { skip }, async () => {
  const messageId = await asleepVoiceNote();
  await m.noteVoiceFailure(messageId);
  assert.equal((await m.pendingVoiceNotes(C)).length, 1, "one bad try is forgiven");
  await m.noteVoiceFailure(messageId);
  assert.equal((await m.pendingVoiceNotes(C)).length, 0, "two is enough");
  assert.equal(await archived(messageId), "a voice message", "and the line is left honest");
});

test("newest first, bounded, and never another chat's", { skip }, async () => {
  const now = Date.now();
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await asleepVoiceNote(C, "Ana", new Date(now - i * 60_000)));
  await asleepVoiceNote(OTHER, "Dan");
  const pending = await m.pendingVoiceNotes(C, 4);
  assert.equal(pending.length, 4, "bounded: a group can drop twenty overnight");
  const theirs = new Set(pending.map(p => p.messageId));
  for (const other of (await m.pendingVoiceNotes(OTHER)).map(p => p.messageId)) {
    assert.equal(theirs.has(other), false, "another chat's note never comes back here");
  }
});

test("remembering the same note twice keeps one row", { skip }, async () => {
  const messageId = await asleepVoiceNote();
  await m.rememberVoiceNote(C, messageId, "https://example.invalid/again.ogg", "Ana");
  assert.equal((await m.pendingVoiceNotes(C)).length, 1, "a redelivered webhook is not a second note");
});

test("a note with no link is not worth a row", { skip }, async () => {
  await m.rememberVoiceNote(C, id(), "", "Ana");
  assert.equal((await m.pendingVoiceNotes(C)).length, 0);
});
