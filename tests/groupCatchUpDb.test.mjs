// A group's recent messages for a catch-up asked in a 1:1 (2026-10-25): only a
// member gets them — set TEST_DATABASE_URL.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL (a throwaway DB) to run";
let m, mongoose;
const G = "120363999999999999@g.us";

before(async () => {
  if (skip) return;
  process.env.GEPETEL_DATABASE_URL = TEST_DB;
  mongoose = (await import("mongoose")).default;
  m = (await import("../dist/mongo.js")).default;
  await new Promise(r => setTimeout(r, 500));
  const db = mongoose.connection.db;
  await db.collection("groups").deleteMany({ chatId: G });
  await db.collection("messagearchives").deleteMany({ chatId: G });
  await db.collection("groups").insertOne({ chatId: G, name: "Vila 18", participants: ["40711111111@s.whatsapp.net", "40722222222"] });
  const old = new Date(Date.now() - 5 * 86400e3), recent = new Date(Date.now() - 3600e3);
  await db.collection("messagearchives").insertMany([
    { messageId: "t1", chatId: G, from: "Ana", text: "old news", createdAt: old },
    { messageId: "t2", chatId: G, from: "Ana", text: "@Bogdan can you bring the grill on Saturday?", createdAt: recent },
  ]);
});
after(async () => { if (!skip) { await mongoose.connection.db.collection("groups").deleteMany({ chatId: G }); await mongoose.connection.db.collection("messagearchives").deleteMany({ chatId: G }); await mongoose.disconnect(); } });

test("a member gets the group's messages since the time asked; a non-member gets nothing", { skip }, async () => {
  const r = await m.groupMessagesSince(G, new Date(Date.now() - 48 * 3600e3), "40711111111@s.whatsapp.net");
  assert.equal(r.group_name, "Vila 18");
  assert.deepEqual(r.messages.map(x => x.text), ["@Bogdan can you bring the grill on Saturday?"]);
  await assert.rejects(m.groupMessagesSince(G, new Date(0), "40799999999@s.whatsapp.net"), /not a member/);
  await assert.rejects(m.groupMessagesSince("40711111111@s.whatsapp.net", new Date(0), "40711111111@s.whatsapp.net"), /isn't one of their groups/);
});
