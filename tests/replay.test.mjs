// The replay cases themselves, and the judge that reads a run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const { judge } = await import("../dist/replay.js");
const cases = JSON.parse(fs.readFileSync(new URL("../replays/cases.json", import.meta.url), "utf8"));

test("saying nothing, reacting, and speaking are told apart", () => {
  assert.deepEqual(judge({ quiet: true }, "no answer", []), []);
  assert.deepEqual(judge({ quiet: true }, "", []), []);
  assert.deepEqual(judge({ quiet: true }, "👍", []), []);
  assert.equal(judge({ quiet: true }, "Exactly. Now I just have to justify my place here", []).length, 1);
  assert.equal(judge({ silent: true }, "👍", []).length, 1, "a reaction is not silence");
});

test("what must and must not be said, and what must be called", () => {
  assert.deepEqual(judge({ yes: ["\\b3\\b"], no: ["no counter"] }, "3 left today, of 20.", []), []);
  assert.equal(judge({ no: ["delete"] }, "Delete that message now", []).length, 1, "case does not hide it");
  assert.deepEqual(judge({ calls: ["set_house_rule"] }, "👍", ["set_house_rule"]), []);
  assert.equal(judge({ calls: ["set_house_rule"] }, "Got it", []).length, 1);
  assert.deepEqual(judge({ callsAny: ["cancel_my_reminder", "list_my_reminders"] }, "x", ["list_my_reminders"]), []);
  assert.equal(judge({ maxChars: 10 }, "much longer than ten", []).length, 1);
  assert.deepEqual(judge({ is: "NO" }, "NO", []), []);
  assert.equal(judge({ is: "no" }, "yes", []).length, 1);
});

test("every case says what kind it is and what should happen", () => {
  assert.ok(cases.length >= 25);
  for (const c of cases) {
    assert.ok(c.name && ["group", "dm", "gate", "work-claim", "follow-up"].includes(c.kind), c.name);
    assert.ok(c.expect && Object.keys(c.expect).length, `${c.name}: expects something`);
    for (const r of [...(c.expect.yes || []), ...(c.expect.no || [])]) assert.doesNotThrow(() => new RegExp(r, "iu"), `${c.name}: /${r}/`);
  }
  assert.ok(cases.some(c => c.expect.calls?.includes("create_poll")), "restraint is checked against usefulness too");
});

// This repository is public. A replay is the shape of what happened, never
// the conversation: no real address, no real number, no one's real ID.
test("no case carries a real address or number", () => {
  const all = JSON.stringify(cases);
  assert.doesNotMatch(all, /@(gmail|yahoo|genez|genezio)\./i);
  const numbers = all.match(/\+?\d[\d ]{8,}\d/g) || [];
  for (const n of numbers) assert.ok(/^(\+?40 ?750 ?271 ?099|0{9,}|05?0{8,}|20\d\d)/.test(n.replace(/\s+/g, " ").trim()) || /^\+?40\s?750/.test(n), `a number that is not his own or a placeholder: ${n}`);
});
