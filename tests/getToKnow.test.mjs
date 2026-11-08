// Getting to know them (getToKnow.ts): when it applies, where it is, and how
// a reply becomes short messages.
import { test } from "node:test";
import assert from "node:assert/strict";

const g = (await import("../dist/getToKnow.js")).default;

test("[[next]] splits a reply into short messages, four at most", () => {
  assert.deepEqual(g.bubbles("Hi Bogdan.\n[[next]]\nI'm Gepetel.\n[[next]]\nWhat fills your days?"), ["Hi Bogdan.", "I'm Gepetel.", "What fills your days?"]);
  assert.deepEqual(g.bubbles("Just one."), ["Just one."]);
  const five = g.bubbles("a [[next]] b [[NEXT]] c [[next]] d [[next]] e");
  assert.equal(five.length, 4);
  assert.equal(five[3], "d\n\ne");
});

test("the stage: a first hello, early on, or under way", () => {
  assert.match(g.stage([], 0, "Bogdan Ripa"), /first time they write to you.*"Bogdan Ripa"/s);
  assert.match(g.stage([{ from: "Gepetel", text: "Hi" }], 1, ""), /only just started/);
  assert.match(g.stage([{ from: "Gepetel", text: "Hi" }], 5, ""), /Don't interview them/);
});

test("it stays out of a chat Gepetel opened, and out of one with mail and calendar connected", async () => {
  const o = { outreach: false, history: [], known: 0, name: "" };
  assert.equal(await g.block("x@s.whatsapp.net", ["web"], { ...o, outreach: true }), "");
  assert.equal(await g.block("x@s.whatsapp.net", ["web", "email", "calendar"], o), "");
  // No database: nothing remembers a "not now", so it never pushes.
  assert.equal(await g.block("x@s.whatsapp.net", ["web"], o), "");
});

// Interrupted like a person: a new message waits for the reply going out, and
// short messages still queued stop when they write.
const turns = (await import("../dist/turn.js")).default;

test("a message that lands while a reply is going out waits for it — and never for ever", async () => {
  turns.beginTurn("w@s.whatsapp.net");
  let done = false;
  const waiting = turns.settled("w@s.whatsapp.net").then(() => { done = true; });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(done, false);
  turns.delivered("w@s.whatsapp.net");
  await waiting;
  assert.equal(done, true);
  // Nothing going out: no wait. A delivery nobody closes: capped.
  await turns.settled("nobody@s.whatsapp.net");
  turns.beginTurn("stuck@s.whatsapp.net");
  const t0 = Date.now();
  await turns.settled("stuck@s.whatsapp.net", 50);
  assert.ok(Date.now() - t0 < 1000);
  turns.delivered("stuck@s.whatsapp.net");
});

test("heardSince: did they write after we started talking", () => {
  const t = Date.now();
  turns.heard("h@s.whatsapp.net", t - 10);
  assert.equal(turns.heardSince("h@s.whatsapp.net", t), false);
  turns.heard("h@s.whatsapp.net", t + 10);
  assert.equal(turns.heardSince("h@s.whatsapp.net", t), true);
});
