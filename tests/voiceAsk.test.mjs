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
