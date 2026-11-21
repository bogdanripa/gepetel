// The per-call record (callLog.ts): one line per error, which announcements
// make one call, how a call is classified, the timeline, and the daily report's
// Bucharest day — no database, no call.
import { test } from "node:test";
import assert from "node:assert/strict";
import c from "../dist/callLog.js";

const hs = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));

test("oneLine: a pretty-printed 400 body is one line with the reason on it, capped", () => {
  const body = '400 {\n  "error": {\n    "message": "Live SIP calls require SRTP",\n    "type": "invalid_request_error"\n  }\n}';
  const l = c.oneLine(body);
  assert.ok(!l.includes("\n"));
  assert.match(l, /^400 \{ "error": \{ "message": "Live SIP calls require SRTP"/);
  assert.equal(c.oneLine("x".repeat(50), 10).length, 10);
  assert.equal(c.oneLine(null), "");
});

test("errLine: an API error carries its status and body; plain errors and strings are one line", () => {
  const e = Object.assign(new Error("Bad request"), { status: 400, error: { message: "Live SIP calls require SRTP" } });
  assert.equal(c.errLine(e), '400 Bad request {"message":"Live SIP calls require SRTP"}');
  // The SDK's message often already has the status and body: not twice.
  const e2 = Object.assign(new Error('400 {"message":"Live SIP calls require SRTP"}'), { status: 400, error: { message: "Live SIP calls require SRTP" } });
  assert.equal(c.errLine(e2), '400 {"message":"Live SIP calls require SRTP"}');
  assert.equal(c.errLine(new Error("socket\nhang up")), "socket hang up");
  assert.equal(c.errLine("timeout"), "timeout");
  assert.equal(c.errLine(undefined), "?");
});

test("legKey: our signed headers first, then Twilio's CallSid, the SIP Call-ID, the number, the id", () => {
  assert.deepEqual(c.legKey(hs({ "Call-ID": "abc" }), { id: "rtc_1", missionId: "m1" }), { key: "mission:m1", windowed: false });
  assert.deepEqual(c.legKey(hs({ "x-gepetel-ts": "1800000000", "Call-ID": "abc" }), { id: "rtc_1", callbackDigits: "40722123456" }), { key: "cb:40722123456:1800000000", windowed: false });
  assert.deepEqual(c.legKey(hs({ "X-Twilio-CallSid": "CA1", "Call-ID": "abc" }), { id: "rtc_1", digits: "40722123456" }), { key: "twilio:CA1", windowed: false });
  assert.deepEqual(c.legKey(hs({ "call-id": "abc" }), { id: "rtc_1", digits: "40722123456" }), { key: "sip:abc", windowed: false });
  assert.deepEqual(c.legKey([], { id: "rtc_1", digits: "40722123456" }), { key: "num:40722123456", windowed: true });
  assert.deepEqual(c.legKey([], { id: "rtc_1" }), { key: "id:rtc_1", windowed: false });
  assert.equal(c.headerNames(hs({ From: "<sip:+40722@x>", "Call-ID": "a", from: "dup" })), "call-id,from");
});

test("registry: a Live and two realtime announcements of one INVITE are one record; numbers join within two minutes", () => {
  c._reset();
  const sh = hs({ From: "<sip:+40722123456@x>", "Call-ID": "inv-1" });
  const a = c.announcement("live.transport.incoming", "rtc_u1", sh, { digits: "40722123456" });
  const b = c.announcement("realtime.call.incoming", "rtc_u2", sh, { digits: "40722123456" });
  const b2 = c.announcement("realtime.call.incoming", "rtc_u2", sh, { digits: "40722123456" });
  assert.equal(a, b);
  assert.equal(b, b2);
  assert.deepEqual(a.ids, ["rtc_u1", "rtc_u2"]);
  assert.equal(a.tail, "…3456");
  assert.equal(a.timeline.filter(e => e.event === "webhook").length, 3);
  assert.equal(a.timeline.filter(e => e.event === "sip headers").length, 1);
  assert.equal(c.byId("rtc_u2"), a);
  // No Call-ID: by the number, within the window only.
  let now = 1_000_000;
  const n1 = c.forKey("num:40700000001", true, () => now);
  now += 60_000;
  assert.equal(c.forKey("num:40700000001", true, () => now), n1);
  now += 200_000;
  assert.notEqual(c.forKey("num:40700000001", true, () => now), n1);
  // A call-back's leg lands on the record its ring opened.
  c.callbackRung("40722999999", 1800000000, "40722999999@s.whatsapp.net", true, "Twilio 201");
  const leg = c.announcement("realtime.call.incoming", "rtc_cb", hs({ "x-gepetel-ts": "1800000000" }), { callbackDigits: "40722999999" });
  assert.equal(leg.key, "cb:40722999999:1800000000");
  assert.equal(leg.direction, "callback");
  assert.equal(leg.rung, true);
  assert.deepEqual(leg.timeline.map(e => e.event).slice(0, 2), ["callback rung", "webhook"]);
  c._reset();
});

test("record: the timeline is ms since the first event, details one line; accept time; asks; the end", () => {
  let now = 5_000;
  const r = new c.CallRecord("sip:x", () => now);
  r.ev("webhook", "live.transport.incoming rtc_1");
  now += 120; r.ev("screened", "accept (answer)");
  now += 292; assert.equal(r.accepted(), 412);
  now += 50; r.connected();
  now += 1000; r.them(); r.them();
  now += 500; r.us();
  r.ask("ce am mâine\nîn calendar?", 6100, "6.1s [+0.4 start tool calendar.list]");
  now += 30_000; r.hungUp("goodbye"); r.hungUp("closed: peer");
  r.end([{ who: "them", text: " ce am mâine? " }, { who: "gepetel", text: "  " }], 31);
  const d = r.doc();
  assert.deepEqual(d.timeline.slice(0, 3).map(e => [e.t, e.event]), [[0, "webhook"], [120, "screened"], [412, "accept ok"]]);
  assert.equal(d.timeline.filter(e => e.event === "first words from them").length, 1);
  assert.equal(d.acceptMs, 412);
  assert.equal(d.hangup, "goodbye");
  assert.equal(d.asks[0].request, "ce am mâine în calendar?");
  assert.equal(d.asks[0].ms, 6100);
  assert.deepEqual(d.lines, [{ who: "them", text: "ce am mâine?" }]);
  assert.equal(d.durationS, 32);   // from the accept, not the first announcement
  assert.equal(d.billedS, 31);
  assert.equal(d.outcome, "answered");
  assert.equal(d.why, "goodbye");
});

test("classify: rejected, failed, no-answer, dropped, answered, in progress", () => {
  const base = { direction: "inbound", ended: true, accepted: true, heardThem: true };
  assert.deepEqual(c.classify(base), { outcome: "answered", why: "" });
  assert.deepEqual(c.classify({ ...base, accepted: false, rejected: "403: no 1:1 chat with this number" }), { outcome: "rejected", why: "403: no 1:1 chat with this number" });
  assert.deepEqual(c.classify({ ...base, accepted: false, acceptFailed: "400 Live SIP calls require SRTP" }), { outcome: "failed", why: "accept failed: 400 Live SIP calls require SRTP" });
  assert.equal(c.classify({ ...base, accepted: false, acceptFailed: "x", ended: false }).outcome, "failed");
  assert.equal(c.classify({ ...base, accepted: false, ended: false }).outcome, "in-progress");
  assert.equal(c.classify({ ...base, ended: false }).outcome, "in-progress");
  assert.deepEqual(c.classify({ ...base, direction: "outbound-mission", accepted: false, rung: true, heardThem: false }), { outcome: "no-answer", why: "never picked up" });
  assert.equal(c.classify({ ...base, accepted: false }).outcome, "failed");
  assert.equal(c.classify({ ...base, rungFailed: "Twilio: 400 bad number" }).outcome, "failed");
  assert.deepEqual(c.classify({ ...base, direction: "outbound-mission", hangup: "voicemail" }), { outcome: "no-answer", why: "voicemail" });
  assert.equal(c.classify({ ...base, direction: "outbound-mission", missionReached: false }).outcome, "no-answer");
  assert.equal(c.classify({ ...base, direction: "callback", heardThem: false }).outcome, "no-answer");
  assert.deepEqual(c.classify({ ...base, heardThem: false, hangup: "closed: peer hangup" }), { outcome: "dropped", why: "nothing heard from them (closed: peer hangup)" });
  assert.equal(c.classify({ ...base, hangup: "socket error: ECONNRESET" }).outcome, "dropped");
});

test("qualityGrade: the network grade when there is one, else the relay's errors and resources", () => {
  const q = { model: "gpt-live-1", secs: 60, errors: [], rateLimitEvents: 0, events: 10, pi: { cpuPct: { avg: 10, max: 20 }, lagMs: { avg: 5, max: 20 } } };
  assert.equal(c.qualityGrade(null), "");
  assert.equal(c.qualityGrade(q), "ok");
  assert.equal(c.qualityGrade({ ...q, net: { grade: "bad" } }), "bad");
  assert.equal(c.qualityGrade({ ...q, errors: ["rate_limit"] }), "warn");
  assert.equal(c.qualityGrade({ ...q, pi: { lagMs: { avg: 50, max: 150 } } }), "warn");
  assert.equal(c.qualityGrade({ ...q, pi: { lagMs: { avg: 50, max: 900 } } }), "bad");
  assert.equal(c.qualityGrade({ ...q, pi: null }), "ok");
});

test("dayBounds: a Bucharest day, 23 and 25 hours at the clock changes", () => {
  const nov = c.dayBounds("2026-11-21");
  assert.equal(nov.from.toISOString(), "2026-11-20T22:00:00.000Z");
  assert.equal(nov.to.toISOString(), "2026-11-21T22:00:00.000Z");
  const jul = c.dayBounds("2026-07-01");
  assert.equal(jul.from.toISOString(), "2026-06-30T21:00:00.000Z");
  const spring = c.dayBounds("2026-03-29");
  assert.equal((spring.to - spring.from) / 3600_000, 23);
  const autumn = c.dayBounds("2026-10-25");
  assert.equal((autumn.to - autumn.from) / 3600_000, 25);
  assert.equal(c.dayBounds("21-11-2026"), null);
  // A call at 23:30 UTC on the 20th is the 21st in Bucharest.
  assert.equal(c.localDay(new Date("2026-11-20T23:30:00Z")), "2026-11-21");
  assert.equal(c.dayBefore("2026-03-01"), "2026-02-28");
});

test("digestDay: yesterday's, from 08:00 Bucharest", () => {
  assert.equal(c.digestDay(new Date("2026-11-21T05:30:00Z")), "");          // 07:30 there
  assert.equal(c.digestDay(new Date("2026-11-21T06:05:00Z")), "2026-11-20"); // 08:05 there
  assert.equal(c.digestDay(new Date("2026-11-21T21:30:00Z")), "2026-11-20"); // 23:30 there
});

test("summaryLine and the page: counts, accept times, asks, quality, a failure's reason; escaped", () => {
  const row = (o) => c.toRow({ key: "k", startedAt: new Date("2026-11-21T08:15:00Z"), direction: "inbound", name: "Ana", tail: "…3456", model: "gpt-live-1", route: "live", outcome: "answered", durationS: 120, acceptMs: 400, asks: [{ request: "ce am mâine?", ms: 6100, steps: "" }], quality: { model: "gpt-live-1", secs: 120, errors: [], rateLimitEvents: 0, events: 3, pi: null }, timeline: [{ t: 0, event: "webhook", detail: "<b>" }], lines: [{ who: "them", text: "<script>x</script>" }], ...o });
  const rows = [row({}), row({ outcome: "failed", why: "accept failed: 400 Live SIP calls require SRTP", acceptMs: null, asks: [], durationS: 0, quality: null }), row({ test: true, acceptMs: 2300 })];
  assert.equal(rows[0].time, "10:15");
  assert.equal(rows[0].who, "Ana …3456");
  assert.equal(c.toRow({ direction: "outbound-mission", business: "Bun", name: "Bogdan" }).who, "Bun (for Bogdan)");
  const s = c.summaryLine("2026-11-21", rows, "https://x/voice/calls?day=2026-11-21");
  assert.match(s, /^Calls 2026-11-21: 3 \(1 test\), 4 min — 2 answered, 1 failed/);
  assert.match(s, /accept p50 2\.3 s, max 2\.3 s/);
  assert.match(s, /2 ask\(s\), avg 6\.1 s/);
  assert.match(s, /quality 2 ok/);
  assert.match(s, /e\.g\. 10:15 failed: accept failed: 400 Live SIP calls require SRTP/);
  assert.match(s, /https:\/\/x\/voice\/calls\?day=2026-11-21$/);
  assert.ok(!s.includes("\n"));
  assert.equal(c.summaryLine("2026-11-21", []), "");
  const html = c.renderReport("2026-11-21", rows);
  assert.ok(!html.includes("<script>x"));
  assert.match(html, /&lt;script&gt;x/);
  assert.match(html, /\?day=2026-11-20/);
  assert.match(html, /\?day=2026-11-22/);
  assert.match(html, /400 ms/);
});

test("sweep: a call rung but never picked up is closed off as no-answer", () => {
  c._reset();
  c.missionPlaced({ id: "m9", chatId: "40722@s.whatsapp.net", author: "Bogdan", business_name: "Bun" }, true, "Twilio 201");
  const r = c.forKey("mission:m9");
  assert.equal(r.doc().outcome, "in-progress");
  c._sweep(Date.now() + 16 * 60_000);
  assert.equal(r.doc().outcome, "no-answer");
  assert.equal(r.business, "Bun");
  c._reset();
});
