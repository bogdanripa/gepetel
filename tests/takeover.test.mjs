// The takeover link on the relay: what a viewer may send, and who may open it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
const { cleanInput, KEYS } = await import("../dist/device/takeover.js");

describe("what a viewer may send to the Mac", () => {
  test("taps, text, keys, scroll and back — in range, nothing else", () => {
    assert.deepEqual(cleanInput({ kind: "tap", x: 10.6, y: "20" }), { kind: "tap", x: 11, y: 20 });
    assert.equal(cleanInput({ kind: "tap", x: 1e9, y: 1 }), null);
    assert.equal(cleanInput({ kind: "text", text: "x".repeat(501) }), null);
    assert.deepEqual(cleanInput({ kind: "key", key: "Enter" }), { kind: "key", key: "Enter" });
    assert.equal(cleanInput({ kind: "key", key: "Meta+W" }), null);
    assert.equal(cleanInput({ kind: "scroll", dy: 99999 }), null);
    assert.deepEqual(cleanInput({ kind: "back" }), { kind: "back" });
    assert.equal(cleanInput({ kind: "eval", code: "x" }), null);
    assert.equal(cleanInput({ kind: "navigate", url: "file:///" }), null);
    assert.ok(!KEYS.some(k => /Meta|Control|Alt/.test(k)));
  });
});
