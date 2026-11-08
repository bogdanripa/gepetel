// Ways that worked (playbooks.ts): what counts as a turn worth looking back
// at, and what may never be kept.
import { test } from "node:test";
import assert from "node:assert/strict";

const ways = (await import("../dist/playbooks.js")).default;

test("a turn of real work is worth a look; chores and a single search are not", () => {
  const t = new ways.Tracer();
  t.onResponse({ output: [{ type: "web_search_call", action: { query: "fan courier tracking" } }, { type: "message" }] });
  t.onDispatch("remember_about_them", { summary: "uses Gmail" }, { kept: true });
  t.onDispatch("set_reminder", { at: "2026-11-09 10:00" }, "ok");
  assert.equal(t.worth(), false);
  t.onResponse({ output: [
    { type: "mcp_call", server_label: "gmail", name: "search_threads", arguments: '{"q":"from:amazon.de"}', output: "3 threads" },
    { type: "mcp_call", server_label: "gmail", name: "get_thread", arguments: '{"id":"x"}', error: "not found" },
  ] });
  assert.equal(t.worth(), true);
  assert.deepEqual(t.steps.map(s => s.tool), ["web_search", "remember_about_them", "set_reminder", "gmail.search_threads", "gmail.get_thread"]);
  assert.equal(t.steps[4].result, "not found");
});

test("a way is a method: numbers, addresses, amounts and secrets are refused", () => {
  const ok = "search Gmail for the shipping email from amazon.de; the courier link in it needs no login";
  assert.equal(ways.unfit("they ask where an Amazon order is", ok), "");
  assert.match(ways.unfit("they ask where an order is", "tracking 2400105713197 on FAN Courier"), /number/);
  assert.match(ways.unfit("they ask about a bill", "it was 230 lei on Enel"), /amount/);
  assert.match(ways.unfit("they ask about mail", "write to ana@firma.ro"), /email/);
  assert.match(ways.unfit("they sign in", "password: hunter2"), /secret/);
  assert.equal(ways.unfit("", ok), "empty");
  assert.equal(ways.unfit("x", "y".repeat(600)), "too long");
});

test("the look back sees the ask, every step in order, the reply and the kept ways with ids", () => {
  const t = new ways.Tracer();
  t.onDispatch("read_url", { url: "https://fancourier.ro/awb" }, "In transit");
  const text = ways.lookBackInput("where's my parcel?", [{ from: "Ana", text: "hi" }], t.steps, "It's in transit, due Friday.",
    [{ _id: "abc", when: "they ask where a parcel is", how: "the courier's page" }]);
  assert.match(text, /\[What they asked\]\nwhere's my parcel\?/);
  assert.match(text, /1\. read_url\(\{"url":"https:\/\/fancourier\.ro\/awb"\}\) → In transit/);
  assert.match(text, /- \[abc\] they ask where a parcel is → the courier's page/);
  assert.match(text, /Ana: hi/);
});

test("no database, no look back and no note — the reply never waits on it", async () => {
  const t = new ways.Tracer();
  for (let i = 0; i < 4; i++) t.onDispatch("read_url", { url: "https://x.ro" }, "page");
  let called = false;
  assert.equal(await ways.afterTurn(async () => { called = true; }, "40700000000@s.whatsapp.net", "q", [], t, "a"), "skipped");
  assert.equal(called, false);
  assert.equal(await ways.note("40700000000@s.whatsapp.net"), "");
});
