// The reconnect link and the "told once" claim against a real database — set
// TEST_DATABASE_URL (a throwaway DB).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL (a throwaway DB) to run";
let m, mongoose;
const C = "40799999992@s.whatsapp.net";
const DAY = 24 * 3600_000;
const ctx = { requesterChatId: C };

before(async () => {
  if (skip) return;
  process.env.MCP_SECRET_KEY ||= "0".repeat(64);
  mongoose = (await import("mongoose")).default;
  await mongoose.connect(TEST_DB);
  m = (await import("../dist/mongo.js")).default;
});
const wipe = async () => { for (const c of ["mcpconnectors", "mcpoauthpendings"]) await mongoose.connection.collection(c).deleteMany({ chat_id: C }); };
beforeEach(async () => { if (!skip) await wipe(); });
after(async () => { if (!skip) { await wipe(); await mongoose.disconnect(); } });

const oauth = (access_token = "T1") => ({ client_id: "id", token_endpoint: "https://x.example/token", resource: "https://x.example", access_token, refresh_token: "R" });
const add = (label = "Gmail (ana@example.com)", extra = {}) => m.addMcpConnector(C, { label, server_url: "https://mail.example/mcp", oauth: oauth(), tool_names: ["search_threads"], ...extra }, ctx, "Ana");
const pending = (state, extra = {}) => m.startMcpOAuth(C, { label: "Gmail (ana@example.com)", server_url: "https://mail.example/mcp", resource: "https://mail.example", token_endpoint: "https://x.example/token", client_id: "id", code_verifier: "v", state, authorize_url: "https://accounts.example/auth", ...extra }, ctx, "Ana");

test("what telling them needs: whose it is, where it lives, and the login as stored", { skip }, async () => {
  await add();
  const c = await m.mcpConnectorForReauth(C, "gmail_ana_example_com");
  assert.equal(c.label, "Gmail (ana@example.com)");
  assert.equal(c.chat_id, C);
  assert.equal(c.auth_kind, "oauth");
  assert.equal(c.server_url, "https://mail.example/mcp");
  assert.deepEqual(c.headers, { Authorization: "Bearer T1" });
  assert.equal(c.added_by, "40799999992");
  assert.equal(await m.mcpConnectorForReauth(C, "nothing_here"), null);
});

test("the turn to tell them is taken once; again after the pause; given back when the message didn't go", { skip }, async () => {
  const { internal_id_do_not_show: id } = await add();
  const t0 = new Date("2026-11-26T09:00:00Z");
  const at = (ms) => new Date(t0.getTime() + ms);
  assert.equal(await m.claimReauthAsk(id, 3 * DAY, t0), true);
  assert.equal(await m.claimReauthAsk(id, 3 * DAY, at(60_000)), false);
  assert.equal(await m.claimReauthAsk(id, 3 * DAY, at(2 * DAY)), false);
  assert.equal(await m.claimReauthAsk(id, 3 * DAY, at(3 * DAY + 1)), true, "still broken three days on: once more");
  await m.releaseReauthAsk(id);
  assert.equal(await m.claimReauthAsk(id, 3 * DAY, at(3 * DAY + 2)), true);
  const both = await Promise.all([m.claimReauthAsk(id, 1, at(10 * DAY)), m.claimReauthAsk(id, 1, at(10 * DAY))]);
  assert.deepEqual(both.sort(), [false, true], "two at once: one gets it");
});

test("the link: the same one while it's fresh, found by its token, dead after a week, never guessable", { skip }, async () => {
  const { internal_id_do_not_show: id } = await add();
  const WEEK = 7 * DAY, t0 = new Date("2026-11-26T09:00:00Z");
  const token = await m.mcpReconnectToken(id, WEEK, t0);
  assert.ok(token.length >= 20);
  assert.equal(await m.mcpReconnectToken(id, WEEK, new Date(t0.getTime() + DAY)), token);
  assert.equal((await m.mcpConnectorByReconnectToken(token, WEEK, new Date(t0.getTime() + 6 * DAY))).connector_id, id);
  assert.equal(await m.mcpConnectorByReconnectToken(token, WEEK, new Date(t0.getTime() + 8 * DAY)), null);
  assert.equal(await m.mcpConnectorByReconnectToken("", WEEK), null);
  assert.equal(await m.mcpConnectorByReconnectToken("short", WEEK), null);
  // A reminder three days on is sent a link with most of a week left on it.
  const later = await m.mcpReconnectToken(id, WEEK, new Date(t0.getTime() + 4 * DAY));
  assert.notEqual(later, token);
  assert.equal(await m.mcpConnectorByReconnectToken(token, WEEK, new Date(t0.getTime() + 4 * DAY)), null, "the old link stops with it");
});

test("signed in again from the link: the new login takes the old one's place and name — no second 'Gmail (2)'", { skip }, async () => {
  const old = await add();
  await pending("state-r1", { replaces: old.internal_id_do_not_show });
  const p = await m.takeMcpOAuthPending("state-r1");
  assert.equal(p.replaces, old.internal_id_do_not_show);
  const fresh = await m.addMcpConnector(C, { label: p.label, server_url: p.server_url, oauth: oauth("T2"), tool_names: ["search_threads"], replaces: p.replaces }, { admin: true }, "Ana", "40799999992");
  const rows = await m.getMcpConnectorsForGroup(C);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "Gmail (ana@example.com)");
  assert.equal(rows[0].server_label, "gmail_ana_example_com");
  assert.equal(rows[0].oauth.access_token, "T2");
  assert.notEqual(fresh.internal_id_do_not_show, old.internal_id_do_not_show);
});

test("without the link, a second login of the same name still sits beside the first (two mailboxes)", { skip }, async () => {
  await add();
  await add();
  const labels = (await m.getMcpConnectorsForGroup(C)).map(r => r.label).sort();
  assert.deepEqual(labels, ["Gmail (ana@example.com)", "Gmail (ana@example.com) (2)"]);
});

test("a chat full of connections can still redo one of them", { skip }, async () => {
  let last;
  for (let i = 0; i < 60; i++) { try { last = await add(`Service ${i}`); } catch { break; } }
  await assert.rejects(pending("state-full"), /remove one first/);
  await pending("state-redo", { replaces: last.internal_id_do_not_show });
  assert.ok(await m.takeMcpOAuthPending("state-redo"));
});
