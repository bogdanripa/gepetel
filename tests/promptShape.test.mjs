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
