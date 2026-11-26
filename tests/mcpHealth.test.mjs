// Connector health: refresh classification, flag set/clear, lapsed tool output,
// and refresh-on-auth-failure. No DB, no network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as h from "../dist/mcpHealth.js";
const { OAuthRefreshError, classifyRefreshFailure, authFailedLabels, buildMcpContext, lapsedNotice } = h;

const conn = (over = {}) => ({
  connector_id: "c1", label: "Calendar", server_label: "calendar", server_url: "https://x.example/mcp", description: "",
  auth_kind: "oauth", needs_reconnect: false,
  oauth: { client_id: "id", token_endpoint: "https://x.example/token", resource: "https://x.example", access_token: "OLD", refresh_token: "RT", expires_at: Date.now() + 3_600_000 },
  ...over,
});
function deps(rows, refresh) {
  const log = { saved: [], flags: [], refreshed: 0 };
  return { log, d: {
    list: async () => rows,
    refresh: async (o) => { log.refreshed++; return refresh(o); },
    saveTokens: async (id, t) => { log.saved.push([id, t]); },
    setNeedsReconnect: async (id, v) => { log.flags.push([id, v]); },
  } };
}
const expiring = () => conn({ oauth: { ...conn().oauth, expires_at: Date.now() + 1000 } });

describe("classifyRefreshFailure", () => {
  test("definitive", () => {
    assert.equal(classifyRefreshFailure(new OAuthRefreshError("x", 400, "invalid_grant")), "definitive");
    assert.equal(classifyRefreshFailure(new OAuthRefreshError("x", 401, "invalid_client")), "definitive");
    assert.equal(classifyRefreshFailure(new OAuthRefreshError("x", 400)), "definitive");
    assert.equal(classifyRefreshFailure(new OAuthRefreshError("x", 401)), "definitive");
  });
  test("transient", () => {
    assert.equal(classifyRefreshFailure(new OAuthRefreshError("network")), "transient");
    assert.equal(classifyRefreshFailure(new OAuthRefreshError("x", 500)), "transient");
    assert.equal(classifyRefreshFailure(new OAuthRefreshError("x", 503)), "transient");
    assert.equal(classifyRefreshFailure(new OAuthRefreshError("x", 429)), "transient");
    assert.equal(classifyRefreshFailure(new OAuthRefreshError("x", 400, "temporarily_unavailable")), "transient");
    assert.equal(classifyRefreshFailure(new Error("plain")), "transient");
  });
});

describe("authFailedLabels", () => {
  test("finds auth errors on list and call items only", () => {
    const items = [
      { type: "mcp_list_tools", server_label: "calendar", error: "HTTP 401 Unauthorized" },
      { type: "mcp_call", server_label: "trello", error: { message: "invalid_token" } },
      { type: "mcp_call", server_label: "jira", error: "rate limited" },
      { type: "mcp_call", server_label: "ok" },
      { type: "message", server_label: "x", error: "401" },
    ];
    assert.deepEqual(authFailedLabels(items).sort(), ["calendar", "trello"]);
  });
});

