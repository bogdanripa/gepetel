// Call time and call plans (voiceMinutes.ts, voice.ts): the parts that
// decide and count, with no call, no socket and no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "../dist/voiceMinutes.js";
import v from "../dist/voice.js";

test("day: the free minutes belong to the Bucharest day, not UTC's", () => {
  // 22:30 UTC on the 17th is already the 18th in Bucharest (UTC+2 in November).
  assert.equal(vm.bucharestDay(new Date("2026-11-17T22:30:00Z")), "2026-11-18");
  assert.equal(vm.bucharestDay(new Date("2026-11-17T21:59:00Z")), "2026-11-17");
  // Summer time (UTC+3).
  assert.equal(vm.bucharestDay(new Date("2026-07-01T21:30:00Z")), "2026-07-02");
});

test("minutes: 5 a day by default, the extension adds to every day, yesterday's use doesn't count", () => {
  assert.equal(vm.freeMinutes({}), 5);
  assert.equal(vm.freeMinutes({ VOICE_FREE_MINUTES: "10" }), 10);
  assert.equal(vm.freeMinutes({ VOICE_FREE_MINUTES: "0" }), 0);
  assert.equal(vm.freeMinutes({ VOICE_FREE_MINUTES: "nonsense" }), 5);
  assert.equal(vm.remainingSeconds(null, "2026-11-17", 5), 300);
  assert.equal(vm.remainingSeconds({ day: "2026-11-17", usedSeconds: 200 }, "2026-11-17", 5), 100);
  assert.equal(vm.remainingSeconds({ day: "2026-11-17", usedSeconds: 400 }, "2026-11-17", 5), 0);
  assert.equal(vm.remainingSeconds({ day: "2026-11-16", usedSeconds: 400 }, "2026-11-17", 5), 300);
  assert.equal(vm.remainingSeconds({ day: "2026-11-17", usedSeconds: 400, extraMinutes: 30 }, "2026-11-17", 5), 35 * 60 - 400);
});

test("plan: their own daily minutes replace the default, the extension adds on top, null means the default", () => {
  assert.equal(vm.remainingSeconds({ dailyMinutes: 120 }, "2026-11-17", 5), 120 * 60);
  assert.equal(vm.remainingSeconds({ dailyMinutes: null }, "2026-11-17", 5), 300);
  assert.equal(vm.remainingSeconds({ dailyMinutes: 0 }, "2026-11-17", 5), 0);
  assert.equal(vm.remainingSeconds({ dailyMinutes: 120, extraMinutes: 15, day: "2026-11-17", usedSeconds: 600 }, "2026-11-17", 5), 135 * 60 - 600);
  // A plan's minutes count even when the default is 0.
  assert.equal(vm.remainingSeconds({ dailyMinutes: 60 }, "2026-11-17", 0), 3600);
  assert.equal(vm.perDayOf({ dailyMinutes: 120, extraMinutes: 30 }, 5), 150);
  assert.equal(vm.perDayOf(null, 5), 5);
  assert.equal(vm.dailyOf({ dailyMinutes: 90 }, 5), 90);
  assert.equal(vm.validDailyMinutes(null), true);
  assert.equal(vm.validDailyMinutes(0), true);
  assert.equal(vm.validDailyMinutes(1440), true);
  assert.equal(vm.validDailyMinutes(1441), false);
  assert.equal(vm.validDailyMinutes(-1), false);
  assert.equal(vm.validDailyMinutes(2.5), false);
  assert.equal(vm.validDailyMinutes("60"), false);
});

test("billing: a call's length in whole seconds, rounded up", () => {
  const a = new Date("2026-11-17T10:00:00.000Z");
  assert.equal(vm.billedSeconds(a, new Date("2026-11-17T10:01:00.000Z")), 60);
  assert.equal(vm.billedSeconds(a, new Date("2026-11-17T10:01:00.001Z")), 61);
  assert.equal(vm.billedSeconds(a, a), 0);
});

test("timers: unlimited calls keep the 15-minute cap; limited ones wrap up 30 s before today's time ends", () => {
  assert.deepEqual(vm.callTimers(undefined, 15), { wrapAtMs: null, endAtMs: 15 * 60_000 });
  assert.deepEqual(vm.callTimers(300, 15), { wrapAtMs: 270_000, endAtMs: 300_000 });
  // Little left: wrap up halfway, so there's still a goodbye.
  assert.deepEqual(vm.callTimers(40, 15), { wrapAtMs: 20_000, endAtMs: 40_000 });
  // More left than the per-call cap: the cap wins, no wrap-up line.
  assert.deepEqual(vm.callTimers(3600, 15), { wrapAtMs: null, endAtMs: 15 * 60_000 });
});

