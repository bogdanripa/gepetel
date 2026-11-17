// What a reply is doing, step by step (steps.ts): the words a phone call says
// while it waits, and when it says them.
import { test } from "node:test";
import assert from "node:assert/strict";
import s from "../dist/steps.js";

test("calendar steps name the day, never what is in it", () => {
  assert.equal(s.describeStep({ phase: "start", kind: "mcp", server: "google_calendar_bogdanripa_gmail_com", name: "list_events", args: { startTime: "2026-11-19T00:00:00", endTime: "2026-11-20T00:00:00" } }), "looking in their calendar for 2026-11-19");
  assert.equal(s.describeStep({ phase: "start", kind: "mcp", server: "google_calendar_x_gmail_com", name: "create_event", args: { startTime: "2026-11-19T13:00:00", summary: "Meeting cu Talal" } }), "adding it to their calendar on 2026-11-19");
  assert.equal(s.describeStep({ phase: "done", kind: "mcp", server: "google_calendar_x_gmail_com", name: "list_events", count: 3 }), "found 3 in their calendar, going through them");
  assert.equal(s.describeStep({ phase: "done", kind: "mcp", server: "google_calendar_x_gmail_com", name: "list_events", count: 0 }), "nothing found in their calendar, checking further");
});

test("mail steps say what is searched for, not what was found", () => {
  assert.equal(s.describeStep({ phase: "start", kind: "mcp", server: "gmail_bogdanripa_gmail_com", name: "search_threads", args: { query: "factura enel" } }), 'searching their mail for "factura enel"');
  assert.equal(s.describeStep({ phase: "start", kind: "mcp", server: "gmail_x_gmail_com", name: "get_thread", args: { threadId: "abc" } }), "opening the email");
  const long = s.describeStep({ phase: "start", kind: "mcp", server: "gmail_x", name: "search_threads", args: { query: "x".repeat(200) } });
  assert.ok(long.length < 80, long);
});

test("our own tools, the web, connectors opening; unknown tools say nothing", () => {
  assert.equal(s.describeStep({ phase: "start", kind: "tool", name: "set_reminder", args: {} }), "setting the reminder");
  assert.equal(s.describeStep({ phase: "start", kind: "tool", name: "only_reply_when_asked", args: {} }), "");
  assert.equal(s.describeStep({ phase: "done", kind: "tool", name: "set_reminder" }), "");
  assert.equal(s.describeStep({ phase: "start", kind: "search" }), "searching the web");
  assert.equal(s.describeStep({ phase: "start", kind: "list", server: "gmail_bogdanripa_gmail_com" }), "opening their mail");
  assert.equal(s.describeStep({ phase: "start", kind: "mcp", server: "gepetel_computer", name: "start_job" }), "starting it on their computer");
});

test("counting results: lists, wrapped lists, MCP text content; nothing for plain text", () => {
  assert.equal(s.countResults([1, 2]), 2);
  assert.equal(s.countResults('{"events":[{},{},{}]}'), 3);
  assert.equal(s.countResults({ content: [{ type: "text", text: '{"threads":[{}]}' }] }), 1);
  assert.equal(s.countResults("no json here"), undefined);
  assert.equal(s.countResults({ ok: true }), undefined);
});

const base = { now: 0, askStartedAt: 0, lastSpokenAt: 0, lastStepAt: 0, pendingStep: false, speaking: false, resultIn: false, fallbacks: 0 };

test("a step is said, but never within 3s of the last line, over speech, or after the answer", () => {
  assert.equal(s.progressDecision({ ...base, now: 3500, pendingStep: true, lastStepAt: 3500 }), "step");
  assert.equal(s.progressDecision({ ...base, now: 2000, pendingStep: true }), "none");
  assert.equal(s.progressDecision({ ...base, now: 5000, pendingStep: true, speaking: true }), "none");
  assert.equal(s.progressDecision({ ...base, now: 5000, pendingStep: true, resultIn: true }), "none");
});

test("the timed fallback: first at 3s, then every 6s, at most 3, and not while steps are flowing", () => {
  assert.equal(s.progressDecision({ ...base, now: 2900 }), "none");
  assert.equal(s.progressDecision({ ...base, now: 3000 }), "fallback");
  assert.equal(s.progressDecision({ ...base, now: 8000, lastSpokenAt: 3000, fallbacks: 1 }), "none");
  assert.equal(s.progressDecision({ ...base, now: 9000, lastSpokenAt: 3000, fallbacks: 1 }), "fallback");
  assert.equal(s.progressDecision({ ...base, now: 60000, lastSpokenAt: 30000, fallbacks: 3 }), "none");
  // A step 2s ago covers it.
  assert.equal(s.progressDecision({ ...base, now: 9000, lastSpokenAt: 3000, lastStepAt: 7000, fallbacks: 1 }), "none");
});
