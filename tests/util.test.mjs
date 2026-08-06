// Unit tests for the pure helpers in src/util.ts (compiled to dist/util.js).
// No DB, no network — run anywhere: `node --test tests/util.test.mjs`
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import u from "../dist/util.js";

describe("isGroupChatId", () => {
  test("true for a group jid", () => {
    assert.equal(u.isGroupChatId("120363012345678901@g.us"), true);
    assert.equal(u.isGroupChatId("12345-67890@g.us"), true);
  });
  test("false for 1:1, empty, malformed", () => {
    assert.equal(u.isGroupChatId("40712345678@s.whatsapp.net"), false);
    assert.equal(u.isGroupChatId(""), false);
    assert.equal(u.isGroupChatId("notagroup"), false);
    assert.equal(u.isGroupChatId("40712345678@g.us".replace("@g.us", "@s.whatsapp.net")), false);
  });
});

describe("normalizeMentions / isMentioned", () => {
  test("raw bot jids become @gepetel", () => {
    assert.match(u.normalizeMentions("hey @279697464266959 yo"), /@gepetel/);
    assert.match(u.normalizeMentions("hey @+40750271099 yo"), /@gepetel/);
  });
  test("isMentioned wakes on his name with or without @", () => {
    assert.equal(u.isMentioned("yo @gepetel help"), true);
    assert.equal(u.isMentioned("yo @Gepetel help"), true);
    assert.equal(u.isMentioned("hey gepetel what's up"), true);   // no @ needed
    assert.equal(u.isMentioned("GEPETEL?"), true);
    assert.equal(u.isMentioned("@279697464266959 ping"), true);
    assert.equal(u.isMentioned("no mention here"), false);
    assert.equal(u.isMentioned("telegepetelish"), false);          // word-boundary, not substring
    assert.equal(u.isMentioned(""), false);
  });
});

describe("cleanWhatsAppText", () => {
  test("markdown link -> bare url", () => {
    assert.equal(u.cleanWhatsAppText("see [ITV](https://itv.com/x)"), "see https://itv.com/x");
  });
  test("strips utm_source=openai", () => {
    assert.equal(u.cleanWhatsAppText("https://x.com/a?utm_source=openai"), "https://x.com/a");
    assert.equal(u.cleanWhatsAppText("https://x.com/a?utm_source=openai&b=1"), "https://x.com/a?b=1");
  });
  test("** bold ** -> * bold * and headings", () => {
    assert.equal(u.cleanWhatsAppText("**hi**"), "*hi*");
    assert.equal(u.cleanWhatsAppText("# Title"), "*Title*");
  });
  test("plain text untouched, null-safe", () => {
    assert.equal(u.cleanWhatsAppText("just text"), "just text");
    assert.equal(u.cleanWhatsAppText(""), "");
  });
});

describe("cleanUpAnswer", () => {
  test("strips a single pair of surrounding quotes", () => {
    assert.equal(u.cleanUpAnswer('"hello"'), "hello");
    assert.equal(u.cleanUpAnswer("hello"), "hello");
    assert.equal(u.cleanUpAnswer('he said "hi"'), 'he said "hi"');
    assert.equal(u.cleanUpAnswer(""), "");
  });
});

describe("parseToolArgs", () => {
  test("object passthrough, json string, garbage -> {}", () => {
    assert.deepEqual(u.parseToolArgs({ a: 1 }), { a: 1 });
    assert.deepEqual(u.parseToolArgs('{"a":1}'), { a: 1 });
    assert.deepEqual(u.parseToolArgs("not json"), {});
    assert.deepEqual(u.parseToolArgs(null), {});
    assert.deepEqual(u.parseToolArgs(undefined), {});
  });
});

describe("inferRegion / inferLanguage", () => {
  test("single-country groups", () => {
    assert.equal(u.inferLanguage(["33612345678", "33698765432"]), "French");
    assert.equal(u.inferRegion(["33612345678"]), "France");
    assert.equal(u.inferLanguage(["40712345678", "40755555555"]), "Romanian");
    assert.equal(u.inferLanguage(["49170111", "49160222"]), "German");
  });
  test("majority wins in a mixed group", () => {
    assert.equal(u.inferLanguage(["33611", "33622", "40733"]), "French");
  });
  test("longest-prefix match (351 Portugal, not a 3x country)", () => {
    assert.equal(u.inferRegion(["351912345678"]), "Portugal");
    assert.equal(u.inferLanguage(["351912345678"]), "Portuguese");
  });
  test("handles @s.whatsapp.net suffix and + prefix", () => {
    assert.equal(u.inferLanguage(["+33612345678@s.whatsapp.net"]), "French");
  });
  test("empty / unknown -> safe defaults", () => {
    assert.equal(u.inferRegion([]), "international");
    assert.equal(u.inferLanguage([]), "English");
    assert.equal(u.inferLanguage(["99988877766"]), "English"); // unknown code
  });
});

