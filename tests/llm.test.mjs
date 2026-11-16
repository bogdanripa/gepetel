// Behavioral tests that exercise the real models (src/oai.ts -> dist/oai.js).
// Gated + non-deterministic. Run with:
//   RUN_LLM_TESTS=1 OPENAI_API_KEY=... node --test tests/llm.test.mjs
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

const skip = (process.env.RUN_LLM_TESTS && process.env.OPENAI_API_KEY)
  ? false
  : "set RUN_LLM_TESTS=1 and OPENAI_API_KEY to run behavioral tests";

let oai;
before(async () => {
  if (skip) return;
  if (!process.env.GEPETEL_DATABASE_URL) process.env.GEPETEL_DATABASE_URL = process.env.TEST_DATABASE_URL || "";
  oai = (await import("../dist/oai.js")).default;
});

const T = { timeout: 60000 };

describe("cadence gatekeeper (shouldRespondToGroup)", { skip }, () => {
  test("YES: a direct follow-up to Gepetel's own line", T, async () => {
    const got = await oai.shouldRespondToGroup(
      "Ana: and what are they known for?",
      "That restaurant's number is 021 555 1234."
    );
    assert.equal(got, true);
  });

  test("NO: topic changes after he helped", T, async () => {
    const got = await oai.shouldRespondToGroup(
      "Ana: ok, we'll take my car then",
      "That restaurant's number is 021 555 1234."
    );
    assert.equal(got, false);
  });

  test("NO: plain member-to-member chatter he wasn't part of", T, async () => {
    const got = await oai.shouldRespondToGroup(
      "Ana: what are you all doing tonight?\nMihai: staying home, wrecked",
      ""
    );
    assert.equal(got, false);
  });

  test("YES: question clearly addressed to him", T, async () => {
    const got = await oai.shouldRespondToGroup(
      "Ana: gepetel what do you think, is 8pm ok?",
      "I can check the weather if you want."
    );
    assert.equal(got, true);
  });
});

describe("group greeting persona", { skip }, () => {
  test("greets, mentions @gepetel, does NOT list capabilities", T, async () => {
    const { answer } = await oai.generateGroupGreeting("Hiking Buddies", "English");
    assert.ok(answer && answer.length > 0);
    assert.match(answer, /@gepetel/i);
    // Should not enumerate features / sound like an assistant.
    assert.doesNotMatch(answer, /\b(reminder|poll|task|web search|i can help you with)\b/i);
  });
});

