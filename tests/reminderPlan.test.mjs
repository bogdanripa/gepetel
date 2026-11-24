// GEP-114: one set_reminder call carries a whole schedule. The plan is pure
// (util.planReminders); the handler around it (reminderList.setReminderList)
// is exercised here with in-memory deps — the database version is
// remindersDb.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import u from "../dist/util.js";
import rl from "../dist/reminderList.js";

const TZ = "Europe/Bucharest";
const NOW = new Date("2026-11-19T10:00:00Z");   // 12:00 in Bucharest
// 22 activities, 20 Nov – 5 Dec, one per day-ish, at clear times.
const schedule = (n = 22) => Array.from({ length: n }, (_, k) => {
  const d = new Date(Date.UTC(2026, 10, 20 + Math.floor(k * 16 / n)));
  const ymd = d.toISOString().slice(0, 10);
  return { what: `Activitatea ${k + 1}`, at: `${ymd} ${String(9 + (k % 8)).padStart(2, "0")}:00` };
});

test("22 good items → 22 to create, nothing skipped, in order", () => {
  const p = u.planReminders(schedule(), { timezone: TZ, now: NOW, pending: [] });
  assert.equal(p.create.length, 22);
  assert.equal(p.skipped.length, 0);
  assert.equal(p.already.length, 0);
  assert.deepEqual(p.create.map(c => c.i), [...Array(22).keys()]);
  // Their clock: 2026-11-20 09:00 in Bucharest is 07:00Z.
  assert.equal(p.create[0].at.toISOString(), "2026-11-20T07:00:00.000Z");
});

test("2 past + 1 unparseable of 22 → 19 to create, 3 skipped with index and reason", () => {
  const asks = schedule();
  asks[3] = { what: "Ieri", at: "2026-11-18 10:00" };
  asks[10] = { what: "Acum", at: "2026-11-19 12:00" };          // now, not 60s ahead
  asks[15] = { what: "Fără oră", at: "vineri după-amiază" };
  const p = u.planReminders(asks, { timezone: TZ, now: NOW, pending: [] });
  assert.equal(p.create.length, 19);
  assert.deepEqual(p.skipped.map(s => [s.i, s.reason]), [[3, "in_past"], [10, "in_past"], [15, "time_unparsed"]]);
  assert.equal(p.skipped[2].at, "vineri după-amiază", "the time as given, so it can be asked about");
});

