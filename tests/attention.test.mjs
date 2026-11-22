// One budget for everything he sends that nobody asked for.
//
// Follow-ups, check-ins, nudges and hellos each had their own limit and none
// knew about the others: one person got nine follow-ups and about thirty
// check-ins in two weeks and answered one. The count is now taken from their
// side — what they did with the last few — and every sender answers to it.
import { test } from "node:test";
import assert from "node:assert/strict";
const { gapFor, allowed, HEARD_WITHIN_MS } = (await import("../dist/attention.js")).default;

const H = 3600_000, D = 24 * H;
const NOW = new Date("2026-11-22T12:00:00Z");
const ago = (ms, heard = false, asked = false) => ({ at: new Date(NOW.getTime() - ms), kind: "check-in", heard, asked });

test("someone who answers hears from him as often as before", () => {
  const sent = [ago(5 * D, true), ago(4 * D, true), ago(3 * D, false), ago(2 * D, true), ago(1 * D, true)];
  assert.equal(gapFor(sent, NOW).gapMs, 2 * H);
  assert.equal(allowed([...sent, ago(3 * H, true)], NOW).ok, true);
  assert.equal(allowed([...sent, ago(1 * H, true)], NOW).ok, false, "still not two in two hours");
});

test("someone who never answers hears from him once a week", () => {
  const sent = [ago(9 * D), ago(8 * D), ago(7 * D), ago(6 * D), ago(5 * D), ago(4 * D)];
  const g = gapFor(sent, NOW);
  assert.equal(g.gapMs, 7 * D);
  assert.match(g.why, /none of the last 6 answered/);
  assert.equal(allowed(sent, NOW).ok, false, "the last one was four days ago");
  assert.equal(allowed(sent, new Date(NOW.getTime() + 4 * D)).ok, true, "a week after it, one more");
});

test("in between: once a day, or every other day", () => {
  assert.equal(gapFor([ago(5 * D, true), ago(4 * D), ago(3 * D), ago(2 * D, true), ago(1 * D), ago(12 * H)], NOW).gapMs, 20 * H);
  assert.equal(gapFor([ago(8 * D, true), ago(7 * D), ago(6 * D), ago(5 * D), ago(4 * D), ago(3 * D), ago(2 * D), ago(1 * D)], NOW).gapMs, 2 * D);
});

test("it recovers as soon as they start answering", () => {
  const cold = [ago(30 * D), ago(25 * D), ago(20 * D), ago(15 * D), ago(10 * D), ago(8 * D)];
  assert.equal(gapFor(cold, NOW).gapMs, 7 * D);
  const warming = [...cold, ago(3 * D, true), ago(2 * D, true), ago(1 * D, true), ago(10 * H, true)];
  assert.equal(gapFor(warming, NOW).gapMs, 2 * H, "four of the last eight answered");
});

test("with little to go on: once a day, not three times", () => {
  assert.equal(gapFor([], NOW).gapMs, 20 * H);
  assert.equal(gapFor([ago(2 * D, true), ago(1 * D, true)], NOW).gapMs, 20 * H);
  assert.equal(allowed([], NOW).ok, true, "the first one always goes");
});

test("what they asked to be told is never held, and never counted against them", () => {
  const cold = [ago(9 * D), ago(8 * D), ago(7 * D), ago(6 * D), ago(5 * D), ago(1 * H)];
  assert.equal(allowed(cold, NOW).ok, false);
  assert.equal(allowed(cold, NOW, true).ok, true, "their parcel is out for delivery");
  // Ten unanswered parcel updates say nothing about whether they like hearing from him.
  const parcels = Array.from({ length: 10 }, (_, i) => ago((i + 1) * D, false, true));
  assert.equal(gapFor(parcels, NOW).rate, null);
  assert.equal(allowed(parcels, NOW).ok, true);
});

test("one that could still be answered is not yet counted as ignored", () => {
  const sent = [ago(5 * D, true), ago(4 * D, true), ago(3 * D, true), ago(2 * D, true), ago(1 * H)];
  assert.equal(gapFor(sent, NOW).rate, 1, "the one from an hour ago is still open");
  assert.ok(HEARD_WITHIN_MS >= 2 * H);
});
