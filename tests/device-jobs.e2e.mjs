// GEP-30 Phase 3, end to end: jobs, questions, cancel, and the outbox.
//
// The REAL agent (agent/dist/index.js run, started with the test-only tool on)
// against the real relay, hub and MCP endpoint. Mongo is two Maps and WhatsApp
// is an array; everything between is the shipped code. Needs the agent built
// and a machine whose sandbox works (macOS, or Linux with bubblewrap):
//
//   (cd agent && npm run build) && npm run build && node tests/device-jobs.e2e.mjs
import express from "express";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = 3411;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.PUBLIC_BASE_URL = BASE;
const here = path.dirname(fileURLToPath(import.meta.url));

const store = await import("../dist/device/store.js");
const jobsMod = await import("../dist/device/jobs.js");
const hub = (await import("../dist/device/hub.js")).default;
const m = (await import("../dist/mongo.js")).default;

// --- the device, its connector, and the job rows, in memory ---
const CHAT = "40723418290@s.whatsapp.net";
const TOKEN = "tok_" + Math.random().toString(36).slice(2);
const SECRET = "sec_" + Math.random().toString(36).slice(2);
const device = { device_id: "d_jobs", chat_id: CHAT, connector_id: "con_jobs", token_hash: store.hashSecret(TOKEN),
  name: "test-mac", os: "", arch: "", agent_version: "", capabilities: [], last_seen_at: null };
store.default.deviceForToken = async t => store.hashSecret(String(t)) === device.token_hash ? device : null;
store.default.deviceForConnector = async c => c === device.connector_id ? device : null;
store.default.deviceForChat = async c => c === CHAT ? device : null;
store.default.noteSeen = async (_d, hello) => { device.last_seen_at = new Date(); if (hello?.capabilities) device.capabilities = hello.capabilities; };
m.getMcpConnectorById = async id => id === "con_jobs"
  ? { connector_id: id, chat_id: CHAT, auth_kind: "device", headers: { Authorization: `Bearer ${SECRET}` } } : null;

const rows = new Map();
const J = jobsMod.default;
J.startJob = async j => {
  const r = rows.get(j.job_id) || { ...j, status: "running", question: "", progress: "", result: "", events_seen: [], created_at: new Date() };
  Object.assign(r, { status: j.status || "running", ...(j.question ? { question: j.question } : {}), updated_at: new Date() });
  rows.set(j.job_id, r);
};
J.getJob = async id => rows.get(id) || null;
J.openJobs = async chat => [...rows.values()].filter(r => r.chat_id === chat && ["running", "waiting"].includes(r.status)).reverse();
J.latestJob = async chat => [...rows.values()].filter(r => r.chat_id === chat).pop() || null;
J.noteEvent = async (id, eid, set) => {
  const r = rows.get(id);
  if (!r || r.events_seen.includes(eid)) return false;
  r.events_seen.push(eid);
  Object.assign(r, set, { updated_at: new Date() });
  return true;
};
J.setStatus = async (id, status, extra = {}) => { const r = rows.get(id); if (r) Object.assign(r, { status }, extra); };

const said = [];
const wa = (await import("../dist/wa.js")).default;
wa.supportsMentions = () => false;
wa.sendWhatsAppMessage = async (chat, text) => { said.push({ chat, text }); return "msg_" + said.length; };

const device_routes = (await import("../dist/device/routes.js")).default;
const app = express(); app.use(express.json());
device_routes.registerDeviceRoutes(app);
const server = http.createServer(app);
device_routes.attachHub(server);
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

// --- the real agent, in a throwaway home ---
const home = fs.mkdtempSync(path.join(os.tmpdir(), "gep-jobs-home-"));
const cfgDir = process.platform === "darwin" ? path.join(home, "Library", "Application Support", "Gepetel") : path.join(home, ".config", "gepetel");
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, "agent.json"), JSON.stringify({ server: BASE, device_id: "d_jobs", device_token: TOKEN, ws_url: `ws://127.0.0.1:${PORT}/device/ws` }));
const workspace = path.join(home, "ws");
const agentLog = [];
const agent = spawn(process.execPath, [path.join(here, "..", "agent", "dist", "index.js"), "run"], {
  env: { ...process.env, HOME: home, GEPETEL_TEST_TOOLS: "1", GEPETEL_WORKSPACE: workspace },
  stdio: ["ignore", "pipe", "pipe"],
});
agent.stdout.on("data", d => agentLog.push(String(d)));
agent.stderr.on("data", d => agentLog.push(String(d)));