describe("buildMcpContext", () => {
  test("near expiry + refresh token: refreshed silently, tokens stored", async () => {
    const { d, log } = deps([expiring()], async () => ({ access_token: "NEW", refresh_token: "RT2" }));
    const ctx = await buildMcpContext("chat", d);
    assert.equal(ctx.tools[0].authorization, "NEW");
    assert.deepEqual(ctx.lapsed, []);
    assert.equal(log.saved[0][1].access_token, "NEW");
  });
  test("healthy token is not refreshed", async () => {
    const { d, log } = deps([conn()], async () => ({}));
    const ctx = await buildMcpContext("chat", d);
    assert.equal(ctx.tools[0].authorization, "OLD");
    assert.equal(log.refreshed, 0);
  });
  test("rejected mid-life: forceRefresh refreshes once", async () => {
    const { d, log } = deps([conn()], async () => ({ access_token: "NEW" }));
    const ctx = await buildMcpContext("chat", d, new Set(["calendar"]));
    assert.equal(ctx.tools[0].authorization, "NEW");
    assert.equal(log.refreshed, 1);
  });
  test("invalid_grant: flagged, dropped, reported as lapsed", async () => {
    const { d, log } = deps([expiring()], async () => { throw new OAuthRefreshError("no", 400, "invalid_grant"); });
    const ctx = await buildMcpContext("chat", d);
    assert.equal(ctx.tools.length, 0);
    assert.deepEqual(ctx.lapsed, ["Calendar"]);
    assert.deepEqual(log.flags, [["c1", true]]);
  });
  test("network error / 5xx: no flag, no lapsed, retried next time", async () => {
    for (const err of [new OAuthRefreshError("net"), new OAuthRefreshError("x", 502)]) {
      const { d, log } = deps([expiring()], async () => { throw err; });
      const ctx = await buildMcpContext("chat", d);
      assert.equal(ctx.tools.length, 0);
      assert.deepEqual(ctx.lapsed, []);
      assert.deepEqual(log.flags, []);
    }
  });
  test("expired with no refresh token: lapsed", async () => {
    const c = conn({ oauth: { ...conn().oauth, refresh_token: undefined, expires_at: Date.now() - 1000 } });
    const { d, log } = deps([c], async () => ({}));
    const ctx = await buildMcpContext("chat", d);
    assert.deepEqual(ctx.lapsed, ["Calendar"]);
    assert.deepEqual(log.flags, [["c1", true]]);
  });
  test("flag is cleared by a successful refresh", async () => {
    const c = conn({ needs_reconnect: true, oauth: { ...conn().oauth, expires_at: Date.now() + 1000 } });
    const { d, log } = deps([c], async () => ({ access_token: "NEW" }));
    const ctx = await buildMcpContext("chat", d);
    assert.equal(ctx.tools.length, 1);
    assert.deepEqual(log.flags, [["c1", false]]);
  });
  test("already-flagged connector is not re-flagged", async () => {
    const c = conn({ needs_reconnect: true, oauth: { ...conn().oauth, expires_at: Date.now() - 1, refresh_token: undefined } });
    const { d, log } = deps([c], async () => ({}));
    const ctx = await buildMcpContext("chat", d);
    assert.deepEqual(ctx.lapsed, ["Calendar"]);
    assert.deepEqual(log.flags, []);
  });
  test("header connectors are untouched", async () => {
    const c = { connector_id: "h", label: "Zap", server_label: "zap", server_url: "https://z", description: "", auth_kind: "headers", headers: { Authorization: "Bearer k" } };
    const { d } = deps([c], async () => ({}));
    const ctx = await buildMcpContext("chat", d);
    assert.deepEqual(ctx.tools[0].headers, { Authorization: "Bearer k" });
  });
});

describe("lapsedNotice", () => {
  test("empty when nothing lapsed", () => assert.equal(lapsedNotice([], false), ""));
  test("DM: reconnect in the same reply, no asking", () => {
    const n = lapsedNotice(["Calendar"], false);
    assert.match(n, /Calendar/);
    assert.match(n, /add_mcp_connector/);
    assert.match(n, /SAME REPLY/);
  });
  test("group: points to private chat", () => assert.match(lapsedNotice(["Calendar"], true), /private chat/));
});

describe("isAuthFailureText", () => {
  const { isAuthFailureText } = h;
  test("loose numbers/words in free text are not auth failures", () => {
    assert.equal(isAuthFailureText("Rate limit: 403 items exceeded"), false);
    assert.equal(isAuthFailureText("Authentication service timeout"), false);
    assert.equal(isAuthFailureText("returned 4031 rows"), false);
  });
  test("real credential rejections are", () => {
    for (const e of ["HTTP 401", "status 403", "401 Unauthorized", "invalid_token", "Unauthorized", "WWW-Authenticate: Bearer", "Authentication failed", "token has expired",
      { status: 401 }, { code: 403 }, { code: "invalid_token" }, { message: "HTTP 401 from server" }]) {
      assert.equal(isAuthFailureText(e), true, JSON.stringify(e));
    }
  });
  test("structured non-auth errors are not", () => {
    assert.equal(isAuthFailureText({ code: 500, message: "Authentication service timeout" }), false);
    assert.equal(isAuthFailureText({ type: "http_error", message: "Rate limit: 403 items exceeded" }), false);
  });
});