test("60 items → 50 planned, 10 over_limit — never cut silently", () => {
  const asks = Array.from({ length: 60 }, (_, k) => ({ what: `x${k}`, at: `2026-12-01 ${10 + Math.floor(k / 60)}:${String(k % 60).padStart(2, "0")}` }));
  const p = u.planReminders(asks, { timezone: TZ, now: NOW, pending: [] });
  assert.equal(p.create.length, 50);
  assert.equal(p.skipped.filter(s => s.reason === "over_limit").length, 10);
  assert.deepEqual(p.skipped.filter(s => s.reason === "over_limit").map(s => s.i), [50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
});

test("empty text → no_text; a non-object item does not throw", () => {
  const p = u.planReminders([{ what: "  ", at: "2026-12-01 10:00" }, null, "nope"], { timezone: TZ, now: NOW, pending: [] });
  assert.deepEqual(p.skipped.map(s => s.reason), ["no_text", "no_text", "no_text"]);
});

test("a pending reminder with the same minute and folded text is already set, not a new row", () => {
  const pending = [{ reminder_id: "r1", title: "Înot  Ana.", due_date: new Date("2026-11-20T13:00:00Z") }];
  const p = u.planReminders([
    { what: "inot ana", at: "2026-11-20 15:00", by_call: true },   // by_call differs: still the same reminder
    { what: "Pian Ana", at: "2026-11-20 15:00" },                   // same hour, different activity
  ], { timezone: TZ, now: NOW, pending });
  assert.deepEqual(p.already.map(a => [a.i, a.reminder_id]), [[0, "r1"]]);
  assert.deepEqual(p.create.map(c => c.what), ["Pian Ana"]);
});

test("the same item twice in one call → one create, one already", () => {
  const p = u.planReminders([{ what: "Tenis", at: "2026-11-21 10:00" }, { what: "tenis ", at: "2026-11-21 10:00" }], { timezone: TZ, now: NOW, pending: [] });
  assert.equal(p.create.length, 1);
  assert.deepEqual(p.already.map(a => [a.i, a.reminder_id]), [[1, "item:0"]]);
});

test("foldReminderText: case, diacritics, whitespace, trailing punctuation", () => {
  assert.equal(u.foldReminderText("  Înot   Ana!. "), "inot ana");
  assert.equal(u.foldReminderText("Școală"), "scoala");
  assert.notEqual(u.foldReminderText("Înot Ana"), u.foldReminderText("Înot Maria"));
});

// ---- the handler, with in-memory deps ----
const memDeps = (rows = [], over = {}) => {
  let n = 0, calls = 0;
  return {
    rows, get canCallCalls() { return calls; },
    pending: async id => rows.filter(r => r.chat_id === id && new Date(r.due_date) > NOW),
    create: async r => { const row = { ...r, reminder_id: `id${++n}` }; rows.push(row); return row; },
    canCall: async () => { calls++; return { called: false, why: "phone calls are off" }; },
    now: () => NOW,
    ...over,
  };
};

test("listAsks: only a non-empty items array is the list form; what/at join as the first item", () => {
  assert.equal(rl.listAsks({ what: "a", at: "2026-12-01 10:00" }), null);
  assert.equal(rl.listAsks({ what: "a", at: "x", items: [] }), null);
  assert.deepEqual(rl.listAsks({ items: [{ what: "b" }] }), [{ what: "b" }]);
  assert.deepEqual(rl.listAsks({ what: "a", at: "t", items: [{ what: "b" }] }).map(x => x.what), ["a", "b"]);
});

test("setReminderList: 19 + 3 skipped, the result shape and setNow/skippedNow", async () => {
  const asks = schedule();
  asks[3] = { what: "Ieri", at: "2026-11-18 10:00" };
  asks[10] = { what: "Acum", at: "2026-11-19 12:00" };
  asks[15] = { what: "Fără oră", at: "vineri" };
  const deps = memDeps(), setNow = [], skippedNow = [];
  const r = await rl.setReminderList(asks, { chatId: "c1", timezone: TZ, setNow, skippedNow }, deps);
  assert.equal(r.set, 19); assert.equal(r.created, 19); assert.equal(r.already_set, 0); assert.equal(r.skipped_count, 3);
  assert.equal(r.first, "2026-11-20 09:00");
  assert.match(r.last, /^2026-12-05 \d\d:00$/);
  assert.equal(r.results.length, 22);
  assert.deepEqual(r.results.map(x => x.i), [...Array(22).keys()], "one result per item, by index");
  assert.deepEqual(r.results.filter(x => x.status === "skipped").map(x => x.reason), ["in_past", "in_past", "time_unparsed"]);
  assert.equal(setNow.length, 19);
  assert.deepEqual(skippedNow.map(s => s.reason), ["in_past", "in_past", "time_unparsed"]);
  assert.match(r.tell_the_user, /count \(19\)/);
  assert.match(r.tell_the_user, /Do NOT say all\/toate\/every one — 3 were not set/);
  assert.equal(deps.canCallCalls, 0, "no call asked for, no call checked");
});

test("setReminderList: a rerun creates only what is missing", async () => {
  const deps = memDeps();
  const partial = schedule().slice(0, 6);
  await rl.setReminderList(partial, { chatId: "c1", timezone: TZ, setNow: [], skippedNow: [] }, deps);
  const setNow = [];
  const r = await rl.setReminderList(schedule(), { chatId: "c1", timezone: TZ, setNow, skippedNow: [] }, deps);
  assert.equal(r.created, 16); assert.equal(r.already_set, 6); assert.equal(r.set, 22);
  assert.equal(deps.rows.length, 22);
  assert.equal(setNow.filter(s => s.already).length, 6);
  assert.doesNotMatch(r.tell_the_user, /Do NOT say all/, "nothing skipped: no warning");
});

test("setReminderList: one save that throws is a skip, the rest are set", async () => {
  const deps = memDeps();
  const create = deps.create;
  deps.create = async r => { if (r.title === "Activitatea 5") throw new Error("boom"); return create(r); };
  const skippedNow = [];
  const r = await rl.setReminderList(schedule(), { chatId: "c1", timezone: TZ, setNow: [], skippedNow }, deps);
  assert.equal(r.created, 21);
  assert.deepEqual(r.results.find(x => x.i === 4), { i: 4, status: "skipped", reason: "not_saved", what: "Activitatea 5", at: r.results.find(x => x.i === 4).at });
  assert.deepEqual(skippedNow.map(s => s.reason), ["not_saved"]);
});

test("setReminderList: by_call checked once for the whole call, verdict per item", async () => {
  const deps = memDeps();
  const asks = [{ what: "a", at: "2026-11-21 10:00", by_call: true }, { what: "b", at: "2026-11-22 10:00", by_call: true }, { what: "c", at: "2026-11-23 10:00" }];
  const r = await rl.setReminderList(asks, { chatId: "c1", timezone: TZ, setNow: [], skippedNow: [] }, deps);
  assert.equal(deps.canCallCalls, 1);
  assert.equal(r.results[0].by_call, false);
  assert.match(r.results[0].call, /You can NOT phone them \(phone calls are off\)/);
  assert.equal(r.results[2].by_call, undefined);
  assert.equal(deps.rows.every(x => x.by_call === false), true);

  const yes = memDeps([], { canCall: async () => ({ called: true }) }), setNow = [];
  const r2 = await rl.setReminderList(asks.slice(0, 1), { chatId: "c2", timezone: TZ, setNow, skippedNow: [] }, yes);
  assert.equal(r2.results[0].by_call, true);
  assert.equal(yes.rows[0].by_call, true);
  assert.match(setNow[0].what, /^📞 a$/);
});

test("the DM tool schema: items with no maxItems, nothing required, single-form fields kept", async () => {
  process.env.OPENAI_API_KEY ||= "test-not-a-key";
  const kit = (await import("../dist/oai.js")).replayKit();
  const set = kit.dm.find(t => t.name === "set_reminder");
  assert.deepEqual(set.parameters.required, []);
  assert.equal(set.parameters.properties.items.type, "array");
  assert.equal(set.parameters.properties.items.maxItems, undefined);
  assert.match(set.parameters.properties.items.description, /ONE call\. Up to 50/);
  for (const k of ["what", "at", "by_call"]) assert.ok(set.parameters.properties[k]);
});
