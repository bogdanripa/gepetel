// The message Gmail is handed. Everything else in sending is one HTTP call;
// this is the part that can be wrong in ways nobody notices until a stranger
// receives something.
import { test } from "node:test";
import assert from "node:assert/strict";
const { buildMime, default: gmail } = await import("../dist/gmail.js");
const { humanFailure, pickGmail, mailboxOf } = gmail;

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

// Two mailboxes in one chat is a case the prompt invites. Picking the wrong
// one puts the wrong name on a message to someone else, and the first anyone
// hears of it is the reply.
const G = (label) => ({ label, server_url: "https://gmailmcp.googleapis.com/mcp/v1", oauth: { access_token: "t" } });

test("the address is read out of the label", () => {
  assert.equal(mailboxOf("Gmail (ana@firma.ro)"), "ana@firma.ro");
  assert.equal(mailboxOf("Gmail"), "Gmail");
});

test("one mailbox is used without being asked for", () => {
  const got = pickGmail([G("Gmail (ana@firma.ro)"), { label: "Trello" }]);
  assert.equal(got.ok, true);
  assert.equal(got.connector.label, "Gmail (ana@firma.ro)");
});

test("two mailboxes and no hint refuses instead of guessing", () => {
  const got = pickGmail([G("Gmail (ana@firma.ro)"), G("Gmail (ana@gmail.com)")]);
  assert.equal(got.ok, false);
  assert.match(got.reason, /ana@firma\.ro/);
  assert.match(got.reason, /ana@gmail\.com/);
});

test("a hint picks the mailbox, by address or by word", () => {
  const two = [G("Gmail (ana@firma.ro)"), G("Gmail (personal — ana@gmail.com)")];
  assert.equal(pickGmail(two, "firma.ro").connector.label, "Gmail (ana@firma.ro)");
  assert.equal(pickGmail(two, "personal").connector.label, "Gmail (personal — ana@gmail.com)");
  assert.equal(pickGmail(two, "ANA@FIRMA.RO").connector.label, "Gmail (ana@firma.ro)");
});

test("a hint that fits none, or fits both, refuses and says what there is", () => {
  const two = [G("Gmail (ana@firma.ro)"), G("Gmail (ana@gmail.com)")];
  const none = pickGmail(two, "outlook");
  assert.equal(none.ok, false);
  assert.match(none.reason, /ana@firma\.ro \/ ana@gmail\.com/);
  assert.equal(pickGmail(two, "ana").ok, false, "ambiguous hint is not a choice");
});

test("no Gmail at all says so", () => {
  assert.equal(pickGmail([{ label: "Trello" }]).ok, false);
  assert.match(pickGmail([]).reason, /no Gmail connected/);
});

// "The reply didn't go out because there are two connections for the same
// personal address. Which one should I use, the first or the second?" — three
// times running (2026-11-24). The second "mailbox" was his calendar.
test("a calendar connected under a gmail.com address is not a mailbox", () => {
  const { isGmailConnector, gmailsOf } = gmail;
  const C = (label, server_url = "") => ({ label, server_url });
  const all = [C("Computer"), C("Gmail (dan.pop@gmail.com)", "https://gmailmcp.googleapis.com/mcp/v1"), C("Google Calendar (dan.pop@gmail.com)", "https://calendarmcp.googleapis.com/mcp/v1"),
    C("Acme CRM (maria@example.com)"), C("Gmail (dan@example.com)", "https://gmailmcp.googleapis.com/mcp/v1"), C("Google Calendar (work)")];
  assert.deepEqual(gmailsOf(all).map(c => c.label), ["Gmail (dan.pop@gmail.com)", "Gmail (dan@example.com)"]);
  assert.equal(isGmailConnector(C("Google Calendar (dan.pop@gmail.com)")), false);
  assert.equal(isGmailConnector(C("My mail", "https://gmailmcp.googleapis.com/mcp/v1")), true, "by its server, whatever it is called");
  // So "the personal one", by its address, is one mailbox — and it is picked.
  const got = pickGmail(all, "dan.pop@gmail.com");
  assert.equal(got.ok, true);
  assert.equal(got.connector.label, "Gmail (dan.pop@gmail.com)");
  // The label the model sees for it in its tools works too.
  assert.equal(pickGmail(all, "gmail_dan_pop_gmail_com").connector.label, "Gmail (dan.pop@gmail.com)");
  assert.equal(pickGmail(all, "gmail_dan_example_com").connector.label, "Gmail (dan@example.com)");
});

test("a reply leaves from the mailbox the message is in — nobody is asked which", async () => {
  const { mailboxHolding } = gmail;
  const personal = { label: "Gmail (dan.pop@gmail.com)" }, work = { label: "Gmail (dan@example.com)" };
  const tried = [];
  const has = where => async g => { tried.push(g.label); return g === where ? { id: "m1" } : null; };
  // Not named: found by looking.
  assert.equal((await mailboxHolding([personal, work], null, has(work))).connector, work);
  assert.deepEqual(tried, ["Gmail (dan.pop@gmail.com)", "Gmail (dan@example.com)"]);
  // Named: that one first, and no second look when it is there.
  tried.length = 0;
  assert.equal((await mailboxHolding([personal, work], work, has(work))).connector, work);
  assert.deepEqual(tried, ["Gmail (dan@example.com)"]);
  // Named wrongly: the message decides, not the name.
  assert.equal((await mailboxHolding([personal, work], work, has(personal))).connector, personal);
  // A mailbox that throws (a lapsed login, a 404) is just not the one.
  assert.equal((await mailboxHolding([personal, work], null, async g => { if (g === personal) throw new Error("404"); return { id: "m1" }; })).connector, work);
  assert.equal(await mailboxHolding([personal, work], null, async () => null), null);
});
