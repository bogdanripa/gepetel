// turn.ts: one live reply per chat; a message arriving meanwhile joins it.
import { test } from "node:test";
import assert from "node:assert/strict";

const turns = (await import("../dist/turn.js")).default;

test("a throwing generator still closes its turn", async () => {
  const orig = console.warn; console.warn = () => {};
  try {
    await assert.rejects(turns.withTurn("c_throw", async turn => {
      assert.ok(turns.hasLiveTurn("c_throw"));
      assert.ok(turns.offerToTurn("c_throw", "Ana: and me"));
      throw new Error("model down");
    }), /model down/);
  } finally { console.warn = orig; }
  assert.equal(turns.hasLiveTurn("c_throw"), false);
  assert.equal(turns.offerToTurn("c_throw", "Ana: hello?"), false, "the next message is handled on its own");
});

test("withTurn returns the generator's answer and closes", async () => {
  const r = await turns.withTurn("c_ok", async turn => {
    turns.offerToTurn("c_ok", "x");
    return turns.pullPending(turn);
  });
  assert.deepEqual(r, ["x"]);
  assert.equal(turns.hasLiveTurn("c_ok"), false);
});

test("a late close of a replaced turn doesn't end the newer one", () => {
  const a = turns.beginTurn("c_two");
  const b = turns.beginTurn("c_two");
  turns.closeTurn(a);
  assert.ok(turns.hasLiveTurn("c_two"));
  turns.closeTurn(b);
  assert.equal(turns.hasLiveTurn("c_two"), false);
});
