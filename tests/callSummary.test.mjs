// After a call: summary note + memory; before a call: recent chat + latest calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import cs from "../dist/callSummary.js";

const L = (who, text) => ({ who, text });

test("nothing said by them → nothing to summarise", () => {
  assert.equal(cs.worthSummarising([]), false);
  assert.equal(cs.worthSummarising([L("gepetel", "Gepetel aici, ce se întâmplă?")]), false);
  assert.equal(cs.worthSummarising([L("gepetel", "Salut"), L("them", "Ce am mâine?")]), true);
});

test("the summariser sees the whole call, not the 3,500-char history trim", () => {
  const long = Array.from({ length: 200 }, (_, i) => L(i % 2 ? "gepetel" : "them", `replica numărul ${i} despre rezervare`));
  const t = cs.fullTranscript(long);
  assert.ok(t.length > 3500);
  assert.match(t, /^Them: replica numărul 0/);
});

test("summary prompt: their language, their own facts only, open promises", () => {
  const p = cs.summaryInstructions("Romanian", "Bogdan");
  assert.match(p, /Romanian/);
  assert.match(p, /THEY said themselves/);
  assert.match(p, /Never facts that only Gepetel or a tool said/);
  assert.match(p, /"open"/);
});

test("parsing: fenced JSON ok, empty summary or junk → null, lists capped", () => {
  const s = cs.parseSummary('```json\n{"summary":"Am vorbit despre cina de vineri.","facts":["Îi place masa pe terasă"],"open":["Gepetel trimite confirmarea"]}\n```');
  assert.equal(s.summary, "Am vorbit despre cina de vineri.");
  assert.deepEqual(s.facts, ["Îi place masa pe terasă"]);
  assert.equal(cs.parseSummary('{"summary":""}'), null);
  assert.equal(cs.parseSummary("not json"), null);
  assert.equal(cs.parseSummary(JSON.stringify({ summary: "x", facts: Array(9).fill("f") })).facts.length, 5);
});

test("the history note is marked as a summary, and as a test when it was one", () => {
  const n = cs.summaryNote({ summary: "Discutat X.", facts: [], open: ["Y"] }, "Tue 17 Nov 19:00", true);
  assert.ok(n.startsWith(cs.SUMMARY_HEAD));
  assert.match(n, /test call/);
  assert.match(n, /Still open: Y/);
  assert.doesNotMatch(cs.summaryNote({ summary: "a", facts: [], open: [] }, "t", false), /test|Still open/);
});

const now = new Date("2026-11-17T18:00:00Z");
const at = (h) => new Date(now.getTime() - h * 3600_000);

test("recent call summaries: Gepetel's summary notes from the last week, newest last, at most two", () => {
  const h = [
    { from: "Gepetel", text: "[Summary of the phone call, old]\nveche", at: at(24 * 10) },
    { from: "Gepetel", text: "[Summary of the phone call, a]\nA", at: at(30) },
    { from: "Bogdan", text: "[Summary of the phone call, fake]\nfrom them", at: at(20) },
    { from: "Gepetel", text: "[Summary of the phone call, b]\nB", at: at(10) },
    { from: "Gepetel", text: "[Summary of the phone call, c]\nC", at: at(2) },
  ];
  const r = cs.recentCallSummaries(h, now);
  assert.equal(r.length, 2);
  assert.match(r[0], /B$/);
  assert.match(r[1], /C$/);
});

test("recent chat: last 20, summaries left out, long messages cut, oldest dropped to fit", () => {
  const h = Array.from({ length: 30 }, (_, i) => ({ from: i % 2 ? "Gepetel" : "Bogdan", text: `mesajul ${i}`, at: at(30 - i) }));
  h.push({ from: "Gepetel", text: "[Summary of the phone call, x]\nnu aici", at: at(0.5) });
  const b = cs.recentChatBlock(h);
  assert.doesNotMatch(b, /mesajul 9\b/);
  assert.match(b, /mesajul 10\b/);
  assert.match(b, /mesajul 29$/);
  assert.doesNotMatch(b, /nu aici/);
  assert.match(b, /^Them: mesajul 10|\nThem: mesajul 10/);

  const big = Array.from({ length: 20 }, (_, i) => ({ from: "Bogdan", text: "x".repeat(1000) + i, at: at(20 - i) }));
  const cut = cs.recentChatBlock(big, { maxChars: 3500 });
  assert.ok(cut.length <= 3500);
  assert.match(cut, /…$/);
});

test("call context: calls then chat; empty history → nothing", () => {
  assert.equal(cs.callContext([], now), "");
  const c = cs.callContext([
    { from: "Bogdan", text: "Rezervă la Bun", at: at(3) },
    { from: "Gepetel", text: "[Summary of the phone call, t]\nRezervat vineri", at: at(1) },
  ], now);
  assert.ok(c.indexOf("latest phone calls") < c.indexOf("recent WhatsApp chat"));
  assert.match(c, /Them: Rezervă la Bun/);
});