describe("inferTimezone / currentTimeString", () => {
  test("dominant phone prefix -> timezone", () => {
    assert.equal(u.inferTimezone(["33612345678", "33698765432"]), "Europe/Paris");
    assert.equal(u.inferTimezone(["40712345678"]), "Europe/Bucharest");
    assert.equal(u.inferTimezone([]), "UTC");
    assert.equal(u.inferTimezone(["99988877766"]), "UTC"); // unknown
  });
  test("current time renders in the right zone (DST-aware)", () => {
    const d = new Date("2026-06-28T17:40:00Z");
    const ro = u.currentTimeString("Europe/Bucharest", d); // UTC+3 in summer
    assert.match(ro, /20:40/);
    assert.match(ro, /Europe\/Bucharest/);
    const ny = u.currentTimeString("America/New_York", d); // UTC-4 in summer
    assert.match(ny, /13:40/);
  });
  test("invalid timezone falls back without throwing", () => {
    assert.match(u.currentTimeString("Not/AZone", new Date("2026-06-28T17:40:00Z")), /UTC/);
  });
});

describe("stripBot", () => {
  test("removes Gepetel's own numbers, keeps members", () => {
    const out = u.stripBot(["40750271099", "279697464266959", "33612345678"]);
    assert.deepEqual(out, ["33612345678"]);
  });
  test("inference ignores the bot's Romanian number", () => {
    // A French group where the bot (RO) is a participant must still read as French.
    const members = u.stripBot(["40750271099", "33611", "33622"]);
    assert.equal(u.inferLanguage(members), "French");
  });
});

describe("activeHoursFromHistogram", () => {
  test("null when empty", () => {
    assert.equal(u.activeHoursFromHistogram({}), null);
    assert.equal(u.activeHoursFromHistogram(null), null);
  });
  test("peak / top / counts", () => {
    const a = u.activeHoursFromHistogram({ 9: 5, 10: 8, 11: 4 });
    assert.equal(a.total, 17);
    assert.equal(a.peakHourUTC, 10);
    assert.equal(a.counts.length, 24);
    assert.equal(a.topHoursUTC[0], 10);
    assert.deepEqual(a.topHoursUTC, [10, 9, 11]);
  });
  test("circular median handles midnight wraparound", () => {
    // Activity clustered around 22,23,0,1 — median should land in that cluster, not ~12.
    const a = u.activeHoursFromHistogram({ 22: 5, 23: 10, 0: 10, 1: 5 });
    assert.ok([22, 23, 0, 1].includes(a.medianHourUTC), `median ${a.medianHourUTC}`);
  });
});

describe("pickSendHourUTC", () => {
  const group = { activityByHour: { 9: 5, 10: 8, 11: 4 }, addedAt: new Date("2026-01-01T19:00:00Z") };
  test("deterministic with injected rng; stays in active hours", () => {
    assert.equal(u.pickSendHourUTC(group, () => 0), 9);    // pool [9,10], index 0
    assert.equal(u.pickSendHourUTC(group, () => 0.99), 10); // pool [9,10], index 1
  });
  test("no histogram -> falls back to added hour", () => {
    assert.equal(u.pickSendHourUTC({ addedAt: new Date("2026-01-01T19:00:00Z") }, () => 0), 19);
  });
  test("never returns a dead (zero-activity) hour", () => {
    const g = { activityByHour: { 3: 1, 10: 50, 11: 40 } }; // 3am is noise
    for (let i = 0; i < 50; i++) {
      const h = u.pickSendHourUTC(g, Math.random);
      assert.ok(h !== 3, `picked dead hour ${h}`);
    }
  });
});

