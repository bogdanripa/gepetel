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
