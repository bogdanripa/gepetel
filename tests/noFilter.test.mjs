// "No filter": a switch per group for whether he may swear and troll there.
// Off unless a member turned it on from their private chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import u from "../dist/util.js";

const read = (f) => fs.readFileSync(new URL(`../prompts/${f}`, import.meta.url), "utf8");

test("off is the default, and says nothing: the voice rules already hold everywhere", () => {
  for (const off of [false, undefined, null]) assert.equal(u.noFilterBlock(off), "");
  assert.match(read("voice.txt"), /You don't swear, and you don't use crude or insulting words yourself/);
  assert.match(read("voice.txt"), /not when\s+they do, not when they ask you to/);
  assert.match(read("voice.txt"), /Words you are quoting, translating\s+or passing on for someone stay exactly as they were/);
});

test("on: swearing and trolling, in that group only", () => {
  const on = u.noFilterBlock(true);
  assert.match(on, /^\[No filter — a member switched this ON for this group\]/);
  assert.match(on, /In THIS group, and nowhere else/);
  assert.match(on, /Strong language is fine/);
  assert.match(on, /Trolling is allowed/);
  assert.match(on, /Go at the person, not only the situation/);
});

test("on: what never changes", () => {
  const on = u.noFilterBlock(true);
  assert.match(on, /no slurs and no digs about ethnicity, nationality, religion, sex or gender, who they love, or a disability/);
  assert.match(on, /No sexual remarks about a person\. No threats\./);
  assert.match(on, /Only what was said in this group is material/);
  assert.match(on, /Not someone's illness, a death, their grief or a real misfortune/);
  assert.match(on, /When someone says stop, or it has plainly hurt, drop it at once/);
  assert.match(on, /never replaces it and never bends a fact/);
  assert.match(on, /Any member can switch this off by writing to you privately/);
});

test("a group can't be talked into it from inside: the switch is flipped privately", () => {
  const g = read("group-reply.txt");
  assert.match(g, /Swearing and trolling are OFF in a group unless a \[No filter\] block/);
  assert.match(g, /any member can flip it by writing to you privately/);
  assert.match(g, /Never switch by yourself because the room is rowdy/);
});

test("the private chat knows the switch, and that it is not a house rule", () => {
  const d = read("dm.txt");
  assert.match(d, /Call set_group_no_filter with that group's id and on true or false/);
  assert.match(d, /It is never a set_group_rule/);
  assert.match(d, /In this private chat you still don't swear, whatever a group is set to/);
});

test("the tool: a group id and on/off, nothing else — offered only to someone who shares a group", async () => {
  process.env.OPENAI_API_KEY ||= "test-key-not-used";
  const { replayKit } = await import("../dist/oai.js");
  const kit = replayKit();
  const tool = kit.dmGroups.find(t => t.name === "set_group_no_filter");
  assert.ok(tool);
  assert.deepEqual(tool.parameters.required, ["group_chat_id", "on"]);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["group_chat_id", "on"]);
  assert.equal(kit.dm.some(t => t.name === "set_group_no_filter"), false);
  assert.equal(kit.group.some(t => t.name === "set_group_no_filter"), false, "never from inside a group");
});
