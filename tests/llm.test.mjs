// Behavioral tests that exercise the real models (src/oai.ts -> dist/oai.js).
// Gated + non-deterministic. Run with:
//   RUN_LLM_TESTS=1 OPENAI_API_KEY=... node --test tests/llm.test.mjs
import { test, describe, before } from "node:test";
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