describe("unprompted gossip hygiene", { skip }, () => {
  test("contains no links/URLs and sticks to the group's context", T, async () => {
    const conversation = [
      "Ana: so ferry to Naxos on the 14th, right?",
      "Radu: yes, and 3 nights in Santorini after",
      "Ana: can't wait, found a boat tour in Naxos too",
    ].join("\n");
    const { answer } = await oai.generateGossip(
      "Greece trip 2026", "Romania", "Romanian",
      "trip to Greece in August: Naxos then Santorini", conversation);
    if (answer.toLowerCase().includes("no answer")) return; // acceptable: nothing worth sharing
    assert.doesNotMatch(answer, /https?:\/\//);
    assert.doesNotMatch(answer, /utm_source/);
  });
});

describe("multilingual replies", { skip }, () => {
  test("answers a French group prompt with a non-empty reply", T, async () => {
    const r = await oai.generateGroupReply("Les Amis", "Les Amis", 3, null,
      "Marie: @gepetel on part à quelle heure demain ?", 0, true);
    assert.ok(r.answer && !r.answer.toLowerCase().includes("no answer"));
  });
});

describe("pushback detector (detectPushback)", { skip }, () => {
  const post = "Pe 12-14 e un track day la Mamaia, se fac înscrieri din timp.";
  test("YES: the Adancata mockery", T, async () => {
    const got = await oai.detectPushback(post, [
      { from: "Radu", text: "So random it's almost beautiful" },
      { from: "Ana", text: "hint hint 😂" },
      { from: "Mihai", text: "de ce vorbește botul?" },
    ]);
    assert.equal(got, true);
  });
  test("NO: ordinary friendly replies", T, async () => {
    const got = await oai.detectPushback(post, [
      { from: "Radu", text: "oo nu știam, mersi! merge cineva?" },
      { from: "Ana", text: "eu sunt pe fază, trimite și prețul" },
    ]);
    assert.equal(got, false);
  });
});

describe("email and calendar are a connector question, not a refusal", { skip }, () => {
  // The behaviour this pins: someone asks about their inbox or their calendar
  // and nothing is connected yet. The wrong answer — the one this replaced —
  // is "I can't read your email". The right one is a single question about
  // which product they use, because the connector machinery can then do the
  // rest without them ever hearing the word "MCP".
  const noGroups = [];
  const refusal = /n-?am acces|nu pot(?! să îți spun care)|can'?t (read|access|check)|don'?t have access|nu am cum/i;

  test("asked about email with nothing connected, it asks which one — it does not refuse", T, async () => {
    const r = await oai.generateReply("Bogdan", "poți să verifici dacă am primit mailul de la Andrei?",
      [], "Europe/Bucharest", "40700000001@s.whatsapp.net", noGroups);
    assert.doesNotMatch(r.answer, refusal, r.answer);
    assert.match(r.answer, /gmail|outlook|yahoo|icloud|ce (folosești|ai)|which/i, r.answer);
  });

  test("same for a calendar question", T, async () => {
    const r = await oai.generateReply("Bogdan", "what do I have in my calendar on Thursday?",
      [], "Europe/Bucharest", "40700000002@s.whatsapp.net", noGroups);
    assert.doesNotMatch(r.answer, refusal, r.answer);
    assert.match(r.answer, /google|outlook|apple|icloud|which|ce (folosești|ai)/i, r.answer);
  });

  test("with a Google service already connected, it assumes Gmail instead of asking", T, async () => {
    // The question it should never ask twice over: somebody whose calendar is
    // already a Google one is not going to turn out to be an Outlook user, and
    // making them say so is a round trip that buys nothing. Needs a chat that
    // really has a Google connector — set TEST_GOOGLE_CHAT_ID to one.
    const chat = process.env.TEST_GOOGLE_CHAT_ID;
    if (!chat) return;   // nothing to assert against; not a failure
    const r = await oai.generateReply("Bogdan", "am primit vreun mail de la Andrei azi?",
      [], "Europe/Bucharest", chat, noGroups);
    assert.doesNotMatch(r.answer, /gmail\s*(sau|or|\?|,)\s*outlook/i,
      `it asked instead of assuming: ${r.answer}`);
  });

  test("it never asks them for a server, a URL or an API key", T, async () => {
    const r = await oai.generateReply("Bogdan", "vreau să-mi citești mailul",
      [], "Europe/Bucharest", "40700000003@s.whatsapp.net", noGroups);
    assert.doesNotMatch(r.answer, /\bMCP\b|server|URL|api key|cheie api/i, r.answer);
  });
});

describe("GEP-72: no watching claims without a mechanism", { skip }, () => {
  // He has no tool that watches a site, a feed or the news. On 2026-11-04 he
  // said "urmăresc Șetrarului… acum sub supraveghere" in a group where an
  // external automation (POST /api/send, verbatim) was the one doing it.
  const group = "120363000000000072@g.us";
  const watching = /urm[ăa]resc|monitorizez|supraveghez|sub supraveghere|sub observa[țt]ie|am ochii|keep an eye|I'?ll (keep )?(track|watch|monitor)/i;
  let m, calls, saved;
  before(async () => {
    if (skip) return;
    m = (await import("../dist/mongo.js")).default;
    saved = { r: m.toolFunctions.create_recurring_reminder, o: m.toolFunctions.create_reminder };
    // Record instead of writing: the assertion is about what he did, not the DB.
    m.toolFunctions.create_recurring_reminder = async a => { calls.push(["recurring", a]); return { reminder_id: "t1", ...a }; };
    m.toolFunctions.create_reminder = async a => { calls.push(["once", a]); return { reminder_id: "t2", ...a }; };
  });
  after(() => { if (m) Object.assign(m.toolFunctions, { create_recurring_reminder: saved.r, create_reminder: saved.o }); });

  test("the 2026-11-04 Notificari Sector 1 message: acknowledges the automation, claims no watching", T, async () => {
    calls = [];
    const r = await oai.generateGroupReply(group, "Notificari Sector 1", 12, null,
      "Mihai: @Anca aici o sa ne dea Gepetel mesaje despre tot ce se publica legat de Setrarului, Boiangiu sau Paharnicului",
      0, true, "Europe/Bucharest");
    if (/no answer/i.test(r.answer)) return;   // silence claims nothing either
    assert.doesNotMatch(r.answer, watching, r.answer);
    assert.doesNotMatch(r.answer, /relevant/i, `promised to pick: ${r.answer}`);
    assert.match(r.answer, /automatiz|prin mine|c[âa]nd (se )?trimite|apar(e|) aici/i, r.answer);
  });

  test("a bare watch-the-site request: says he can't, does not agree", T, async () => {
    calls = [];
    const r = await oai.generateGroupReply(group, "Notificari Sector 1", 12, null,
      "Ana: Gepetel, urmărește site-ul primăriei și zi-ne când apare ceva despre Setrarului",
      0, true, "Europe/Bucharest");
    assert.doesNotMatch(r.answer, watching, r.answer);
    assert.doesNotMatch(r.answer, /\b(sigur|ok|gata|am înțeles)\b.*(vă|va) (scriu|anunț|zic)/i, r.answer);
    assert.match(r.answer, /nu pot|n-?am cum|nu am cum|nu urm[ăa]resc|singur nu|nu am (un |niciun )?(mod|tool)/i, r.answer);
  });

  test("a recurring reminder is a real mechanism and still gets created", T, async () => {
    calls = [];
    const r = await oai.generateGroupReply(group, "Notificari Sector 1", 12, null,
      "Ana: Gepetel, amintește-ne în fiecare luni să verificăm site-ul primăriei",
      0, true, "Europe/Bucharest");
    const rec = calls.find(([k]) => k === "recurring");
    assert.ok(rec, `no recurring reminder created: ${JSON.stringify(calls)} / ${r.answer}`);
    assert.equal(rec[1].recurrence, "weekly");
  });
});
