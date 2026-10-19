// The message being answered is already the history's last line (saved first):
// sent to the model once, not twice — "I received the SmartBill PDF twice"
// (2026-10-19).
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.OPENAI_API_KEY ||= "test-not-a-key";
const { withoutCurrent } = await import("../dist/oai.js");

test("the current message isn't sent twice", () => {
  const h = [{ from: "Gepetel", text: "hi" }, { from: "Bogdan", text: '[a document "x.pdf"]' }];
  assert.deepEqual(withoutCurrent(h, '[a document "x.pdf"]'), h.slice(0, 1));
  assert.deepEqual(withoutCurrent(h, "something else"), h);
  assert.deepEqual(withoutCurrent([{ from: "Ana", text: "da" }], "Ana: da", true), []);
  assert.deepEqual(withoutCurrent([{ from: "Gepetel", text: "da" }], "da"), [{ from: "Gepetel", text: "da" }], "never Gepetel's own line");
});
