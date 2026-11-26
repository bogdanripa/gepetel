// A question asked on a phone call: kept context and handed-back tool lists (voiceAsk.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import v from "../dist/voiceAsk.js";

test("what a call read about them is reused within the call, not after it", () => {
  const at = 1_000_000;
  assert.equal(v.fresh(at, at + 1000), true);
  assert.equal(v.fresh(at, at + v.VOICE_CTX_TTL_MS - 1), true);
  assert.equal(v.fresh(at, at + v.VOICE_CTX_TTL_MS), false);
  assert.equal(v.fresh(at, at - 5), false, "a clock going backwards reads again");
});

test("only fetched, error-free connector lists are kept, one per connector, newest wins", () => {
  const out = [
    { type: "reasoning" },
    { type: "mcp_list_tools", id: "l1", server_label: "gmail_x", tools: [{ name: "search" }] },
    { type: "mcp_list_tools", id: "l2", server_label: "attio_y", error: "401", tools: [] },
    { type: "mcp_call", server_label: "gmail_x" },
  ];
  const got = v.listedTools(out);
  assert.deepEqual(got.map(i => i.id), ["l1"]);
  const kept = v.keepListed([{ type: "mcp_list_tools", id: "old", server_label: "gmail_x", tools: [] }, { type: "mcp_list_tools", id: "cal", server_label: "cal_x", tools: [] }], got);
  assert.deepEqual(kept.map(i => i.id).sort(), ["cal", "l1"]);
  assert.deepEqual(v.listedTools(undefined), []);
});

test("lists are handed back only for connectors this turn still offers, as clean input items", () => {
  const kept = [
    { type: "mcp_list_tools", id: "l1", server_label: "gmail_x", tools: [{ name: "search" }], output_index: 3 },
    { type: "mcp_list_tools", id: "l2", server_label: "gone_z", tools: [] },
  ];
  const tools = [{ type: "function", name: "x" }, { type: "mcp", server_label: "gmail_x" }];
  assert.deepEqual(v.listedFor(kept, tools), [{ type: "mcp_list_tools", id: "l1", server_label: "gmail_x", tools: [{ name: "search" }] }]);
});

test("a call's question is told to do only what was asked", () => {
  assert.match(v.ON_A_CALL, /Do only what they asked/);
  assert.match(v.ON_A_CALL, /no scheduled tasks/);
});

// One request at a time on a call. Two answers used to be worked out side by
// side for one question, and both were said — with two different amounts.
const tick = () => new Promise(r => setTimeout(r, 0));

test("a request alone is asked as it is", async () => {
  const line = v.askLine();
  const notes = [];
  assert.equal(await line.run("When is my flight?", async also => { notes.push(also); return "At two."; }), "At two.");
  assert.deepEqual(notes, [""]);
  assert.equal(line.busy(), false);
});

test("a request made while another is being answered waits for it, and is told what was just said", async () => {
  const line = v.askLine();
  const order = [];
  let release;
  const first = line.run("When did they buy it, and for how much?", async () => { order.push("first starts"); await new Promise(r => { release = r; }); order.push("first ends"); return "In 2018, for 7.5 billion."; });
  await tick();
  assert.equal(line.busy(), true);
  let seen = "";
  const second = line.run("What calendar? I asked when they bought it", async also => { order.push("second starts"); seen = also; return "NOTHING"; });
  await tick();
  assert.deepEqual(order, ["first starts"], "never side by side");
  release();
  assert.equal(await first, "In 2018, for 7.5 billion.");
  assert.equal(await second, "", "the same question again: nothing more is said");
  assert.deepEqual(order, ["first starts", "first ends", "second starts"]);
  assert.match(seen, /When did they buy it, and for how much\?/);
  assert.match(seen, /In 2018, for 7\.5 billion\./);
  assert.match(seen, /single word NOTHING/);
  assert.equal(line.busy(), false);
});

test("something new said meanwhile gets its own answer; later requests are plain again", async () => {
  const line = v.askLine();
  let release;
  const first = line.run("When is my flight on Friday?", async () => { await new Promise(r => { release = r; }); return "At 14:20."; });
  await tick();
  const second = line.run("And from which terminal?", async also => { assert.ok(also); return "Terminal 2."; });
  release();
  assert.equal(await first, "At 14:20.");
  assert.equal(await second, "Terminal 2.");
  const notes = [];
  await line.run("What's the weather there?", async also => { notes.push(also); return "Sunny."; });
  assert.deepEqual(notes, [""], "nothing was running: no note");
});

test("an ask that throws doesn't block the line", async () => {
  const line = v.askLine();
  await assert.rejects(line.run("a", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(line.busy(), false);
  assert.equal(await line.run("b", async () => "ok"), "ok");
});

test("NOTHING is recognised alone, not inside an answer", () => {
  for (const s of ["NOTHING", "nothing.", " Nothing\n", "«NOTHING»"]) assert.equal(v.isNothingNew(s), true, s);
  for (const s of ["", "Nothing in your calendar on Friday.", "There is nothing new"]) assert.equal(v.isNothingNew(s), false, s);
});

test("on a call: quick, but the next place is looked in before giving up", () => {
  assert.match(v.ON_A_CALL, /isn't in their calendar is in their mail/);
  assert.match(v.ON_A_CALL, /Never ask them to send you something you can look for yourself/);
});
