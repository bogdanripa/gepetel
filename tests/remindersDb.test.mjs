// GEP-114 acceptance criteria against a real database: the list form of DM
// set_reminder, through the handler (reminderList.setReminderList) with the
// same mongo functions oai.ts wires into it. Needs a throwaway database: set
// TEST_DATABASE_URL.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL (a throwaway DB) to run";
let m, u, rl, mongoose, reminders;
const CHAT = "40799999114@s.whatsapp.net";
const OTHER = "40799999115@s.whatsapp.net";
const TZ = "Europe/Bucharest";

// 22 activities over a two-week window that is always in the future.
const base = new Date(Date.now() + 2 * 86400_000);
const ymd = d => d.toISOString().slice(0, 10);
const schedule = () => Array.from({ length: 22 }, (_, k) => ({
  what: `Activitatea ${k + 1}`,
  at: `${ymd(new Date(base.getTime() + Math.floor(k * 14 / 22) * 86400_000))} ${String(9 + (k % 8)).padStart(2, "0")}:30`,
}));
const withThreeBad = () => {
  const s = schedule();
  s[3] = { what: "Ieri", at: `${ymd(new Date(Date.now() - 86400_000))} 10:00` };
  s[10] = { what: "Anul trecut", at: "2025-11-19 10:00" };
  s[15] = { what: "Fără oră", at: "vineri după-amiază" };
  return s;
};

before(async () => {
  if (skip) return;
  process.env.GEPETEL_DATABASE_URL = TEST_DB;
  mongoose = (await import("mongoose")).default;
  m = (await import("../dist/mongo.js")).default;
  u = (await import("../dist/util.js")).default;
  rl = (await import("../dist/reminderList.js")).default;
  await new Promise(r => setTimeout(r, 500));
  reminders = mongoose.connection.db.collection("reminders");
});
const clean = async () => { await reminders.deleteMany({ chat_id: { $in: [CHAT, OTHER] } }); };
beforeEach(async () => { if (!skip) await clean(); });
after(async () => { if (!skip) { await clean(); await mongoose.disconnect(); } });

// Exactly what oai.ts passes.
const deps = () => ({
  pending: id => m.pendingReminders(id),
  create: r => m.toolFunctions.create_reminder(r),
  canCall: async () => ({ called: false, why: "phone calls are off" }),
});
const run = async asks => {
  const setNow = [], skippedNow = [];
  const r = await rl.setReminderList(asks, { chatId: CHAT, timezone: TZ, setNow, skippedNow }, deps());
  return { r, setNow, skippedNow };
};
const rows = () => reminders.find({ chat_id: CHAT }).sort({ due_date: 1 }).toArray();

test("one call with 22 items → 22 rows for that chat, at their local times", { skip }, async () => {
  const { r } = await run(schedule());
  assert.equal(r.created, 22);
  const got = await rows();
  assert.equal(got.length, 22);
  const want = schedule().map(s => u.localTimeToDate(s.at, TZ).getTime()).sort((a, b) => a - b);
  assert.deepEqual(got.map(x => x.due_date.getTime()), want);
  // Checked on their clock, not UTC: every row reads HH:30 in Bucharest.
  for (const x of got) assert.match(rl.localStamp(x.due_date, TZ), / (09|1\d):30$/);
  assert.ok(got.every(x => x.is_individual === false && x.by_call === false && x.reminder_id === String(x._id)));
});

test("22 items with 2 past + 1 unparseable → 19 rows, and the 3 named with why", { skip }, async () => {
  const { r, skippedNow } = await run(withThreeBad());
  assert.equal((await rows()).length, 19);
  assert.equal(r.set, 19);
  assert.equal(r.skipped_count, 3);
  assert.deepEqual(r.results.filter(x => x.status === "skipped").map(x => [x.i, x.what, x.reason]),
    [[3, "Ieri", "in_past"], [10, "Anul trecut", "in_past"], [15, "Fără oră", "time_unparsed"]]);
  assert.equal(skippedNow.length, 3);
});

test("the same 22 again → no new rows for the 19 pending, the missing ones created", { skip }, async () => {
  await run(withThreeBad());
  const before19 = (await rows()).map(x => String(x._id)).sort();
  // Same 22, the three now fixed (a later day, a clear time).
  const fixed = withThreeBad();
  fixed[3] = { what: "Ieri", at: `${ymd(base)} 18:00` };
  fixed[10] = { what: "Anul trecut", at: `${ymd(base)} 19:00` };
  fixed[15] = { what: "Fără oră", at: `${ymd(base)} 20:00` };
  const { r, setNow } = await run(fixed);
  assert.equal(r.created, 3);
  assert.equal(r.already_set, 19);
  assert.equal(r.set, 22);
  const after = await rows();
  assert.equal(after.length, 22);
  for (const id of before19) assert.ok(after.some(x => String(x._id) === id), "the 19 kept their rows");
  assert.equal(setNow.filter(s => s.already).length, 19);
  // A third identical run creates nothing at all.
  const { r: r3 } = await run(fixed);
  assert.equal(r3.created, 0);
  assert.equal((await rows()).length, 22);
});

test("dedup is per chat: another chat's identical reminders don't count", { skip }, async () => {
  await rl.setReminderList(schedule(), { chatId: OTHER, timezone: TZ, setNow: [], skippedNow: [] }, deps());
  const { r } = await run(schedule());
  assert.equal(r.created, 22);
});

test("pendingReminders has no 50 cap; listReminders still does", { skip }, async () => {
  const asks = Array.from({ length: 50 }, (_, k) => ({ what: `x${k}`, at: `${ymd(base)} ${10 + Math.floor(k / 60)}:${String(k % 60).padStart(2, "0")}` }));
  await run(asks);
  await run(asks.map(a => ({ ...a, what: `y${a.what}` })));
  assert.equal((await m.pendingReminders(CHAT)).length, 100);
  assert.equal((await m.listReminders(CHAT)).length, 50);
  // Row 51+ is still seen as already set.
  const { r } = await run(asks.map(a => ({ ...a, what: `y${a.what}` })));
  assert.equal(r.created, 0);
  assert.equal(r.already_set, 50);
});

test("the single form is not the list form, and its row is as today", { skip }, async () => {
  // oai.ts runs the list handler only when listAsks returns a list; a call
  // with what/at and no items takes the untouched single-form branch.
  assert.equal(rl.listAsks({ what: "Dentist", at: `${ymd(base)} 10:00` }), null);
  assert.equal(rl.listAsks({ what: "Dentist", at: `${ymd(base)} 10:00`, items: [] }), null);
  // That branch writes through create_reminder exactly as before, with no dedup.
  const when = u.localTimeToDate(`${ymd(base)} 10:00`, TZ);
  const args = { chat_id: CHAT, title: "Dentist", due_date: when, is_individual: false, phone_number: null, by_call: false };
  const a = await m.toolFunctions.create_reminder(args);
  const b = await m.toolFunctions.create_reminder(args);
  assert.notEqual(a.reminder_id, b.reminder_id);
  const got = await rows();
  assert.equal(got.length, 2);
  assert.equal(got[0].title, "Dentist");
  assert.equal(got[0].due_date.getTime(), when.getTime());
  assert.equal(got[0].is_individual, false);
  assert.equal(got[0].by_call, false);
  assert.equal(got[0].reminder_id, String(got[0]._id));
});
