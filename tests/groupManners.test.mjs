// How Gepetel behaves as the new member of somebody else's group.
//
// Every case here is from one family group (2026-11-18/19) that told him, a day
// after he was added, "there's no need for you here". Nothing he did wrong
// there was exotic: he talked too much, signed every line with the same emoji,
// kept using a character he had been asked three times to stop using, answered
// lines that were not for him, and did not know two facts about himself that
// the code knew exactly. These are the parts that are no longer left to a
// prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
const u = (await import("../dist/util.js")).default;

test("long dashes never leave, however the model wrote them", () => {
  assert.equal(u.plainDashes("תודה על האדד, חברים — נראה שכאן"), "תודה על האדד, חברים - נראה שכאן");
  assert.equal(u.plainDashes("You’re right—I didn’t"), "You’re right - I didn’t");
  assert.equal(u.plainDashes("cina 300 lei — Bogdan a plătit"), "cina 300 lei - Bogdan a plătit");
  assert.equal(u.plainDashes("12:00–12:30, 4–6 sept"), "12:00-12:30, 4-6 sept");
  assert.equal(u.plainDashes("— Bună"), "- Bună", "a line that opens with one");
  assert.equal(u.cleanWhatsAppText("gata — am pus"), "gata - am pus", "and the send path uses it");
});

test("what is not a long dash is left alone", () => {
  assert.equal(u.plainDashes("ב־48 השעות, well-known, 2026-11-18"), "ב־48 השעות, well-known, 2026-11-18");
  assert.equal(u.plainDashes("```a — b```"), "```a — b```", "a code block is somebody's text, not his prose");
});

test("the emoji from his last line does not go out again", () => {
  assert.equal(u.dropRepeatedEmoji("תבקש מדן את הכפתור 😌", "אפס 😌"), "תבקש מדן את הכפתור");
  // The reply that agreed to stop, signed with the thing it agreed to stop.
  assert.equal(u.dropRepeatedEmoji("צודק. בלי מקפים ארוכים, ועם פחות 😌. נרשם.", "מגוון 😌"), "צודק. בלי מקפים ארוכים, ועם פחות. נרשם.");
  assert.equal(u.dropRepeatedEmoji("gata 😄 și 🍫", "ok 👍"), "gata 😄 și 🍫", "a different one is fine");
  assert.equal(u.dropRepeatedEmoji("ok ❤️", "da ❤"), "ok", "with or without the variation selector");
});

test("a lone emoji is an answer, not decoration, and stays", () => {
  assert.equal(u.dropRepeatedEmoji("👍", "ok 👍"), "👍");
  assert.equal(u.dropRepeatedEmoji("salut", ""), "salut");
});

test("a quote of his line that tags somebody else is said to them", () => {
  assert.equal(u.addressedToSomeoneElse("@דן לוי"), true);
  assert.equal(u.addressedToSomeoneElse("@Dan what is this"), true);
  assert.equal(u.addressedToSomeoneElse("@gepetel תרגיע אותה"), false);
  assert.equal(u.addressedToSomeoneElse("@Dan ask @gepetel"), false, "his name anywhere in it is still a summons");
  assert.equal(u.addressedToSomeoneElse("write to a@b.c"), false, "an address is not a tag");
  assert.equal(u.addressedToSomeoneElse("how much did Dan pay?"), false);
});

test("a laugh closes an exchange; it does not ask for another line", () => {
  for (const s of ["אההה.. חחח", "🤣🤣🤣🤣", "haha", "hahaha lol", "חחחח", "jajaja", ":))", "=)))"]) assert.equal(u.onlyALaugh(s), true, s);
  // Short is not the same as empty: these are words, and may be an answer.
  for (const s of ["רקקק??😂", "טוב", "כן", "ok", "what?", "מה?", "7 הודעות", "da", ""]) assert.equal(u.onlyALaugh(s), false, s);
});

test("five lines of his in ten minutes, and only his name wakes him", () => {
  assert.equal(u.overTalking(4), false);
  assert.equal(u.overTalking(5), true);
  assert.equal(u.BURST_WINDOW_MS, 10 * 60 * 1000);
});

test("he is told what he can have seen, and since when", () => {
  const now = new Date("2026-11-19T12:35:00Z");
  const s = u.groupStanding({ addedAt: new Date("2026-11-18T12:52:00Z"), dailyReplyCount: 0, dailyReplyLimit: 20, dailyResetDate: "2026-11-19" }, now);
  assert.match(s, /joined this group 24 hours ago \(2026-11-18\)/);
  assert.match(s, /ONLY what was written here since then/);
  assert.match(s, /never answer about "the last month"/);
});

test("he is told how many replies he has left, because he does have a counter", () => {
  const now = new Date("2026-11-18T14:03:00Z");
  const s = u.groupStanding({ addedAt: new Date("2026-11-18T12:52:00Z"), dailyReplyCount: 17, dailyReplyLimit: 20, dailyResetDate: "2026-11-18" }, now);
  assert.match(s, /Replies left today in this group: 3 of 20/);
  assert.match(s, /real counter/);
  assert.match(s, /nearly out/);
  // Yesterday's count is not today's.
  assert.match(u.groupStanding({ dailyReplyCount: 20, dailyReplyLimit: 20, dailyResetDate: "2026-11-17" }, now), /left today in this group: 20 of 20/);
  assert.doesNotMatch(u.groupStanding({ dailyReplyCount: 2, dailyReplyLimit: 20, dailyResetDate: "2026-11-18" }, now), /nearly out/);
});

test("he is the new one for three days", () => {
  const now = new Date("2026-11-20T00:00:00Z");
  assert.equal(u.isNewcomer(new Date("2026-11-18T12:52:00Z"), now), true);
  assert.equal(u.isNewcomer(new Date("2026-11-10T12:52:00Z"), now), false);
  assert.equal(u.isNewcomer(null, now), false, "a group from before this was recorded is not new");
});

// The prompts that carry the rest. These are not style checks: each asserted
// phrase is the instruction whose absence produced a specific line in that group.
const prompts = (await import("../dist/prompts.js")).default;
test("the group prompt lets him say nothing, which it never used to mention", () => {
  const p = prompts.loadPrompt("group-reply", { groupname: "x", numberofparticipants: "3", pollvotes: "" });
  assert.match(p, /`no answer`/);
  assert.match(p, /tagging ANOTHER member/);
  assert.match(p, /set_house_rule/);
  assert.match(p, /NEVER tell the group what they should or shouldn't share/);
  assert.match(p, /privacy\.html/);
});

test("the greeting says what he is, and leaves a group's own dark joke alone", () => {
  const p = prompts.loadPrompt("group-greeting", { groupname: "x", language: "Hebrew" });
  assert.match(p, /an AI assistant/);
  assert.match(p, /war, alarms, illness/);
  assert.match(p, /No emoji/);
});

test("the voice does not decide the language", () => {
  assert.match(prompts.loadPrompt("voice"), /NOTHING about which language to write in/);
  assert.match(prompts.loadPrompt("daily-limit", { language: "Hebrew" }), /language of the group's last lines/);
});
