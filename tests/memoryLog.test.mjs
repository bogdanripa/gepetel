// The relay's log of a computer memory call (Phase 9): which call, never what
// it held — a person's passport number goes through it.
import { test } from "node:test";
import assert from "node:assert/strict";
const { memoryArgsBrief } = (await import("../dist/util.js")).default;

test("a memory call is logged by kind only", () => {
  const raw = JSON.stringify({ about: "person", action: "add", person: "Ana", label: "passport number", text: "X1234567" });
  const brief = memoryArgsBrief(raw);
  assert.equal(brief, "about=person action=add");
  assert.ok(!/X1234567|Ana|passport/.test(brief));
  assert.equal(memoryArgsBrief("not json"), "about=? action=?");
});