// Two connections down at once (Gmail and Calendar, 2026-11-12): both are
// dropped and the reply still goes out.
describe("connections that can't be reached", () => {
  const down = (label) => Object.assign(new Error(`424 Error retrieving tool list from MCP server: '${label}'. Http status code: 424 (Failed Dependency)`),
    { status: 424, error: { type: "external_connector_error", message: `Error retrieving tool list from MCP server: '${label}'.` } });
  const tools = [{ type: "mcp", server_label: "google_calendar" }, { type: "mcp", server_label: "gmail" }, { type: "function", name: "x" }];
  test("each one down is dropped in turn", async () => {
    const seen = [];
    const create = async (req) => {
      seen.push(req.tools.map(t => t.server_label || t.name));
      const labels = req.tools.map(t => t.server_label);
      if (labels.includes("google_calendar")) throw down("google_calendar");
      if (labels.includes("gmail")) throw down("gmail");
      return { ok: true };
    };
    const { res, req } = await h.createDroppingUnreachable(create, { tools, instructions: "hi" }, () => {});
    assert.deepEqual(res, { ok: true });
    assert.equal(seen.length, 3);
    assert.deepEqual(req.tools.map(t => t.name), ["x"]);
    assert.match(req.instructions, /"google_calendar" connection can't be reached/);
    assert.match(req.instructions, /"gmail" connection can't be reached/);
  });
  test("anything else, or the same one again, is thrown", async () => {
    await assert.rejects(h.createDroppingUnreachable(async () => { throw new Error("boom"); }, { tools }, () => {}), /boom/);
    await assert.rejects(h.createDroppingUnreachable(async () => { throw down("not_mine"); }, { tools }, () => {}), /not_mine/);
  });
});

// Access revoked at Google (2026-11-12): the tool list 424s just like an
// outage. Its login is checked once: a refreshed token is tried in its place;
// a refused refresh says "reconnect" instead of "try again in a moment".
describe("a connection whose login was revoked", () => {
  const down = (label) => Object.assign(new Error(`424 Error retrieving tool list from MCP server: '${label}'.`),
    { status: 424, error: { type: "external_connector_error", message: `Error retrieving tool list from MCP server: '${label}'.` } });
  test("a refreshed login is tried once in its place", async () => {
    const auths = [];
    const create = async (req) => { const g = req.tools.find(t => t.server_label === "gmail"); auths.push(g?.authorization); if (g?.authorization === "OLD") throw down("gmail"); return { ok: 1 }; };
    const { req } = await h.createDroppingUnreachable(create, { tools: [{ type: "mcp", server_label: "gmail", authorization: "OLD" }], instructions: "" }, () => {},
      async () => ({ entry: { type: "mcp", server_label: "gmail", authorization: "NEW" } }));
    assert.deepEqual(auths, ["OLD", "NEW"]);
    assert.equal(req.tools[0].authorization, "NEW");
  });
  test("a refused refresh: dropped, and the model told to reconnect", async () => {
    let checks = 0;
    const create = async (req) => { if (req.tools.some(t => t.server_label === "gmail")) throw down("gmail"); return { ok: 1 }; };
    const { req } = await h.createDroppingUnreachable(create, { tools: [{ type: "mcp", server_label: "gmail", authorization: "OLD" }], instructions: "" }, () => {},
      async () => { checks++; return { notice: h.lapsedNotice(["Gmail"], false) }; });
    assert.equal(checks, 1);
    assert.equal(req.tools.length, 0);
    assert.match(req.instructions, /Login lapsed/);
    assert.doesNotMatch(req.instructions, /try again in a moment/);
  });
  test("still down with a fresh login: dropped as unreachable, checked only once", async () => {
    let checks = 0;
    const create = async (req) => { if (req.tools.some(t => t.server_label === "gmail")) throw down("gmail"); return { ok: 1 }; };
    const { req } = await h.createDroppingUnreachable(create, { tools: [{ type: "mcp", server_label: "gmail", authorization: "OLD" }], instructions: "" }, () => {},
      async () => { checks++; return { entry: { type: "mcp", server_label: "gmail", authorization: "NEW" } }; });
    assert.equal(checks, 1);
    assert.match(req.instructions, /can't be reached right now/);
  });
});

// A connection that keeps failing is left out for a while. Two of one
// person's were down for a day (2026-11-25): every request tried each, renewed
// its login, tried again and dropped it — 12 to 15 seconds before a word was
// written, on every question of a phone call — and their check-ins, which had
// no handling at all, found nothing.
describe("a connection that keeps failing is left out for a while", () => {
  const down = (label) => Object.assign(new Error(`424 Error retrieving tool list from MCP server: '${label}'.`),
    { status: 424, error: { type: "external_connector_error", message: `Error retrieving tool list from MCP server: '${label}'.` } });
  const U = "https://mail.example/mcp";
  const entry = (authorization = "T1") => ({ type: "mcp", server_label: "gmail_work", server_url: U, authorization });
  const other = { type: "mcp", server_label: "calendar", server_url: "https://cal.example/mcp", authorization: "C" };
  const setup = () => {
    const clock = { now: 1_000_000 };
    const downList = new h.DownList(() => clock.now);
    const seen = [];
    let broken = true;
    const create = async (req) => {
      seen.push(req.tools.filter(t => t.type === "mcp").map(t => t.server_label));
      if (broken && req.tools.some(t => t.server_label === "gmail_work")) throw down("gmail_work");
      return { ok: true };
    };
    const send = (tools, recover) => h.createDroppingUnreachable(create, { tools, instructions: "RULES", input: [{ role: "user", content: "hi" }] }, () => {}, recover, { downList });
    return { clock, downList, seen, send, mend: () => { broken = false; } };
  };

  test("after it fails, the next requests go out without it — no try, no login check", async () => {
    const x = setup();
    let checks = 0;
    const recover = async () => { checks++; return { entry: entry("T2") }; };
    await x.send([entry("T1"), other], recover);
    assert.deepEqual(x.seen, [["gmail_work", "calendar"], ["gmail_work", "calendar"], ["calendar"]]);
    assert.equal(checks, 1);
    x.seen.length = 0;
    // The renewed login is what was saved, so that is what the next request carries.
    const { req } = await x.send([entry("T2"), other], recover);
    assert.deepEqual(x.seen, [["calendar"]], "one request, without it");
    assert.equal(checks, 1);
    assert.deepEqual(req.tools.map(t => t.server_label), ["calendar"]);
  });

  test("the model is told in the conversation, and the instructions stay as they were (the cache matches them whole)", async () => {
    const x = setup();
    const { req } = await x.send([entry(), other]);
    assert.equal(req.instructions, "RULES");
    const last = req.input[req.input.length - 1];
    assert.equal(last.role, "developer");
    assert.match(last.content, /^\[Unreachable\] Their "gmail_work" connection can't be reached right now/);
    assert.deepEqual(req.input[0], { role: "user", content: "hi" });
  });

  test("it is tried again after 5 minutes, then 10, 20, at most 30; the login isn't checked again", async () => {
    const x = setup();
    let checks = 0;
    const recover = async () => { checks++; return {}; };
    await x.send([entry()], recover);
    const tries = () => x.seen.filter(s => s.includes("gmail_work")).length;
    assert.equal(tries(), 1);
    const waits = [];
    for (let i = 0; i < 5; i++) {
      const before = tries();
      let waited = 0;
      while (tries() === before) { x.clock.now += 60_000; waited++; await x.send([entry()], recover); }
      waits.push(waited);
    }
    assert.deepEqual(waits, [5, 10, 20, 30, 30]);
    assert.equal(checks, 1, "a refresh that didn't help the first time isn't repeated");
  });

  test("a new login is tried at once: they reconnected it", async () => {
    const x = setup();
    await x.send([entry("T1")]);
    x.seen.length = 0;
    await x.send([entry("T1")]);
    assert.deepEqual(x.seen, [[]]);
    x.mend();
    const { req } = await x.send([entry("FRESH")]);
    assert.deepEqual(req.tools.map(t => t.server_label), ["gmail_work"]);
    assert.equal(x.downList.failing(entry("FRESH")), false, "and it is forgotten once it answers");
    x.seen.length = 0;
    await x.send([entry("FRESH")]);
    assert.deepEqual(x.seen, [["gmail_work"]]);
  });

  test("down for over an hour: not 'in a moment' any more — they're told connecting it again usually fixes it", async () => {
    const x = setup();
    await x.send([entry()]);
    x.clock.now += 20 * 60_000;
    let { req } = await x.send([entry()]);
    assert.match(req.input.at(-1).content, /can't be reached right now/);
    x.clock.now += 3 * 3_600_000;
    ({ req } = await x.send([entry()]));
    const note = req.input.at(-1).content;
    assert.match(note, /has not answered for about 3 hours/);
    assert.match(note, /connecting it again usually fixes it/);
    assert.match(note, /If what they asked doesn't need it, don't bring it up/);
    assert.doesNotMatch(note, /try again in a moment/);
  });

  test("a login the provider refused keeps its own note while it is left out", async () => {
    const x = setup();
    await x.send([entry()], async () => ({ notice: h.lapsedNotice(["Gmail (work)"], false) }));
    const { req } = await x.send([entry()]);
    assert.match(req.input.at(-1).content, /Login lapsed/);
  });

  test("a check-in looking through their things leaves it out and says nothing about it", async () => {
    const x = setup();
    const create = async (req) => { if (req.tools.some(t => t.server_label === "gmail_work")) throw down("gmail_work"); return { ok: true }; };
    const first = await h.createDroppingUnreachable(create, { tools: [entry(), other], instructions: "LOOK", input: [{ role: "user", content: "Look now." }] }, () => {}, undefined, { downList: x.downList, quiet: true });
    assert.deepEqual(first.req.tools.map(t => t.server_label), ["calendar"]);
    assert.equal(first.req.instructions, "LOOK");
    assert.equal(first.req.input.length, 1);
    const again = await h.createDroppingUnreachable(async () => ({ ok: true }), { tools: [entry(), other], instructions: "LOOK", input: [{ role: "user", content: "Look now." }] }, () => {}, undefined, { downList: x.downList, quiet: true });
    assert.deepEqual(again.req.tools.map(t => t.server_label), ["calendar"]);
    assert.equal(again.req.input.length, 1);
  });

  test("without a list, nothing is remembered: every request tries", async () => {
    let tries = 0;
    const create = async (req) => { if (req.tools.length) { tries++; throw down("gmail_work"); } return { ok: true }; };
    await h.createDroppingUnreachable(create, { tools: [entry()], instructions: "" }, () => {});
    await h.createDroppingUnreachable(create, { tools: [entry()], instructions: "" }, () => {});
    assert.equal(tries, 2);
  });
});