describe("computeNextUnpromptedAt", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const group = { activityByHour: { 9: 5, 10: 8, 11: 4 }, addedAt: now };
  test("deterministic with injected now+rng", () => {
    const d = u.computeNextUnpromptedAt(group, now, () => 0); // days=3, hour=9, min=0
    assert.equal(d.getUTCDate(), 4);
    assert.equal(d.getUTCHours(), 9);
    assert.ok(d > now);
  });
  test("cooldown is always 3..6 days out", () => {
    for (let i = 0; i < 100; i++) {
      const d = u.computeNextUnpromptedAt(group, now, Math.random);
      const days = Math.round((d.getTime() - now.getTime()) / 86400000);
      assert.ok(days >= 3 && days <= 6, `days=${days}`);
    }
  });
});

describe("htmlToText", () => {
  test("strips tags, scripts, styles and decodes entities", () => {
    const html = "<html><head><style>.x{}</style><script>bad()</script></head><body><h1>Title</h1><p>Hello &amp; welcome</p></body></html>";
    const out = u.htmlToText(html);
    assert.match(out, /Title/);
    assert.match(out, /Hello & welcome/);
    assert.doesNotMatch(out, /bad\(\)/);
    assert.doesNotMatch(out, /<[^>]+>/);
  });
  test("truncates very long content", () => {
    const out = u.htmlToText("x".repeat(20000), 100);
    assert.ok(out.length <= 120);
    assert.match(out, /truncated/);
  });
});

describe("splitBill", () => {
  test("even split by head count", () => {
    const r = u.splitBill({ total: 100, people: 4 });
    assert.equal(r.per_person, 25);
    assert.equal(r.count, 4);
  });
  test("tip is applied before splitting", () => {
    const r = u.splitBill({ total: 100, people: 2, tip_percent: 10 });
    assert.equal(r.effective_total, 110);
    assert.equal(r.per_person, 55);
  });
  test("names drive the count and per-name breakdown", () => {
    const r = u.splitBill({ total: 90, names: ["Ana", "Bo", "Cri"], currency: "RON" });
    assert.equal(r.count, 3);
    assert.equal(r.per_person, 30);
    assert.equal(r.per_named.length, 3);
    assert.equal(r.currency, "RON");
  });
  test("rounds to 2 decimals", () => {
    assert.equal(u.splitBill({ total: 100, people: 3 }).per_person, 33.33);
  });
  test("rejects bad input", () => {
    assert.throws(() => u.splitBill({ total: 0, people: 2 }));
    assert.throws(() => u.splitBill({ total: 50, people: 0 }));
  });
});

describe("nextOccurrence", () => {
  const base = new Date("2026-01-31T09:00:00Z");
  test("daily / weekly add days", () => {
    assert.equal(u.nextOccurrence(base, "daily").toISOString(), "2026-02-01T09:00:00.000Z");
    assert.equal(u.nextOccurrence(new Date("2026-01-01T09:00:00Z"), "weekly").toISOString(), "2026-01-08T09:00:00.000Z");
  });
  test("monthly advances the month", () => {
    const d = u.nextOccurrence(new Date("2026-01-15T09:00:00Z"), "monthly");
    assert.equal(d.getUTCMonth(), 1); // February
  });
  test("rejects unknown recurrence", () => {
    assert.throws(() => u.nextOccurrence(base, "yearly"));
  });
});

describe("replyGateDecision", () => {
  test("1:1 always replies", () => {
    assert.equal(u.replyGateDecision({ isGroupMessage: false, mentioned: false, gapMs: 1e9 }).decision, "reply");
  });
  test("explicit mention always replies", () => {
    assert.equal(u.replyGateDecision({ isGroupMessage: true, mentioned: true, gapMs: 1e9 }).decision, "reply");
  });
  test("recent reply -> consult gatekeeper", () => {
    const g = u.replyGateDecision({ isGroupMessage: true, mentioned: false, gapMs: 60 * 1000 });
    assert.equal(g.decision, "consult");
    assert.equal(g.consultGatekeeper, true);
  });
  test("outside the window -> silent, no model call", () => {
    const g = u.replyGateDecision({ isGroupMessage: true, mentioned: false, gapMs: 60 * 60 * 1000 });
    assert.equal(g.decision, "silent");
    assert.equal(g.consultGatekeeper, false);
  });
  test("continuation window is 5 minutes", () => {
    assert.equal(u.CONTINUATION_WINDOW_MS, 5 * 60 * 1000);
    assert.equal(u.replyGateDecision({ isGroupMessage: true, mentioned: false, gapMs: 4 * 60 * 1000 }).decision, "consult");
    assert.equal(u.replyGateDecision({ isGroupMessage: true, mentioned: false, gapMs: 6 * 60 * 1000 }).decision, "silent");
  });
});