let failures = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "  ok  " : "FAIL  "}${name}${cond ? "" : " — " + extra}`); if (!cond) failures++; };
const until = async (what, fn, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 100)); }
  console.log(`  (timed out waiting for ${what})`); return false;
};
const rpc = async (method, params) => (await fetch(`${BASE}/device/con_jobs/mcp`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
})).json();
const call = (name, args) => rpc("tools/call", { name, arguments: args });
const text = r => r?.result?.content?.[0]?.text || "";
const finish = code => { try { agent.kill("SIGTERM"); } catch {} server.close(); fs.rmSync(home, { recursive: true, force: true }); process.exit(code); };

try {
  check("the agent connects and says it does jobs", await until("hello", () => device.capabilities.includes("jobs") && device.capabilities.includes("demo")),
    agentLog.join("").slice(-400));
  const names = (await rpc("tools/list", {})).result?.tools?.map(t => t.name) || [];
  check("job and the test tool are offered to it", names.includes("job") && names.includes("ask_demo"), names.join());

  // 1. A question ends the model's turn at once, reaches the chat, and waits.
  said.length = 0;
  const t0 = Date.now();
  const asked = await call("ask_demo", { question: "What should I call you?" });
  check("a question hands back a waiting job without waiting 20s", /"status":"waiting"/.test(text(asked)) && Date.now() - t0 < 5000,
    `${Date.now() - t0}ms ${text(asked)}`);
  check("and tells the model the next message is the answer", /job reply/.test(text(asked)), text(asked));
  check("the question reaches the chat, verbatim, with the computer's mark",
    await until("question", () => said.some(s => s.chat === CHAT && s.text === "🖥️ What should I call you?")), JSON.stringify(said));
  const status1 = await call("job", { action: "status" });
  check("status says it is waiting for them, and what it asked", /waiting for their answer.*What should I call you/.test(text(status1)), text(status1));

  // 2. The answer goes back; the result comes as its own message.
  said.length = 0;
  const replied = await call("job", { action: "reply", text: "Bogdan" });
  check("job reply with no id finds the job that is waiting", /Passed on/.test(text(replied)), text(replied));
  check("the computer's answer arrives in the chat",
    await until("hello", () => said.some(s => /^🖥️ .*Hello, Bogdan!/s.test(s.text))), JSON.stringify(said));
  const status2 = await call("job", { action: "status" });
  check("and the job is done", /Nothing is running\. Last: .*done/.test(text(status2)), text(status2));
  const again = await call("job", { action: "reply", text: "again" });
  check("a reply when nothing is waiting is refused, not sent", again.result?.isError === true, text(again));

  // 3. Cancel stops the command itself, not just the waiting.
  said.length = 0;
  const marker = path.join(workspace, "should-not-exist.txt");
  const slow = await hub.callTool("d_jobs", "shell", { command: "sleep 4; echo late > should-not-exist.txt", timeout_s: 30 }, { timeoutMs: 400 });
  check("a slow command becomes a job", !!slow.job, JSON.stringify(slow));
  await until("job row", async () => !!(await J.getJob(slow.job)));
  const cancelled = await call("job", { action: "cancel" });
  check("cancel finds the running job", /^Cancelled\.$/.test(text(cancelled)), text(cancelled));
  await new Promise(r => setTimeout(r, 5500));
  check("the command was killed — what it would have written never appears", !fs.existsSync(marker));
  check("and nothing more is said about it in the chat", !said.some(s => /should-not-exist/.test(s.text)), JSON.stringify(said));
  check("the job stays cancelled", (await J.getJob(slow.job))?.status === "cancelled", JSON.stringify(await J.getJob(slow.job)));

  // 4. A result that finishes while the connection is down is not lost — and
  //    is delivered once, however many times it is resent.
  said.length = 0;
  const gap = await hub.callTool("d_jobs", "shell", { command: "sleep 2; echo survived-the-gap", timeout_s: 30 }, { timeoutMs: 300 });
  check("another slow command becomes a job", !!gap.job, JSON.stringify(gap));
  hub.dropDevice(CHAT);   // the connection drops mid-job
  check("its result arrives after the agent reconnects",
    await until("resent result", () => said.some(s => /survived-the-gap/.test(s.text)), 20000), agentLog.join("").slice(-600));
  hub.dropDevice(CHAT);   // and once more, after it was acknowledged
  await until("reconnect", () => hub.isOnline("d_jobs"), 20000);
  await new Promise(r => setTimeout(r, 1000));
  check("delivered exactly once", said.filter(s => /survived-the-gap/.test(s.text)).length === 1, JSON.stringify(said));
  const outbox = JSON.parse(fs.readFileSync(path.join(cfgDir, "outbox.json"), "utf8"));
  check("and the agent's outbox is empty once it was acknowledged", outbox.length === 0, JSON.stringify(outbox));

  // 5. Jobs belong to their chat.
  const foreign = await call("job", { action: "status", job_id: "j_not_mine" });
  check("an unknown job id is 'no such job', whatever it is", foreign.result?.isError === true && /no such job/.test(text(foreign)), text(foreign));
} catch (e) {
  console.error(e); failures++;
}
console.log(failures ? `\n${failures} FAILED` : "\nall green");
finish(failures ? 1 : 0);
