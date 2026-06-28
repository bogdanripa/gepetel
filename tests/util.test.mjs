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
  test("isMentioned is case-insensitive and covers raw ids", () => {
    assert.equal(u.isMentioned("yo @gepetel help"), true);
    assert.equal(u.isMentioned("yo @Gepetel help"), true);
    assert.equal(u.isMentioned("@279697464266959 ping"), true);
    assert.equal(u.isMentioned("no mention here"), false);
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