describe("localParts", () => {
  test("reads calendar parts in the target timezone, not UTC", () => {
    // 2026-02-04 is a Wednesday. Bucharest is UTC+2 in winter.
    const p = u.localParts(new Date("2026-02-04T07:30:00Z"), "Europe/Bucharest");
    assert.equal(p.hour, 9);
    assert.equal(p.weekday, 3);          // Wednesday
    assert.equal(p.ymd, "2026-02-04");
  });
  test("follows DST — same local hour, different UTC hour", () => {
    // Winter (UTC+2) vs summer (UTC+3): 09:00 local is 07:00Z then 06:00Z.
    assert.equal(u.localParts(new Date("2026-02-04T07:00:00Z"), "Europe/Bucharest").hour, 9);
    assert.equal(u.localParts(new Date("2026-07-01T06:00:00Z"), "Europe/Bucharest").hour, 9);
  });
  test("local midnight rolls the date and the weekday", () => {
    const p = u.localParts(new Date("2026-02-04T22:00:00Z"), "Europe/Bucharest");
    assert.equal(p.hour, 0);             // not 24
    assert.equal(p.ymd, "2026-02-05");
    assert.equal(p.weekday, 4);          // Thursday
  });
  test("unknown timezone falls back to UTC instead of throwing", () => {
    const p = u.localParts(new Date("2026-02-04T07:30:00Z"), "Not/AZone");
    assert.equal(p.hour, 7);
    assert.equal(p.ymd, "2026-02-04");
  });
});

describe("isTaskDue", () => {
  const workdays9 = { hour_local: 9, days_of_week: [1, 2, 3, 4, 5], timezone: "Europe/Bucharest" };
  const wed0900 = new Date("2026-02-04T07:00:00Z");   // Wed 09:00 local
  test("fires on a matching weekday and hour", () => {
    assert.equal(u.isTaskDue(workdays9, wed0900), true);
  });
  test("does not fire in the wrong hour", () => {
    assert.equal(u.isTaskDue(workdays9, new Date("2026-02-04T08:00:00Z")), false);  // 10:00 local
    assert.equal(u.isTaskDue(workdays9, new Date("2026-02-04T06:00:00Z")), false);  // 08:00 local
  });
  test("does not fire on an excluded weekday", () => {
    assert.equal(u.isTaskDue(workdays9, new Date("2026-02-07T07:00:00Z")), false);  // Saturday
    assert.equal(u.isTaskDue(workdays9, new Date("2026-02-08T07:00:00Z")), false);  // Sunday
  });
  test("still fires at 09:00 local after the DST shift", () => {
    // Wed 2026-07-01, summer (UTC+3): 09:00 local is 06:00Z.
    assert.equal(u.isTaskDue(workdays9, new Date("2026-07-01T06:00:00Z")), true);
    assert.equal(u.isTaskDue(workdays9, new Date("2026-07-01T07:00:00Z")), false);
  });
  test("already fired this local hour -> not due again (cron retry safety)", () => {
    const fired = { ...workdays9, last_fired_at: new Date("2026-02-04T07:05:00Z") };
    assert.equal(u.isTaskDue(fired, wed0900), false);
  });
  test("fired yesterday in the same hour -> due again today", () => {
    const fired = { ...workdays9, last_fired_at: new Date("2026-02-03T07:05:00Z") };
    assert.equal(u.isTaskDue(fired, wed0900), true);
  });
  test("inactive, empty days, or out-of-range hour never fire", () => {
    assert.equal(u.isTaskDue({ ...workdays9, active: false }, wed0900), false);
    assert.equal(u.isTaskDue({ ...workdays9, days_of_week: [] }, wed0900), false);
    assert.equal(u.isTaskDue({ ...workdays9, hour_local: 25 }, wed0900), false);
    assert.equal(u.isTaskDue({ ...workdays9, hour_local: -1 }, wed0900), false);
  });
  test("a garbage last_fired_at doesn't block the task forever", () => {
    const fired = { ...workdays9, last_fired_at: "not-a-date" };
    assert.equal(u.isTaskDue(fired, wed0900), true);
  });
});

