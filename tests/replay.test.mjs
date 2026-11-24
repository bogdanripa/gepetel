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

test("a case can say what a call must carry", () => {
  const e = { args: { set_reminder: { by_call: true } } };
  assert.deepEqual(judge(e, "te sun", ["set_reminder"], [{ tool: "set_reminder", what: "x", by_call: true }]), []);
  assert.equal(judge(e, "ok", ["set_reminder"], [{ tool: "set_reminder", what: "x" }]).length, 1);
  assert.equal(judge(e, "ok", [], []).length, 1, "not called at all");
  const plain = { args: { set_reminder: { by_call: false } } };
  assert.deepEqual(judge(plain, "ok", ["set_reminder"], [{ tool: "set_reminder", what: "x" }]), [], "left out counts as false");
  assert.equal(judge(plain, "ok", ["set_reminder"], [{ tool: "set_reminder", by_call: true }]).length, 1);
});

test("a case can say what comes before what, and what a call was told", () => {
  const e = { order: ["read_email_attachment", "browse"], argsSay: { browse: ["RO49AAAA", "104"] } };
  const args = [{ tool: "read_email_attachment", id: "t1" }, { tool: "browse", goal: "pay 104 RON to IBAN RO49AAAA1B31", start_url: "https://bank.example" }];
  assert.deepEqual(judge(e, "ok", ["gmail_search", "read_email_attachment", "browse"], args), []);
  assert.equal(judge(e, "ok", ["browse", "read_email_attachment"], args).length, 1, "the bank before the invoice");
  assert.equal(judge({ order: e.order }, "ok", ["browse"], []).length, 1, "the invoice never read");
  assert.equal(judge({ argsSay: e.argsSay }, "ok", ["browse"], [{ tool: "browse", goal: "pay the invoice from Gmail" }]).length, 2, "a bank job with nothing to type");
});

test("a case can say how many items one call must carry", () => {
  const e = { itemsAtLeast: { set_reminder: 3 } };
  const items = n => Array.from({ length: n }, (_, i) => ({ what: `x${i}`, at: "2026-12-01 10:00" }));
  assert.deepEqual(judge(e, "ok", ["set_reminder"], [{ tool: "set_reminder", items: items(3) }]), []);
  assert.deepEqual(judge(e, "ok", ["set_reminder"], [{ tool: "set_reminder", what: "a", at: "2026-12-01 09:00", items: items(2) }]), [], "what/at count as the first item");
  assert.equal(judge(e, "ok", ["set_reminder"], [{ tool: "set_reminder", items: items(2) }]).length, 1, "a subset");
  assert.equal(judge(e, "ok", ["set_reminder", "set_reminder"], [{ tool: "set_reminder", items: items(2) }, { tool: "set_reminder", items: items(2) }]).length, 1, "split across calls");
  assert.equal(judge(e, "ok", ["set_reminder"], [{ tool: "set_reminder", what: "a", at: "2026-12-01 09:00" }]).length, 1, "the single form is one item");
  assert.equal(judge(e, "ok", [], []).length, 1, "not called at all");
});
