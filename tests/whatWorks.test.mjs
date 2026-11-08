// What works across everyone (whatWorks.ts): what a turn used, the counts, and
// the lines a reply gets — numbers only once enough people are behind them.
import { test } from "node:test";
import assert from "node:assert/strict";

const works = (await import("../dist/whatWorks.js")).default;
const { Tracer } = (await import("../dist/playbooks.js")).default;

test("what a turn used comes from its own steps", () => {
  const t = new Tracer();
  t.onResponse({ output: [
    { type: "mcp_call", server_label: "gmail", name: "search_threads", arguments: "{}", output: "" },
    { type: "mcp_call", server_label: "google_calendar", name: "list_events", arguments: "{}", output: "" },
    { type: "mcp_call", server_label: "computer", name: "job", arguments: "{}", output: "" },
    { type: "web_search_call", action: { query: "x" } },
  ] });
  assert.deepEqual(works.capsUsed(t).sort(), ["calendar", "computer", "email", "web"]);
  assert.deepEqual(works.capsHad("Gmail (a@b.ro) (connected by Ana; can: search_threads)", false).sort(), ["email", "web"]);
  assert.deepEqual(works.capsHad("", true).sort(), ["computer", "web"]);
});

test("a person is a hash, the same each time, with no number in sight", () => {
  const a = works.who("40722111222@s.whatsapp.net");
  assert.equal(a, works.who("40722111222@s.whatsapp.net"));
  assert.notEqual(a, works.who("40722111223@s.whatsapp.net"));
  assert.ok(!a.includes("40722111222"));
});

const rows = (n, kind, withCap, gotShare = 1) => Array.from({ length: n }, (_, i) => ({
  kind, got: i < n * gotShare ? 1 : 0, with: i < n * withCap ? { email: 1 } : {}, lacked: {},
}));

test("before enough people: how it works, never a number", () => {
  const l = works.lines(works.tally(rows(5, "parcel", 1)), ["web"]);
  const parcel = l.find(x => x.includes("parcel"));
  assert.match(parcel, /works best with their email \(how you work — no numbers\)/);
  assert.ok(!/in 10/.test(l.join("\n")));
});

test("with enough people: the counted share, for a connection they lack", () => {
  const all = works.tally(rows(25, "parcel", 0.8));
  const parcel = works.lines(all, ["web"]).find(x => x.includes("parcel"));
  assert.match(parcel, /8 in 10 people who got this done here had their email connected \(counted\)/);
  // They have email: nothing about email for parcels.
  assert.ok(!works.lines(all, ["web", "email"]).some(x => x.includes("parcel")));
  // Everything connected: no lines at all.
  assert.deepEqual(works.lines(all, ["web", "email", "calendar", "computer"]), []);
});

test("a share under half isn't a reason: back to how it works", () => {
  const parcel = works.lines(works.tally(rows(30, "parcel", 0.2)), ["web"]).find(x => x.includes("parcel"));
  assert.match(parcel, /no numbers/);
});

test("no database: the turn isn't counted and the reply doesn't wait", async () => {
  let called = false;
  assert.equal(await works.afterTurn(async () => { called = true; }, "x@s.whatsapp.net", "q", [], new Tracer(), "a", ["web"]), "skipped");
  assert.equal(called, false);
});