describe("normalizeDaysOfWeek", () => {
  test("accepts numbers, names and shorthands", () => {
    assert.deepEqual(u.normalizeDaysOfWeek([1, 2, 3, 4, 5]), [1, 2, 3, 4, 5]);
    assert.deepEqual(u.normalizeDaysOfWeek(["Mon", "wednesday", "FRI"]), [1, 3, 5]);
    assert.deepEqual(u.normalizeDaysOfWeek("weekdays"), [1, 2, 3, 4, 5]);
    assert.deepEqual(u.normalizeDaysOfWeek(["weekend"]), [0, 6]);
    assert.deepEqual(u.normalizeDaysOfWeek(["daily"]), [0, 1, 2, 3, 4, 5, 6]);
  });
  test("sorts and de-duplicates", () => {
    assert.deepEqual(u.normalizeDaysOfWeek([5, 1, 1, "mon", 3]), [1, 3, 5]);
  });
  test("throws when nothing usable is left", () => {
    assert.throws(() => u.normalizeDaysOfWeek([]));
    assert.throws(() => u.normalizeDaysOfWeek(["nonsense"]));
    assert.throws(() => u.normalizeDaysOfWeek([9, -2]));
  });
});

describe("describeSchedule", () => {
  const tz = "Europe/Bucharest";
  test("names the common patterns", () => {
    assert.equal(u.describeSchedule({ hour_local: 9, days_of_week: [1,2,3,4,5], timezone: tz }),
      "every workday at 09:00 (Europe/Bucharest)");
    assert.equal(u.describeSchedule({ hour_local: 0, days_of_week: [0,1,2,3,4,5,6], timezone: tz }),
      "every day at 00:00 (Europe/Bucharest)");
    assert.equal(u.describeSchedule({ hour_local: 11, days_of_week: [0,6], timezone: tz }),
      "every weekend at 11:00 (Europe/Bucharest)");
  });
  test("lists days otherwise", () => {
    assert.equal(u.describeSchedule({ hour_local: 18, days_of_week: [2,4], timezone: tz }),
      "Tue, Thu at 18:00 (Europe/Bucharest)");
  });
});

describe("validateTaskPayload", () => {
  test("text: trims and requires content", () => {
    assert.deepEqual(u.validateTaskPayload("text", { text: "  standup time  " }), { text: "standup time" });
    assert.throws(() => u.validateTaskPayload("text", { text: "   " }), /needs payload.text/);
    assert.throws(() => u.validateTaskPayload("text", {}), /needs payload.text/);
  });
  test("poll: needs a question and 2+ distinct options", () => {
    assert.deepEqual(
      u.validateTaskPayload("poll", { question: " Lunch? ", options: [" Pizza ", "Sushi", ""], allow_multiple: 1 }),
      { question: "Lunch?", options: ["Pizza", "Sushi"], allow_multiple: true }
    );
    assert.throws(() => u.validateTaskPayload("poll", { options: ["a", "b"] }), /needs payload.question/);
    assert.throws(() => u.validateTaskPayload("poll", { question: "q", options: ["only"] }), /at least 2 distinct/);
    assert.throws(() => u.validateTaskPayload("poll", { question: "q", options: ["a", "a"] }), /at least 2 distinct/);
  });
  test("poll: rejects more options than WhatsApp allows", () => {
    const many = Array.from({ length: u.MAX_POLL_OPTIONS + 1 }, (_, i) => `opt${i}`);
    assert.throws(() => u.validateTaskPayload("poll", { question: "q", options: many }), /at most 12 options/);
    const max = many.slice(0, u.MAX_POLL_OPTIONS);
    assert.equal(u.validateTaskPayload("poll", { question: "q", options: max }).options.length, u.MAX_POLL_OPTIONS);
  });
  test("generated needs an instruction", () => {
    assert.deepEqual(u.validateTaskPayload("generated", { instruction: " tell a joke " }),
      { instruction: "tell a joke", web_search: false });
    assert.deepEqual(u.validateTaskPayload("generated", { instruction: "f1 news", web_search: 1 }),
      { instruction: "f1 news", web_search: true });
    assert.throws(() => u.validateTaskPayload("generated", {}), /needs payload.instruction/);
    assert.throws(() => u.validateTaskPayload("generated", { instruction: "x".repeat(1001) }), /under 1000/);
  });
  test("unknown kind names the valid ones", () => {
    assert.throws(() => u.validateTaskPayload("carrier-pigeon", {}), /use one of: text, poll, generated/);
  });
});

