// How Gepetel behaves in private chats when nobody asked him anything.
//
// From sixteen real conversations over a month (2026-10/11). The replies were
// mostly fine; what went wrong was nearly all in what he sent on his own, and
// in a few seconds of impatience:
//  - of 18 "how did it go?" messages, 5 were answered (3 in one word); three
//    people never wrote again after one, and one answered "drop the small
//    talk and fix the thing I asked for";
//  - a bare photo was answered at once, in English, to people who write
//    Romanian, and then answered again when their question arrived;
//  - asked to connect a mailbox, he sent four messages in one minute, each
//    with a new link;
//  - told he had a reminder on the wrong day, he said he had corrected it and
//    had called nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
const u = (await import("../dist/util.js")).default;

test("a machine's description of a picture is not their words", () => {
  assert.equal(u.ownWords("[image] Photo: A close-up photograph of a black plastic crate"), "");
  assert.equal(u.ownWords("Asta e programul\n[image] Schedule screenshot: **Visible device/UI text** - Time"), "Asta e programul");
  assert.equal(u.ownWords("Ce faci?"), "Ce faci?");
  // Stored before the mark existed: a tag line, then a long listing.
  const old = "Screenshot: A WhatsApp chat screen on an iPhone, in portrait orientation. ## Status bar and chat header - Top-left time: `22:16` - Top-right: - Cellular signal-strength icon - `5G` - Battery icon, partially filled yellow";
  assert.equal(u.ownWords(old), "");
  // A long message of their own that happens to open with a label is theirs.
  const theirs = "Mesaj: " + "vreau sa ii spun doamnei ca Stefan nu vine azi la scoala pentru ca nu se simte bine ".repeat(3);
  assert.equal(u.ownWords(theirs), theirs);
});

test("their language is read from what THEY wrote, not from a picture's description", () => {
  const ro = "40766000171@s.whatsapp.net";
  // Newest first: a bare photo, then her Romanian.
  assert.equal(u.conversationLanguage(["[image] Photo: I see the crate filled with colorful pumpkins and gourds on the table", "Si la final putem sa facem o degustare"], ro), "Romanian");
  assert.equal(u.conversationLanguage(["[image] Photo: the crate and the table, with what you need for it"], ro), "Romanian", "nothing of theirs to go on: the number's country");
  assert.equal(u.conversationLanguage(["What do you use this document for?", "[image] Photo: x"], ro), "English", "and English when that is what they write");
});

test("he does not come back to the same thing twice, however it is worded", () => {
  const already = ["cum a fost activitatea Copacul toamnei de pe 11 noiembrie"];
  assert.equal(u.sameSubject("Cum a fost activitatea „Copacul toamnei”? Și cum s-a descurcat Ștefan?", already), true);
  assert.equal(u.sameSubject("cum a mers schimbarea ochelarilor și returul primei perechi", ["Cum a fost schimbarea ochelarilor și returul primei perechi?"]), true);
  assert.equal(u.sameSubject("cum a mers interviul de la bancă", already), false);
  assert.equal(u.sameSubject("cum a fost", already), false, "too little to call it the same");
  assert.equal(u.sameSubject("cum a mers interviul", []), false);
});

test("an ignored nudge buys a long pause, and the pause grows", () => {
  const day = 24 * 3600_000;
  assert.equal(u.followUpHoldMs(0), 4 * day, "even an answered one is not followed by another the next day");
  assert.equal(u.followUpHoldMs(1), 14 * day);
  assert.equal(u.followUpHoldMs(2), 45 * day);
  assert.equal(u.followUpHoldMs(3), 120 * day);
  assert.equal(u.followUpHoldMs(9), 120 * day);
});

const prompts = (await import("../dist/prompts.js")).default;
test("the prompts carry what the code cannot", () => {
  const decide = prompts.loadPrompt("follow-up-decide", { author: "Ana" });
  assert.match(decide, /reference desk/);
  assert.match(decide, /anything about HIM or about using him/);
  assert.match(decide, /an errand read off a lookup/);
  const write = prompts.loadPrompt("follow-up", { memberName: "Ana", about: "x", lastLine: "y", language: "Romanian" });
  assert.match(write, /The language is Romanian/);
  assert.match(write, /You are writing AFTER the thing/);
  const dm = prompts.loadPrompt("dm", { author: "Ana", groups: "", userId: "x", botPhone: "y" });
  assert.match(dm, /read back EVERY one/);
  assert.match(dm, /`\[image\]` starts what a MACHINE saw/);
  assert.match(dm, /contains only what they told you/);
  const pulse = prompts.loadPrompt("pulse-think", { name: "Ana", mode: "", language: "Romanian" });
  assert.match(pulse, /anything about YOU/);
  assert.match(pulse, /lead with the EARLIEST/);
  const stall = prompts.loadPrompt("announces-work");
  assert.match(stall, /doing, done or no/);
  assert.match(stall, /IS a text written for them to send to someone else/);
});

// "Tomorrow you have an evening dance class, 20:00–21:00. Still going?" — sent to
// someone with no such plan. The company CRM was connected with a colleague's
// login, the CRM syncs her whole calendar, and her evening class was read as
// his. A service signed in as someone else shows what needs THAT person.
test("a service signed in as somebody else is recognised as such", () => {
  const labels = ["Computer", "Gmail (dan.pop@example.org)", "Google Calendar (dan.pop@example.org)", "Acme CRM (maria@example.com)", "Gmail (dan@example.com)", "Google Calendar (work)"];
  const own = u.ownAddressesFrom(labels);
  assert.deepEqual(own.sort(), ["dan.pop@example.org", "dan@example.com"]);
  assert.equal(u.someoneElsesLogin("Acme CRM (maria@example.com)", own, "Dan Pop"), true);
  assert.equal(u.someoneElsesLogin("Gmail (dan@example.com)", own, "Dan Pop"), false, "his own mailbox");
  assert.equal(u.someoneElsesLogin("Google Calendar (work)", own, "Dan Pop"), false, "no account in the label: nothing to say");
  assert.equal(u.someoneElsesLogin("Trello", own, "Dan Pop"), false);
});

test("their own other addresses are not mistaken for someone else", () => {
  const own = ["ana.pop@gmail.com"];
  assert.equal(u.someoneElsesLogin("Trello (ana@firma.ro)", own, "Ana Pop"), false, "her work address: the name is hers");
  assert.equal(u.someoneElsesLogin("Jira (apop@firma.ro)", own, "Ana Pop"), false, "an initial and a surname");
  assert.equal(u.someoneElsesLogin("Notion (anapop@firma.ro)", [], "Ana Pop"), false);
  assert.equal(u.someoneElsesLogin("Trello (office@firma.ro)", own, "Ana Pop"), false, "a role address is nobody's in particular");
  assert.equal(u.someoneElsesLogin("Trello (mihai@firma.ro)", own, "Ana Pop"), true);
  assert.equal(u.accountIn("Gmail (Ana@Firma.ro)"), "ana@firma.ro");
});

test("the check-ins are told whose plans count", () => {
  const look = prompts.loadPrompt("pulse-look", { name: "Ana", services: "Gmail", own: "ana@x.ro", since: "now" });
  assert.match(look, /Their own addresses are: ana@x\.ro/);
  assert.match(look, /Never describe someone else's appointment as theirs/);
  assert.match(prompts.loadPrompt("pulse-think", { name: "Ana", mode: "", language: "Romanian" }), /someone else's plan/);
});
