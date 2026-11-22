// The two big prompts are the same for every chat up to their last block.
//
// That is what lets their ~12k tokens be read from cache instead of billed
// whole on every message. One placeholder for a name or a group near the top
// undoes it silently: for a month the private prompt named the person at
// character 50, and 12% of 61 million input tokens were cached.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const PER_CHAT = /\{\{(author|groups|userId|groupname|numberofparticipants)\}\}/g;
for (const [file, mark] of [["dm", "[This chat]"], ["group-reply", "[This group]"]]) {
  test(`${file}: nothing about one chat appears before ${mark}`, () => {
    const text = fs.readFileSync(new URL(`../prompts/${file}.txt`, import.meta.url), "utf8");
    const cut = text.lastIndexOf(`\n${mark}\n`);
    assert.ok(cut > 0, `${mark} is the prompt's last block`);
    assert.deepEqual(text.slice(0, cut).match(PER_CHAT) || [], [], "the shared part names no person and no group");
    assert.ok((text.slice(cut).match(PER_CHAT) || []).length >= 1, "and the last block does");
    assert.ok(text.length - cut < 400, "which is short: everything else is shared");
  });
}

test("the models are chosen in one place, and an env var changes one", async () => {
  const MODELS = (await import("../dist/models.js")).default;
  assert.equal(MODELS.group(), "gpt-5.6-sol");
  assert.equal(MODELS.unprompted(), "gpt-5.6-sol");
  assert.equal(MODELS.dm(), "gpt-5.6-luna");
  process.env.MODEL_GROUP = "gpt-5.6-luna";
  assert.equal(MODELS.group(), "gpt-5.6-luna", "read at call time, so no deploy is needed to change it");
  delete process.env.MODEL_GROUP;
});

// ── how a request goes out ──────────────────────────────────────────────────
// Measured on the live API (2026-11-22): the cache matches `instructions`
// whole or not at all, so one changed last line cost all 12k tokens; with the
// per-chat part moved into the conversation, 12,272 of 12,361 were cached.
const { shaped, splitInstructions, sharedInstructions } = await import("../dist/promptShape.js");
const p = (await import("../dist/prompts.js")).default;

test("a private reply: the shared prompt alone in instructions, the chat's own part just before their message", () => {
  const ins = p.loadPrompt("dm", { author: "Dana Ionescu", groups: "- Vecinii", userId: "40700000001@c.us", botPhone: "+40 700 000 000" })
    + "\n\n[Context] Right now it is Sunday 10:00." + "\n\n[Language] They are writing in Romanian";
  const out = shaped({ model: "m", instructions: ins, input: [
    { role: "user", content: "salut" }, { role: "assistant", content: "salut!" }, { role: "user", content: "ce am mâine?" },
  ] });
  assert.ok(!/Dana Ionescu|Vecinii|Right now it is|They are writing in/.test(out.instructions), "nothing of this chat is left in the shared part");
  assert.equal(out.input.length, 4);
  assert.equal(out.input[2].role, "developer");
  assert.match(out.input[2].content, /^\[This chat\]\nYou are talking with: Dana Ionescu/);
  assert.match(out.input[2].content, /Right now it is Sunday 10:00/);
  assert.match(out.input[2].content, /They are writing in Romanian/);
  assert.equal(out.input[3].content, "ce am mâine?", "their message is still the last thing read");
  assert.equal(out.instructions + "\n" + out.input[2].content, ins, "nothing is lost or reworded");
});

test("two people's requests share their instructions to the byte, and so do two groups'", () => {
  const dm = who => shaped({ instructions: p.loadPrompt("dm", { author: who, groups: "(none)", userId: who, botPhone: "+40 700 000 000" }) + "\n\n[About them] " + who, input: [{ role: "user", content: "hi" }] }).instructions;
  assert.equal(dm("Dana"), dm("Radu"));
  const group = (name, n) => shaped({ instructions: p.loadPrompt("group-reply", { groupname: name, numberofparticipants: n, pollvotes: "-" }) + "\n\n[Group roster] " + name, input: [{ role: "user", content: "hi" }] }).instructions;
  assert.equal(group("Vecinii", "5"), group("Fotbal joi", "12"));
  assert.ok(dm("Dana").length > 20000 && group("a", "1").length > 20000, "and that shared part is nearly all of it");
});

test("shaping leaves alone what has no per-chat part, and does nothing the second time", () => {
  const plain = { instructions: "Answer yes or no.", input: [{ role: "user", content: "x" }] };
  assert.equal(shaped(plain), plain);
  const once = shaped({ instructions: "A\n[This group]\nName: X", input: [{ role: "user", content: "x" }] });
  assert.deepEqual(shaped(once), once);
  const later = { previous_response_id: "r1", instructions: "A", input: [{ type: "function_call_output", call_id: "c", output: "1" }] };
  assert.equal(shaped(later), later, "a later round carries the shared prompt and nothing to move");
  assert.equal(shaped({ input: [] }).instructions, undefined);
});

test("a bare string input and a first message are handled; the caller's request is never changed", () => {
  const req = { instructions: "A\n[This chat]\nB", input: "hello" };
  const out = shaped(req);
  assert.deepEqual(out.input, [{ role: "developer", content: "[This chat]\nB" }, { role: "user", content: "hello" }]);
  assert.equal(req.input, "hello");
  assert.equal(req.instructions, "A\n[This chat]\nB", "so a retry that rebuilds the request starts from the whole prompt");
  assert.deepEqual(splitInstructions("A\n[This chat]\nB"), { shared: "A", own: "[This chat]\nB" });
  assert.equal(sharedInstructions("A\n[This group]\nB\n\n[Group roster] x"), "A");
});
