// GEP-30 Phase 0, end to end: pair, connect, list, call, go offline.
//
// The relay, the hub and the MCP endpoint are the real code. Mongo is replaced
// by two Maps, and WhatsApp by an array, so this runs anywhere with no database
// and no network:  node tests/device.e2e.mjs
import express from "express";
import http from "node:http";
import { WebSocket } from "ws";

const PORT = 3410;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.PUBLIC_BASE_URL = BASE;

const store = await import("../dist/device/store.js");
const hub = (await import("../dist/device/hub.js")).default;
const m = (await import("../dist/mongo.js")).default;

// --- in-memory stand-ins for the two collections this path touches ---
const devices = new Map(), codes = new Map(), connectors = new Map();
store.default.createPairingCode = async chatId => {
  const code = store.newPairingCode();
  codes.set(store.hashSecret(code), { chat_id: chatId, used: false, exp: Date.now() + 600000 });
  return { code, expiresAt: new Date(Date.now() + 600000) };
};
store.default.redeemPairingCode = async code => {
  const row = codes.get(store.hashSecret(String(code).replace(/\D/g, "")));
  if (!row || row.used || row.exp < Date.now()) return null;
  row.used = true; return { chatId: row.chat_id };
};
store.default.registerDevice = async (chatId, info) => {
  const token = store.newToken(), deviceId = "d_test";
  devices.set(deviceId, { device_id: deviceId, chat_id: chatId, connector_id: "", token_hash: store.hashSecret(token),
    name: info.name || "", os: info.os || "", arch: info.arch || "", agent_version: info.agent_version || "",
    capabilities: info.capabilities || [], last_seen_at: null });
  return { deviceId, token };
};
store.default.setDeviceConnector = async (d, c) => { devices.get(d).connector_id = c; };
store.default.deviceForToken = async t => [...devices.values()].find(d => d.token_hash === store.hashSecret(String(t))) || null;
store.default.deviceForConnector = async c => [...devices.values()].find(d => d.connector_id === c) || null;
store.default.noteSeen = async (d, hello) => { const x = devices.get(d); if (x) { x.last_seen_at = new Date(); if (hello?.capabilities) x.capabilities = hello.capabilities; } };
m.addDeviceConnector = async (chatId, input) => {
  const connector_id = "con_test";
  connectors.set(connector_id, { connector_id, chat_id: chatId, label: input.label, auth_kind: "device",
    headers: { Authorization: `Bearer ${input.secret}` }, server_url: input.urlFor(connector_id) });
  return { connector_id, label: input.label };
};
m.getMcpConnectorById = async id => connectors.get(id) || null;

// sayAndRemember is real; what it calls is not. Patch the provider object so
// the message goes into an array instead of to WhatsApp.
const said = [];
const wa = (await import("../dist/wa.js")).default;
wa.supportsMentions = () => false;
wa.sendWhatsAppMessage = async (chat, text) => { said.push({ chat, text }); return "msg_test"; };

const device = (await import("../dist/device/routes.js")).default;
const app = express(); app.use(express.json());
device.registerDeviceRoutes(app);
const server = http.createServer(app);
device.attachHub(server);
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

const CHAT = "40723418290@s.whatsapp.net";
const rpc = async (cid, secret, method, params) => (await fetch(`${BASE}/device/${cid}/mcp`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
})).json();

let failures = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "  ok  " : "FAIL  "}${name}${cond ? "" : " — " + extra}`); if (!cond) failures++; };

// 1. a code, then pairing
const { code } = await store.default.createPairingCode(CHAT);
check("pairing code is 6 digits", /^\d{6}$/.test(code), code);
const bad = await fetch(`${BASE}/device/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "000000" }) });
check("a wrong code is refused", bad.status === 401, String(bad.status));
const paired = await (await fetch(`${BASE}/device/pair`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ code, device_name: "Bogdans-Mac", os: "Darwin 26.0", arch: "arm64", agent_version: "0.1.0", capabilities: ["status"] }) })).json();
check("pairing returns a token", !!paired.device_token);
check("the chat is told, in fixed words", said.some(s => s.chat === CHAT && /connected|conectat/i.test(s.text)), JSON.stringify(said));
const again = await fetch(`${BASE}/device/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
check("the code is single use", again.status === 401, String(again.status));

const secret = connectors.get("con_test").headers.Authorization.replace("Bearer ", "");
check("the server url addresses the connector", connectors.get("con_test").server_url === `${BASE}/device/con_test/mcp`, connectors.get("con_test").server_url);

// 2. the MCP endpoint while the Mac is asleep
check("a wrong bearer is refused", (await (await fetch(`${BASE}/device/con_test/mcp`, { method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer nope" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json()).error?.code === -32001);
const listOffline = await rpc("con_test", secret, "tools/list", {});
check("tools/list works with the Mac offline", listOffline.result?.tools?.[0]?.name === "computer_status", JSON.stringify(listOffline));
const statusOffline = await rpc("con_test", secret, "tools/call", { name: "computer_status", arguments: {} });
check("status says offline", /offline/i.test(statusOffline.result?.content?.[0]?.text || ""), JSON.stringify(statusOffline));

// 3. the agent connects
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/device/ws`, { headers: { Authorization: `Bearer ${paired.device_token}` } });
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
ws.send(JSON.stringify({ t: "hello", agent_version: "0.1.0", capabilities: ["status"] }));
ws.on("message", raw => {
  const msg = JSON.parse(String(raw));
  if (msg.t === "call" && msg.tool === "computer_status") {
    ws.send(JSON.stringify({ t: "result", id: msg.id, ok: true, content: "Bogdans-Mac — Darwin 26.0 (arm64)\nagent 0.1.0, up 3h" }));
  }
  // anything else is deliberately ignored, to exercise the promote-to-job path
});
await new Promise(r => setTimeout(r, 150));
const statusOnline = await rpc("con_test", secret, "tools/call", { name: "computer_status", arguments: {} });
check("status comes from the Mac when it is online", /Bogdans-Mac/.test(statusOnline.result?.content?.[0]?.text || ""), JSON.stringify(statusOnline));

// 4. a tool the agent never answers is promoted to a job, not left hanging
const t0 = Date.now();
const promoted = await hub.callTool("d_test", "slow_thing", {}, { timeoutMs: 300 });
check("a slow call becomes a job", !!promoted.job, JSON.stringify(promoted));
check("and it returns promptly", Date.now() - t0 < 1500, `${Date.now() - t0}ms`);

// 5. unauthorised sockets never open
const refused = new WebSocket(`ws://127.0.0.1:${PORT}/device/ws`, { headers: { Authorization: "Bearer nope" } });
check("an unknown token cannot open a socket", await new Promise(r => { refused.on("open", () => r(false)); refused.on("error", () => r(true)); refused.on("unexpected-response", () => r(true)); }));

// 6. closing the socket makes it offline again
ws.close();
await new Promise(r => setTimeout(r, 200));
const afterClose = await rpc("con_test", secret, "tools/call", { name: "computer_status", arguments: {} });
check("offline again once the agent stops", /offline/i.test(afterClose.result?.content?.[0]?.text || ""), JSON.stringify(afterClose));

server.close();
console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
