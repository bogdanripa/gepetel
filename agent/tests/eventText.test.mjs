// The line that heads a finished job's result in the chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventText } from "../dist/eventText.js";

const browse = { tool: "browse", args: { start_url: "https://www.bank.example/login" } };

test("done, failed, and the third way: it ran to its end and the answer is that it couldn't", () => {
  assert.equal(eventText(browse, { ok: true, content: "Paid: 104 lei." }), "Done: `bank.example`\nPaid: 104 lei.");
  assert.equal(eventText(browse, { ok: false, content: "Chrome isn't connected." }), "Failed: `bank.example`\nChrome isn't connected.");
  // "And why would you say 'done' here?" (the owner, 2026-11-24): the job had
  // an answer, and the answer was that it never reached the account.
  const couldnt = eventText(browse, { ok: true, content: "I couldn't reach the account or the payment.", meta: { steps: 14, not_done: true } });
  assert.equal(couldnt, "Couldn't do it: `bank.example`\nI couldn't reach the account or the payment.");
  assert.doesNotMatch(couldnt, /^Done/);
});

test("in Romanian, and for a command", () => {
  const ro = { ...browse, chat_lang: "Romanian" };
  assert.match(eventText(ro, { ok: true, content: "x" }), /^Gata: `bank\.example`\n/);
  assert.match(eventText(ro, { ok: true, content: "x", meta: { not_done: true } }), /^N-am reușit: `bank\.example`\n/);
  assert.match(eventText(ro, { ok: false, content: "x" }), /^N-a mers: `bank\.example`\n/);
  assert.match(eventText({ tool: "shell", args: { command: "ls -la" } }, { ok: true, content: "x" }), /^Done: `ls -la`\n/);
});

test("nothing to name it by: no empty quotes; and a long result is cut", () => {
  assert.equal(eventText({ tool: "browse", args: {} }, { ok: true, content: "x" }), "Done:\nx");
  assert.equal(eventText(browse, { ok: true, content: "y".repeat(5000) }).length, 1500);
});
