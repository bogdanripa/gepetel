// Pulse at night, against a real database — set TEST_DATABASE_URL.
// Outside waking hours it looks only for someone who was on WhatsApp in the
// last half hour (the owner, 2026-11-09: up at 6, an update by 6:15).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL (a throwaway DB) to run";
let pulse, mongoose;
const C = "40799999994@s.whatsapp.net";            // Romania: Europe/Bucharest
const night = new Date("2026-11-10T04:00:00Z");       // 06:00 in Bucharest
const wipe = () => mongoose.connection.collection("pulsestates").deleteMany({ chat_id: C });

before(async () => {
  if (skip) return;
  mongoose = (await import("mongoose")).default;
  await mongoose.connect(TEST_DB);
  pulse = await import("../dist/pulse.js");
  await wipe();
});
after(async () => { if (!skip) { await wipe(); await mongoose.disconnect(); } });

test("at night: asleep unless they were on WhatsApp in the last half hour", { skip }, async () => {
  assert.equal(await pulse.pulseFor(C, night), "asleep");
  await mongoose.connection.collection("pulsestates").updateOne({ chat_id: C }, { $set: { active_at: new Date(night.getTime() - 40 * 60_000) } });
  assert.equal(await pulse.pulseFor(C, night), "asleep");
  await pulse.sawOnline(C, night.getTime() - 5 * 60_000, night);
  assert.match(await pulse.pulseFor(C, night), /^quiet/);       // up: it looks (nothing connected, so nothing found)
});