describe("isParticipant (scheduled-task authorization)", () => {
  const members = ["40711111111@s.whatsapp.net", "40722222222", "+40 733 333 333"];
  test("matches a member in any stored format", () => {
    assert.equal(u.isParticipant(members, "40711111111@s.whatsapp.net"), true);
    assert.equal(u.isParticipant(members, "40711111111"), true);
    assert.equal(u.isParticipant(members, "+40711111111"), true);
    assert.equal(u.isParticipant(members, "40722222222"), true);
    assert.equal(u.isParticipant(members, "40733333333"), true);   // spaces/plus normalized
  });
  test("rejects a non-member", () => {
    assert.equal(u.isParticipant(members, "40799999999"), false);
  });
  test("rejects partial and superstring numbers", () => {
    assert.equal(u.isParticipant(members, "4071111111"), false);    // one digit short
    assert.equal(u.isParticipant(members, "407111111119"), false);  // one digit extra
    assert.equal(u.isParticipant(members, "1111111"), false);       // suffix of a member
    assert.equal(u.isParticipant(["1140722222222"], "40722222222"), false); // prefixed
  });
  test("rejects empty, junk and bad shapes", () => {
    assert.equal(u.isParticipant(members, ""), false);
    assert.equal(u.isParticipant(members, "abc"), false);
    assert.equal(u.isParticipant(members, null), false);
    assert.equal(u.isParticipant([], "40711111111"), false);
    assert.equal(u.isParticipant(null, "40711111111"), false);
    assert.equal(u.isParticipant(undefined, "40711111111"), false);
  });
  test("a regex-flavoured chat id can't widen the match", () => {
    assert.equal(u.isParticipant(members, ".*"), false);
    assert.equal(u.isParticipant(members, "407.*"), false);
  });
});

describe("attributeToScheduler", () => {
  test("a poll gets it in the title — the only text a poll has", () => {
    assert.equal(u.attributeToScheduler("poll", "Ce mancam azi?", "Bogdan"),
      "Ce mancam azi? (via @Bogdan)");
  });
  test("messages get it on its own line", () => {
    assert.equal(u.attributeToScheduler("text", "standup in 5", "Bogdan"),
      "standup in 5\n\n— via @Bogdan");
    assert.equal(u.attributeToScheduler("generated", "o gluma", "Bogdan"),
      "o gluma\n\n— via @Bogdan");
  });
  test("only the first name is used", () => {
    assert.equal(u.attributeToScheduler("poll", "Q?", "Bogdan Ripa"), "Q? (via @Bogdan)");
  });
  test("no name -> no attribution at all (never a dangling 'via @')", () => {
    assert.equal(u.attributeToScheduler("poll", "Q?", ""), "Q?");
    assert.equal(u.attributeToScheduler("poll", "Q?", "   "), "Q?");
    assert.equal(u.attributeToScheduler("poll", "Q?", undefined), "Q?");
    assert.equal(u.attributeToScheduler("text", "hi", null), "hi");
  });
  test("empty text stays empty", () => {
    assert.equal(u.attributeToScheduler("text", "", "Bogdan"), "");
  });
});

describe("isOutOfCredits", () => {
  test("recognises an exhausted balance", () => {
    assert.equal(u.isOutOfCredits({ status: 429, code: "credit_balance_exhausted" }), true);
    assert.equal(u.isOutOfCredits({ status: 429, type: "insufficient_quota" }), true);
    assert.equal(u.isOutOfCredits({ status: 429, error: { code: "insufficient_quota" } }), true);
    assert.equal(u.isOutOfCredits({ status: 429, error: { message: "You have no credits remaining." } }), true);
  });
  test("an ordinary rate limit is NOT out of credits", () => {
    // Same 429, opposite meaning: this clears by itself, so it must stay silent.
    assert.equal(u.isOutOfCredits({ status: 429, code: "rate_limit_exceeded",
      error: { message: "Rate limit reached for gpt-5-mini" } }), false);
  });
  test("other failures are not confused for it", () => {
    assert.equal(u.isOutOfCredits({ status: 500 }), false);
    assert.equal(u.isOutOfCredits({ status: 401, code: "invalid_api_key" }), false);
    assert.equal(u.isOutOfCredits(new Error("socket hang up")), false);
    assert.equal(u.isOutOfCredits(null), false);
    assert.equal(u.isOutOfCredits(undefined), false);
  });
});

