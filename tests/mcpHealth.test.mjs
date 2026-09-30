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
