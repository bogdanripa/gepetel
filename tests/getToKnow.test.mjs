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

test("it stays out of a chat Gepetel opened, and never pushes without a memory of \"not now\"", async () => {
  const o = { outreach: false, history: [], known: 0, name: "" };
  assert.equal(await g.block("x@s.whatsapp.net", ["web"], { ...o, outreach: true }), "");
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

test("typing: the reply waits for what they're writing, and stops waiting when they stop", async () => {
  const t = turns.beginTurn("ty@s.whatsapp.net");
  turns.typing("ty@s.whatsapp.net", "typing");
  setTimeout(() => turns.offerToTurn("ty@s.whatsapp.net", "Ana: and Radu too"), 100);
  assert.equal(await turns.waitWhileTyping(t, 20), true);
  turns.closeTurn(t); turns.delivered("ty@s.whatsapp.net");
  // Not typing: no wait at all.
  turns.typing("ty@s.whatsapp.net", "paused");
  const t2 = turns.beginTurn("ty@s.whatsapp.net");
  assert.equal(await turns.waitWhileTyping(t2, 20), false);
  turns.closeTurn(t2); turns.delivered("ty@s.whatsapp.net");
  // A typing event nobody refreshed has ended.
  turns.typing("old@s.whatsapp.net", "typing", Date.now() - 60_000);
  assert.equal(turns.typingState("old@s.whatsapp.net"), "");
});

test("a connect link nobody used: come back once — unless it was used, or they wrote", async () => {
  const calls = [];
  g.whenLinkUnused(async (chatId, label) => { calls.push(`${chatId}:${label}`); });
  const deps = (used, wrote) => ({ used: async () => used, wroteSince: async () => wrote, after: 10 });
  g.watchLink("a@s.whatsapp.net", "s1", "Gmail", deps(false, false));
  g.watchLink("a@s.whatsapp.net", "s2", "Gmail", deps(false, false));   // one at a time per chat
  g.watchLink("b@s.whatsapp.net", "s3", "Gmail", deps(true, false));
  g.watchLink("c@s.whatsapp.net", "s4", "Gmail", deps(false, true));
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(calls, ["a@s.whatsapp.net:Gmail"]);
});

test("their message ends their typing — no waiting for a typing that's over", async () => {
  turns.typing("sent@s.whatsapp.net", "typing");
  turns.heard("sent@s.whatsapp.net");
  assert.equal(turns.typingState("sent@s.whatsapp.net"), "");
});

test("one message at a time through the door: the next comes in once the one before has started its turn", async () => {
  const order = [];
  const r1 = await turns.admit("door@s.whatsapp.net");
  const second = turns.admit("door@s.whatsapp.net").then((r) => { order.push("second in"); return r; });
  const other = await turns.admit("elsewhere@s.whatsapp.net");   // another chat never waits
  other();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, []);
  const t = turns.beginTurn("door@s.whatsapp.net");               // the first started its turn
  const r2 = await second;
  assert.deepEqual(order, ["second in"]);
  assert.equal(turns.offerToTurn("door@s.whatsapp.net", "Body: and this"), true);   // …and joins it
  r1(); r2(); turns.closeTurn(t); turns.delivered("door@s.whatsapp.net");
  // A message that never lets go: the next is let in anyway.
  await turns.admit("stuck-door@s.whatsapp.net");
  const t0 = Date.now();
  (await turns.admit("stuck-door@s.whatsapp.net", 50))();
  assert.ok(Date.now() - t0 < 1000);
});

test("the opening, once per chat: a first hello, or a fresh start for someone without mail or calendar", () => {
  const talked = [{ from: "Body", text: "hi" }, { from: "Gepetel", text: "Hi" }];
  // New: the first hello, and that uses it up.
  assert.deepEqual([g.opening(null, [], 0, "Ana").mark, /first time/.test(g.opening(null, [], 0, "Ana").stage)], [true, true]);
  // Talked before, nothing connected: the fresh start.
  const fresh = g.opening(null, talked, 2, "Bogdan Ripa", ["web"]);
  assert.equal(fresh.mark, true);
  assert.match(fresh.stage, /You've talked before.*THREE short messages/s);
  // Talked before, with mail or calendar: no fresh start, but it's used up all the same.
  for (const had of [["email"], ["calendar", "web"]]) {
    const o = g.opening(null, talked, 2, "", had);
    assert.equal(o.mark, true);
    assert.doesNotMatch(o.stage, /You've talked before/);
  }
  // Had it already: the ordinary stage, nothing to mark.
  const again = g.opening({ restarted_at: new Date() }, talked, 2, "", ["web"]);
  assert.equal(again.mark, false);
  assert.doesNotMatch(again.stage, /You've talked before/);
});