describe("outOfCreditsMessage", () => {
  test("speaks the group's language and names the owner", () => {
    assert.match(u.outOfCreditsMessage("Romanian"), /credite/);
    assert.match(u.outOfCreditsMessage("Romanian"), /Bogdan/);
    assert.match(u.outOfCreditsMessage("English"), /credits/);
  });
  test("falls back to English for anything unmapped", () => {
    assert.equal(u.outOfCreditsMessage("Klingon"), u.outOfCreditsMessage("English"));
    assert.equal(u.outOfCreditsMessage(), u.outOfCreditsMessage("English"));
  });
});

describe("stripInternalIds", () => {
  test("removes a mongo id and the parenthetical around it", () => {
    // The exact leak seen in production.
    assert.equal(
      u.stripInternalIds('Am șters pollul "Ce program ai azi?" (ID 6a71f816f1b90eb1fbf8bd8b) nu va mai rula.'),
      'Am șters pollul "Ce program ai azi?" nu va mai rula.'
    );
  });
  test("removes chat jids, group and 1:1", () => {
    assert.equal(u.stripInternalIds('Grup: „Noi 2” (chat_id: 120363392171791536@g.us)'), 'Grup: „Noi 2”');
    assert.equal(u.stripInternalIds('trimit la 40723418290-1523522048@g.us acum'), 'trimit la acum');
    assert.equal(u.stripInternalIds('user 40723418290@s.whatsapp.net'), 'user');
  });
  test("removes a bare id with no label", () => {
    assert.equal(u.stripInternalIds("id is 6a71f816f1b90eb1fbf8bd8b ok"), "id is ok");
  });
  test("leaves ordinary text — including times, dates and hex-ish words — alone", () => {
    const ok = "Poll la 09:00 în fiecare zi lucrătoare, cu un singur răspuns. Costă 264 msgs/zi!";
    assert.equal(u.stripInternalIds(ok), ok);
    assert.equal(u.stripInternalIds("cafea deadbeef face"), "cafea deadbeef face");  // too short to be an id
  });
  test("keeps a payment link intact — that one is meant to be shared", () => {
    const link = "https://gepetel.bogdanripa.com/pay?groupId=x&userId=y";
    assert.equal(u.stripInternalIds(`Poftim: ${link}`), `Poftim: ${link}`);
  });
  test("handles empty and junk input", () => {
    assert.equal(u.stripInternalIds(""), "");
    assert.equal(u.stripInternalIds(null), "");
  });
  test("cleanUpAnswer applies it, so every outgoing message is scrubbed", () => {
    assert.equal(u.cleanUpAnswer('"gata (ID 6a71f816f1b90eb1fbf8bd8b)"'), "gata");
  });
});

describe("one-off scheduling", () => {
  const once = { hour_local: 9, days_of_week: [], timezone: "Europe/Bucharest", run_on_date: "2026-02-04" };
  test("runs on its date, at or after its hour", () => {
    assert.equal(u.isTaskDue(once, new Date("2026-02-04T07:00:00Z")), true);   // 09:00 local
    assert.equal(u.isTaskDue(once, new Date("2026-02-04T12:00:00Z")), true);   // 14:00, missed hour
  });
  test("not before its hour, and never on another day", () => {
    assert.equal(u.isTaskDue(once, new Date("2026-02-04T05:00:00Z")), false);  // 07:00 local
    assert.equal(u.isTaskDue(once, new Date("2026-02-03T07:00:00Z")), false);
    assert.equal(u.isTaskDue(once, new Date("2026-02-05T07:00:00Z")), false);
  });
  test("once fired, never again", () => {
    const fired = { ...once, last_fired_at: new Date("2026-02-04T07:05:00Z") };
    assert.equal(u.isTaskDue(fired, new Date("2026-02-04T12:00:00Z")), false);
  });
  test("needs no weekdays — the date is the schedule", () => {
    assert.equal(u.isTaskDue({ ...once, days_of_week: [] }, new Date("2026-02-04T07:00:00Z")), true);
  });
  test("describeSchedule says it only happens once", () => {
    assert.equal(u.describeSchedule(once), "once, on 2026-02-04 at 09:00 (Europe/Bucharest)");
  });
});