test("route: direct answered with a limit, anyone else known rung back within today's minutes, then the note; strangers rejected", () => {
  const base = { digits: "40722123456", direct: false, knownUser: true, signedLeg: false, free: 5, remainingS: 300 };
  assert.deepEqual(vm.routeCall({ ...base, direct: true, free: 120, remainingS: 7200 }), { route: "answer", limited: true, remainingS: 7200 });
  assert.deepEqual(vm.routeCall({ ...base, direct: true, remainingS: 0 }), { route: "limit-note" });
  assert.deepEqual(vm.routeCall({ ...base, direct: true, free: 0, remainingS: 0 }), { route: "limit-note" });
  assert.equal(vm.routeCall({ ...base, direct: true, knownUser: false }).route, "reject");
  // The caller ID is trusted: anyone known with time left is answered directly.
  assert.deepEqual(vm.routeCall(base), { route: "answer", limited: true, remainingS: 300 });
  assert.deepEqual(vm.routeCall({ ...base, signedLeg: true }), { route: "answer", limited: true, remainingS: 300 });
  assert.deepEqual(vm.routeCall({ ...base, remainingS: 0 }), { route: "limit-note" });
  assert.deepEqual(vm.routeCall({ ...base, signedLeg: true, remainingS: 0 }), { route: "limit-note" });
  assert.equal(vm.routeCall({ ...base, knownUser: false }).route, "reject");
  assert.equal(vm.routeCall({ ...base, digits: "" }).route, "reject");
  assert.deepEqual(vm.routeCall({ ...base, free: 0, remainingS: 0 }), { route: "reject", why: "calls are off" });
});

test("pay link: the calls checkout for this person", () => {
  assert.equal(vm.payLink("https://gepetel.com", "40722123456@s.whatsapp.net"), "https://gepetel.com/pay.html?calls=1&userId=40722123456%40s.whatsapp.net");
  assert.deepEqual(vm.EXTENSIONS, [15, 30, 60]);
});

test("call-back: anyone known with minutes left is rung, direct or not; with none left, the note instead", () => {
  const base = { configured: true, group: false, digits: "40722123456", direct: false, knownUser: true, busy: false, now: 1_000_000, free: 5, remainingS: 120 };
  assert.deepEqual(v.decideCallback(base), { ring: true });
  assert.deepEqual(v.decideCallback({ ...base, direct: true, free: 120, remainingS: 7200 }), { ring: true });
  assert.deepEqual(v.decideCallback({ ...base, remainingS: 0 }), { ring: false, why: "no call minutes left today", note: true });
  assert.deepEqual(v.decideCallback({ ...base, direct: true, free: 0, remainingS: 0 }), { ring: false, why: "no call minutes left today", note: true });
  assert.equal(v.decideCallback({ ...base, knownUser: false }).ring, false);
  // No minutes for them at all: calls are off, no note.
  assert.deepEqual(v.decideCallback({ ...base, free: 0, remainingS: 0 }), { ring: false, why: "calls are off" });
});

test("call-back: with no minutes left a WhatsApp call gets the note, not a ring", async () => {
  const env = { VOICE_ENABLED: "1", TWILIO_ACCOUNT_SID: "AC1", TWILIO_API_KEY_SID: "SK1", TWILIO_API_KEY_SECRET: "s3", VOICE_CALLER_ID: "+40700000000", OPENAI_PROJECT_ID: "proj_1", VOICE_CALLBACK_SECRET: "x" };
  const rung = [], noted = [];
  const fetchImpl = async (url) => { rung.push(url); return { ok: true, text: async () => "" }; };
  const minutes = { remaining: async () => 0, direct: async () => false, used: async () => 0, limitNote: async (c) => { noted.push(c); } };
  assert.equal(await v.callBack("40733444555", { knownUser: async () => true, fetchImpl, env, minutes }), true);
  assert.equal(rung.length, 0);
  assert.deepEqual(noted, ["40733444555@s.whatsapp.net"]);
  // With minutes left: rung back.
  minutes.remaining = async () => 200;
  assert.equal(await v.callBack("40733444666", { knownUser: async () => true, fetchImpl, env, minutes }), true);
  assert.equal(rung.length, 1);
});

test("wrap-up line: in their language, says goodbye, starts nothing new", () => {
  const w = v.wrapUpInstructions("Romanian");
  assert.match(w, /Romanian/);
  assert.match(w, /goodbye/);
  assert.match(w, /Don't start anything new/);
});
