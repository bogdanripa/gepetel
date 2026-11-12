// Their address book (contacts.ts): one card per person, added to rather
// than overwritten, found by name, relation, label, number or address — and
// never read from a group.
import { test } from "node:test";
import assert from "node:assert/strict";
const c = (await import("../dist/contacts.js")).default;
const wall = (await import("../dist/wall.js")).default;
const G = "120363392171791536@g.us", ME = "40723418290@s.whatsapp.net";

const blank = { contact_id: "c_1", name: "", relation: "", phones: [], emails: [], labels: [], birthday: "", notes: "" };
const anca = c.merge(blank, { name: "Anca Ripa", relation: "wife", phones: ["0722 123 456"], emails: ["Anca@Example.com"], labels: ["Family", " family "] });

test("numbers, addresses and labels are kept in one shape", () => {
  assert.equal(c.normalizePhone("0722 123 456"), "0722123456");
  assert.equal(c.normalizePhone("+40 (722) 123-456"), "+40722123456");
  assert.equal(c.normalizePhone("0040722123456"), "+40722123456");
  assert.equal(c.normalizePhone("12"), "");
  assert.equal(c.normalizeEmail(" Anca@Example.COM "), "anca@example.com");
  assert.equal(c.normalizeEmail("anca.example.com"), "");
  assert.deepEqual(c.cleanLabels(["Close  Friends", "close friends", "", "Work"]), ["close friends", "work"]);
  assert.ok(c.samePhone("0722123456", "+40722123456"));
  assert.ok(!c.samePhone("0722123456", "0722123457"));
});

test("saying more about someone adds to their card; remove takes off", () => {
  assert.deepEqual(anca.labels, ["family"]);
  const more = c.merge(anca, { phones: ["+40722123456", "0744000111"], labels: ["close friends"] });
  assert.deepEqual(more.phones, ["0722123456", "0744000111"], "the same number in another form isn't added twice");
  assert.deepEqual(more.emails, ["anca@example.com"], "an update that doesn't mention the email keeps it");
  assert.deepEqual(more.labels, ["family", "close friends"]);
  assert.equal(more.relation, "wife");
  const less = c.merge(more, { remove: { phones: ["+40 722 123 456"], labels: ["Close Friends"] } });
  assert.deepEqual(less.phones, ["0744000111"]);
  assert.deepEqual(less.labels, ["family"]);
});

test("the same person is found again, not added twice", () => {
  const plumber = c.merge({ ...blank, contact_id: "c_2" }, { name: "Ion", relation: "plumber", phones: ["0733000222"], labels: ["services"] });
  const cards = [anca, plumber];
  assert.equal(c.findSame(cards, { name: "x", phones: ["+40733000222"] })?.contact_id, "c_2");
  assert.equal(c.findSame(cards, { emails: ["ANCA@example.com"] })?.contact_id, "c_1");
  assert.equal(c.findSame(cards, { name: "anca ripa" })?.contact_id, "c_1");
  assert.equal(c.findSame(cards, { name: "Anca" }), undefined, "a first name alone isn't enough to merge");
});

test("looked up by name, relation, label, number or address", () => {
  assert.ok(c.match(anca, "wife") > 0);
  assert.ok(c.match(anca, "Anca") > 0);
  assert.ok(c.match(anca, "family") > 0);
  assert.equal(c.match(anca, "+40 722 123 456"), 100);
  assert.equal(c.match(anca, "anca@example"), 100);
  assert.equal(c.match(anca, "plumber"), 0);
  assert.equal(c.match(anca, ""), 1, "no words: everyone");
});

test("the list in front of the model has who and labels, never numbers", () => {
  const brief = c.briefLines([anca], 41);
  assert.match(brief, /Anca Ripa — wife \[family\]/);
  assert.doesNotMatch(brief, /0722|anca@/);
  assert.match(brief, /and 40 more/);
  assert.equal(c.briefLines([], 0), "");
});

test("an address book is only ever its owner's: refused for a group id, and walled from a group", async () => {
  await assert.rejects(() => c.find(G, "anca"), /own private chat/);
  await assert.rejects(() => c.save(G, { name: "x" }), /own private chat/);
  await assert.rejects(() => c.remove(G, "c_1"), /own private chat/);
  assert.match(wall.refuse(G, "Contact", { chat_id: G }), /never read from a group/);
  assert.match(wall.refuse(G, "Contact", { chat_id: ME }), /never read from a group|private chat/);
});
