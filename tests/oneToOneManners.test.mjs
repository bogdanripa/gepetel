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
  assert.match(dm, /the system adds the exact list under your message/);
  assert.match(dm, /call look_at_picture with the exact question/);
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

// "How about we continue on a phone call?" — offered when a private chat has
// become a conversation, and only then.
test("a chat is chatty at seven typed lines in ten minutes, or three spoken ones", () => {
  assert.equal(u.chattyEnough({ lines: 7, spoken: 0 }), true);
  assert.equal(u.chattyEnough({ lines: 6, spoken: 0 }), false);
  assert.equal(u.chattyEnough({ lines: 3, spoken: 3 }), true, "three voice notes in a row is someone already talking");
  assert.equal(u.chattyEnough({ lines: 2, spoken: 2 }), false);
  assert.equal(u.CHATTY_WINDOW_MS, 10 * 60 * 1000);
  assert.equal(u.CALL_OFFER_EVERY_MS, 14 * 24 * 3600 * 1000, "and not offered again for two weeks");
});

test("the offer answers first, gives the number, and leaves drafting alone", () => {
  const note = prompts.loadPrompt("call-offer", { lines: "8", spoken: ", 3 of them spoken", number: "+40750271099", minutes: "5" });
  assert.match(note, /8 messages from them in the last ten minutes, 3 of them spoken/);
  assert.match(note, /first answer what they just asked/);
  assert.match(note, /\+40750271099/);
  assert.match(note, /something to copy or keep/);
  assert.match(note, /An offer, never a redirect/);
});

// What was set is read back from what the tool returned, not from his summary.
test("several reminders set at once come back as a list, weekday first", () => {
  const out = u.reminderReceipt([
    { at: new Date("2026-11-21T08:00:00Z"), what: "Tenisul Anei la Ilinca" },
    { at: new Date("2026-11-20T14:00:00Z"), what: "Artele Anei" },
  ], "Europe/Bucharest", "Romanian");
  const lines = out.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^⏰ vin\., 20 nov\., 16:00 · Artele Anei$/, "earliest first, in their clock");
  assert.match(lines[1], /^⏰ sâm\., 21 nov\., 10:00 · Tenisul Anei la Ilinca$/, "the weekday is what shows a day off by one");
});

test("one reminder needs no list, and an unknown language still gets one", () => {
  assert.equal(u.reminderReceipt([{ at: new Date("2026-11-21T08:00:00Z"), what: "x" }], "Europe/Bucharest", "Romanian"), "");
  assert.equal(u.reminderReceipt([], "UTC"), "");
  assert.match(u.reminderReceipt([{ at: new Date("2026-11-21T08:00:00Z"), what: "a" }, { at: new Date("2026-11-22T08:00:00Z"), what: "b" }], "UTC", "Klingon"), /^⏰ Sat,? 21 Nov,? 08:00 · a\n⏰ Sun,? 22 Nov,? 08:00 · b$/);
});

// "Call me at 9 to …" (2026-11-23): a reminder can be a phone call, and
// "call me" rings them now. Only ever the number of the chat that asked.
test("a reminder by phone and 'call me now': the tools exist and the prompt tells them apart", async () => {
  process.env.OPENAI_API_KEY ||= "test-not-a-key";
  const fs = await import("node:fs");
  const kit = (await import("../dist/oai.js")).replayKit();
  const set = kit.dm.find(t => t.name === "set_reminder");
  assert.equal(set.parameters.properties.by_call.type, "boolean");
  assert.match(set.parameters.properties.by_call.description, /sună-mă la 9/);
  assert.match(set.parameters.properties.by_call.description, /Never true for an ordinary/);
  assert.ok(!set.parameters.required.includes("by_call"));
  const now = kit.dm.find(t => t.name === "call_me_now");
  assert.ok(now, "call_me_now is a 1:1 tool");
  assert.match(now.description, /Never for calling someone else/);
  const dm = fs.readFileSync(new URL("../prompts/dm.txt", import.meta.url), "utf8");
  assert.match(dm, /by_call true/);
  assert.match(dm, /don't phone people who asked for a message/);
  assert.match(dm, /You can only ever ring the number they are writing from/);
});