describe("isValidLocalDate", () => {
  test("accepts real dates", () => {
    assert.equal(u.isValidLocalDate("2026-02-04"), true);
    assert.equal(u.isValidLocalDate("2028-02-29"), true);    // leap year
  });
  test("rejects impossible or malformed ones", () => {
    assert.equal(u.isValidLocalDate("2026-02-30"), false);   // would silently roll over
    assert.equal(u.isValidLocalDate("2026-13-01"), false);
    assert.equal(u.isValidLocalDate("2026-2-4"), false);
    assert.equal(u.isValidLocalDate("04/02/2026"), false);
    assert.equal(u.isValidLocalDate("tomorrow"), false);
    assert.equal(u.isValidLocalDate(""), false);
    assert.equal(u.isValidLocalDate(null), false);
  });
});

describe("monthly schedules", () => {
  const monthly = { hour_local: 9, days_of_week: [], days_of_month: [21, 25], timezone: "Europe/Bucharest" };
  test("fires on its days of the month, whatever weekday they are", () => {
    // 2026-08-21 is a Friday, 2026-08-25 a Tuesday.
    assert.equal(u.isTaskDue(monthly, new Date("2026-08-21T06:00:00Z")), true);   // 09:00 local
    assert.equal(u.isTaskDue(monthly, new Date("2026-08-25T06:00:00Z")), true);
  });
  test("silent on every other day", () => {
    assert.equal(u.isTaskDue(monthly, new Date("2026-08-22T06:00:00Z")), false);
    assert.equal(u.isTaskDue(monthly, new Date("2026-08-20T06:00:00Z")), false);
  });
  test("still respects the hour", () => {
    assert.equal(u.isTaskDue(monthly, new Date("2026-08-21T08:00:00Z")), false);  // 11:00 local
  });
  test("a day past the end of a short month lands on its last day", () => {
    const end = { ...monthly, days_of_month: [31] };
    // February 2027 has 28 days, so the 31st clamps to the 28th rather than skipping.
    assert.equal(u.isTaskDue(end, new Date("2027-02-28T07:00:00Z")), true);
    assert.equal(u.isTaskDue(end, new Date("2027-02-27T07:00:00Z")), false);
    // In a 31-day month it stays on the 31st.
    assert.equal(u.isTaskDue(end, new Date("2027-01-31T07:00:00Z")), true);
    assert.equal(u.isTaskDue(end, new Date("2027-01-28T07:00:00Z")), false);
  });
  test("days_of_month wins over days_of_week when both are set", () => {
    const both = { ...monthly, days_of_week: [1, 2, 3, 4, 5] };
    assert.equal(u.isTaskDue(both, new Date("2026-08-24T06:00:00Z")), false);   // a Monday, not the 21st/25th
    assert.equal(u.isTaskDue(both, new Date("2026-08-22T06:00:00Z")), false);   // a Saturday
  });
  test("describeSchedule reads like a person wrote it", () => {
    assert.equal(u.describeSchedule(monthly), "the 21 and 25 of every month at 09:00 (Europe/Bucharest)");
    assert.equal(u.describeSchedule({ ...monthly, days_of_month: [1] }),
      "the 1 of every month at 09:00 (Europe/Bucharest)");
  });
});

describe("normalizeDaysOfMonth", () => {
  test("sorts, de-duplicates and accepts strings", () => {
    assert.deepEqual(u.normalizeDaysOfMonth([25, 21, 21, "25", 1]), [1, 21, 25]);
  });
  test("rejects anything outside 1-31", () => {
    assert.throws(() => u.normalizeDaysOfMonth([0]));
    assert.throws(() => u.normalizeDaysOfMonth([32]));
    assert.throws(() => u.normalizeDaysOfMonth([]));
    assert.throws(() => u.normalizeDaysOfMonth(["nonsense"]));
  });
});

describe("countryOf", () => {
  test("maps a number to its country, or null when unknown", () => {
    assert.equal(u.countryOf("40723418290"), "Romania");
    assert.equal(u.countryOf("+44 7700 900123"), "United Kingdom");
    assert.equal(u.countryOf("999999999999"), null);
    assert.equal(u.countryOf(""), null);
  });
  test("a single-country group is confident, a mixed one is not", () => {
    const countries = (l) => new Set(l.map(u.countryOf).filter(Boolean));
    assert.equal(countries(["40711111111", "40722222222"]).size, 1);
    assert.equal(countries(["40711111111", "447700900123"]).size, 2);
  });
});
