// The message Gmail is handed. Everything else in sending is one HTTP call;
// this is the part that can be wrong in ways nobody notices until a stranger
// receives something.
import { test } from "node:test";
import assert from "node:assert/strict";
const { buildMime, default: gmail } = await import("../dist/gmail.js");
const { humanFailure } = gmail;

const bodyOf = (mime) => Buffer.from(mime.split("\r\n\r\n")[1], "base64").toString("utf8");
const headersOf = (mime) => mime.split("\r\n\r\n")[0].split("\r\n");

test("a plain message has the headers Gmail needs, and the body survives", () => {
  const mime = buildMime({ to: "ana@example.com", subject: "Invoice 4172", body: "Paying it Monday.\n\nBogdan" });
  const h = headersOf(mime);
  assert.ok(h.includes("To: ana@example.com"));
  assert.ok(h.includes("Subject: Invoice 4172"));
  assert.ok(h.includes('Content-Type: text/plain; charset="UTF-8"'));
  assert.ok(h.includes("Content-Transfer-Encoding: base64"));
  assert.equal(bodyOf(mime), "Paying it Monday.\n\nBogdan", "including its blank lines");
  assert.ok(mime.includes("\r\n\r\n"), "headers and body separated by a blank line, CRLF");
});

test("non-ASCII survives in both the subject and the body", () => {
  const mime = buildMime({ to: "a@b.ro", subject: "Întâlnire mâine", body: "Ne vedem joi la 10 — mulțumesc!" });
  // RFC 2047, or the subject arrives as mojibake.
  const subject = headersOf(mime).find(x => x.startsWith("Subject:"));
  assert.match(subject, /^Subject: =\?UTF-8\?B\?/, "encoded word");
  assert.equal(Buffer.from(subject.replace(/^Subject: =\?UTF-8\?B\?/, "").replace(/\?=$/, ""), "base64").toString("utf8"),
    "Întâlnire mâine");
  assert.equal(bodyOf(mime), "Ne vedem joi la 10 — mulțumesc!");
});

test("a newline in a header cannot start another one", () => {
  // The subject and recipient come from a model, so ultimately from whatever
  // someone typed in a chat. The header after "To:" that an attacker picks is
  // "Bcc:", and a bare newline is all it would take.
  const mime = buildMime({
    to: "ana@example.com\r\nBcc: everyone@example.com",
    subject: "hello\r\nBcc: everyone@example.com",
    body: "hi",
  });
  const h = headersOf(mime);
  assert.equal(h.some(x => /^Bcc:/i.test(x)), false, "no injected header");
  assert.equal(h.filter(x => /^To:/i.test(x)).length, 1, "exactly one To");
  assert.equal(h.filter(x => /^Subject:/i.test(x)).length, 1, "exactly one Subject");
});

test("a reply carries the headers that keep it on the thread", () => {
  const mime = buildMime({
    to: "ana@example.com", subject: "Re: Invoice 4172", body: "yes",
    inReplyTo: "<abc@mail.gmail.com>", references: "<old@x> <abc@mail.gmail.com>",
  });
  const h = headersOf(mime);
  assert.ok(h.includes("In-Reply-To: <abc@mail.gmail.com>"));
  assert.ok(h.includes("References: <old@x> <abc@mail.gmail.com>"));
});

test("cc is included when given and absent when not", () => {
  assert.ok(headersOf(buildMime({ to: "a@b.c", cc: "d@e.f", subject: "s", body: "b" })).includes("Cc: d@e.f"));
  assert.equal(headersOf(buildMime({ to: "a@b.c", subject: "s", body: "b" })).some(x => /^Cc:/i.test(x)), false);
});

// A refusal written for whoever owns the Cloud project is not a sentence to
// put in front of someone waiting on their phone.
test("Google's own refusals become something a person can act on", () => {
  const cases = [
    ["Gmail API has not been used in project 168374214147 before or it is disabled.", /not switched on on my side/],
    ["Request had insufficient authentication scopes.", /does not cover sending/],
    ["Invalid Credentials", /lapsed/],
    ["User-rate limit exceeded.", /rate-limiting/],
    ["socket hang up", /could not reach Gmail/],
  ];
  for (const [raw, want] of cases) assert.match(humanFailure(raw), want, raw);
});

test("an unrecognised refusal is passed through rather than blurred", () => {
  assert.equal(humanFailure("Recipient address rejected: user unknown"),
    "Recipient address rejected: user unknown");
  assert.ok(humanFailure("x".repeat(500)).length <= 300, "still bounded");
});
