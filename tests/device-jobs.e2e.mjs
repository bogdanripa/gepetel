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
// A copy, as Mongo gives: the hub compares a row before and after an update.
J.getJob = async id => rows.has(id) ? { ...rows.get(id), events_seen: [...rows.get(id).events_seen] } : null;
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

// The model behind /device/llm, scripted: follow "Next page", then answer
// from what is on screen. Usage accounting stubbed (it is Mongo).
const llm = (await import("../dist/device/llm.js")).default;
const llmSeen = [];
// Takeover rows in memory too.
const takeoverMod = (await import("../dist/device/takeover.js")).default;
const tRows = new Map();
takeoverMod.rows.create = async r => { tRows.set(r.token_hash, { ...r }); };
takeoverMod.rows.byHash = async h => tRows.get(h) || null;
takeoverMod.rows.setStatus = async (h, st) => { const r = tRows.get(h); if (r) r.status = st; };
takeoverMod.rows.revokeJob = async j => { const out = []; for (const r of tRows.values()) if (r.job_id === j && r.status === "issued") { r.status = "revoked"; out.push(r.token_hash); } return out; };
const { WebSocket: WS } = await import("ws");
llm.usage.today = async () => 0;
llm.usage.charge = async () => {};
llm.jobUsage.charge = async () => {};
llm.openai.create = async req => {
  const text = req.input?.[0]?.content?.[0]?.text || "";
  llmSeen.push(text);
  // The takeover job: hand over first, then finish once it was taken over.
  if (/Goal: get past the check/.test(text)) {
    return { output: [{ type: "function_call", ...(/took over/.test(text)
      ? { name: "finish", arguments: JSON.stringify({ answer: "Past the check." }) }
      : { name: "handoff", arguments: JSON.stringify({ reason: "There's a check only you can do." }) }) }], output_text: "", usage: { input_tokens: 400, output_tokens: 20 } };
  }
  const next = text.match(/"Next page" \[ref=([A-Za-z0-9_]+)\]/)?.[1];
  const call = /131,05 lei/.test(text)
    ? { name: "finish", arguments: JSON.stringify({ answer: "Your August bill was 131,05 lei, due 15 September." }) }
    : { name: "click", arguments: JSON.stringify({ ref: next }) };
  return { output: [{ type: "function_call", ...call }], output_text: "", usage: { input_tokens: 900, output_tokens: 30 } };
};
let lastHit = null, lastTyped = null;
const fixture = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  if (req.url.startsWith("/hit")) { lastHit = Object.fromEntries(new URL(req.url, "http://x").searchParams); return res.end("ok"); }
  if (req.url.startsWith("/typed")) { lastTyped = new URL(req.url, "http://x").searchParams.get("v"); return res.end("ok"); }
  if (req.url === "/check") return res.end(`<meta name=viewport content="width=device-width,initial-scale=1"><title>Check</title><body style="margin:0"><h1>Are you human?</h1>
    <div style="position:absolute;left:200px;top:300px;width:400px;height:200px;background:#CC6B4E"
      onclick="fetch('/hit?x='+event.clientX+'&y='+event.clientY)"></div>
    <input id="code" style="position:absolute;left:40px;top:120px;width:200px;height:30px" oninput="fetch('/typed?v='+encodeURIComponent(this.value))"></body>`);
  if (req.url === "/bills2") return res.end(`<title>Older bills</title><main><h1>Older bills</h1><p>Aug 2026 — 131,05 lei, due 15 Sep</p></main>`);
  res.end(`<title>Bills</title><main><h1>Your bills</h1><p>Sept 2026 — 142,30 lei</p><a href="/bills2">Next page</a></main>`);
});
await new Promise(r => fixture.listen(0, "127.0.0.1", r));
const hasChrome = ["/Applications/Google Chrome.app", path.join(os.homedir(), "Applications", "Google Chrome.app")].some(p => fs.existsSync(p));

const said = [];
const wa = (await import("../dist/wa.js")).default;
wa.supportsMentions = () => false;
wa.sendWhatsAppMessage = async (chat, text) => { said.push({ chat, text }); return "msg_" + said.length; };
const pictures = [];
wa.sendWhatsAppImage = async (chat, image) => { pictures.push({ chat, image, at: said.length }); return true; };

const device_routes = (await import("../dist/device/routes.js")).default;
const app = express(); app.use(express.json());
device_routes.registerDeviceRoutes(app);
const server = http.createServer(app);
device_routes.attachHub(server);
const sockets = new Set();
server.on("connection", s => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

// --- the real agent, in a throwaway home ---
const home = fs.mkdtempSync(path.join(os.tmpdir(), "gep-jobs-home-"));
const cfgDir = process.platform === "darwin" ? path.join(home, "Library", "Application Support", "Gepetel") : path.join(home, ".config", "gepetel");
fs.mkdirSync(cfgDir, { recursive: true });
// As the app runs it since the Keychain move: no token in the file at all —
// it arrives as the first line on stdin.
fs.writeFileSync(path.join(cfgDir, "agent.json"), JSON.stringify({ server: BASE, device_id: "d_jobs", ws_url: `ws://127.0.0.1:${PORT}/device/ws` }));
const workspace = path.join(home, "ws");
const agentLog = [];
const agent = spawn(process.execPath, [path.join(here, "..", "agent", "dist", "index.js"), "run"], {
  // Updates (where the job is, what's next) at once, not every 20 s.
  env: { ...process.env, HOME: home, GEPETEL_TEST_TOOLS: "1", GEPETEL_WORKSPACE: workspace, GEPETEL_SECRETS: "stdin", GEPETEL_APP: "1", GEPETEL_UPDATE_MS: "1",
    // A headless, throwaway Chrome — never the person's — for browse.
    ...(hasChrome ? { GEPETEL_BROWSE_MCP_ARGS: "--browser chrome --headless --isolated" } : {}) },
  stdio: ["pipe", "pipe", "pipe"],
});
agent.stdin.write(JSON.stringify({ device_token: TOKEN }) + "\n");
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
const finish = code => { try { agent.kill("SIGTERM"); } catch {} server.close(); fixture.close(); fs.rmSync(home, { recursive: true, force: true }); process.exit(code); };

try {
  check("the token never reached the agent's file", !fs.readFileSync(path.join(cfgDir, "agent.json"), "utf8").includes(TOKEN));
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

  // 4b. A question with a picture (a numbered screenshot, in real life): the
  //     picture first, then the words as a normal, archived message.
  said.length = 0; pictures.length = 0;
  await call("ask_demo", { question: "Which one? Reply with its number.", picture: true });
  check("a question's picture reaches the chat, before its words",
    await until("picture question", () => pictures.length === 1 && said.some(s => /Which one\?/.test(s.text))) &&
      pictures[0].chat === CHAT && pictures[0].image.startsWith("data:image/png;base64,") && pictures[0].at === 0,
    JSON.stringify({ pictures: pictures.map(p => ({ ...p, image: p.image.slice(0, 30) })), said }));
  await call("job", { action: "reply", text: "3" });
  await until("demo done", () => said.some(s => /Hello, 3!/.test(s.text)));

  // 5. A long job says how far it has got, and status shows the latest.
  const longJob = await hub.callTool("d_jobs", "shell",
    { command: "sleep 1; echo '::progress:: page 12/120'; sleep 3; echo done", timeout_s: 900 }, { timeoutMs: 300 });
  check("a long command becomes a job", !!longJob.job, JSON.stringify(longJob));
  check("its progress line reaches the job",
    await until("progress", async () => /page 12\/120/.test((await J.getJob(longJob.job))?.progress || "")), JSON.stringify(await J.getJob(longJob.job)));
  const st = await call("job", { action: "status", job_id: longJob.job });
  check("and status reports it", /running for .*— page 12\/120/.test(text(st)), text(st));
  check("progress is never sent to the chat", !said.some(s => /page 12\/120/.test(s.text)), JSON.stringify(said));
  await until("long done", async () => (await J.getJob(longJob.job))?.status === "done", 10000);

  // 5b. "Stop" while the Mac is offline (a deploy, dropped Wi-Fi): the chat
  //     records it, and the Mac hears it when it is back. On a real Mac the
  //     job ran on for minutes after the chat said it had stopped.
  const offJob = await hub.callTool("d_jobs", "shell", { command: "sleep 60; echo should-never-finish", timeout_s: 900 }, { timeoutMs: 300 });
  check("a job to stop while offline", !!offJob.job, JSON.stringify(offJob));
  await until("off job running", async () => !!(await J.getJob(offJob.job)));
  for (const so of sockets) so.destroy();             // the connection drops…
  await J.setStatus(offJob.job, "cancelled");          // …and the person says stop meanwhile
  const before = agentLog.join("").length;
  check("when the Mac reconnects, it is told, and the job stops",
    await until("cancel after hello", () => new RegExp(`job ${offJob.job} cancelled`).test(agentLog.join("").slice(before)), 20000), agentLog.join("").slice(before, before + 800));
  await new Promise(r => setTimeout(r, 1500));
  check("and nothing of it reaches the chat", !said.some(s => /should-never-finish/.test(s.text)), JSON.stringify(said));

  // 5c. "Stop Everything" in the Mac's menu: the app writes stop-all to the
  //     agent's stdin, and every running job ends — no server involved.
  const a1 = await hub.callTool("d_jobs", "shell", { command: "sleep 60; echo stop-all-missed-1", timeout_s: 900 }, { timeoutMs: 300 });
  const a2 = await hub.callTool("d_jobs", "shell", { command: "sleep 60; echo stop-all-missed-2", timeout_s: 900 }, { timeoutMs: 300 });
  check("two jobs running", !!a1.job && !!a2.job, JSON.stringify([a1, a2]));
  const mark = agentLog.join("").length;
  agent.stdin.write(JSON.stringify({ t: "stop-all" }) + "\n");
  check("stop-all from the app stops both",
    await until("stop-all", () => /stop-all from the app: 2 job\(s\)/.test(agentLog.join("").slice(mark))), agentLog.join("").slice(mark, mark + 600));
  check("and they are finished, not running on",
    await until("jobs ended", async () => !["running", "waiting"].includes((await J.getJob(a1.job))?.status) && !["running", "waiting"].includes((await J.getJob(a2.job))?.status)),
    JSON.stringify([(await J.getJob(a1.job))?.status, (await J.getJob(a2.job))?.status]));
  await new Promise(r => setTimeout(r, 1000));
  check("and nothing of them reaches the chat", !said.some(s => /stop-all-missed/.test(s.text)), JSON.stringify(said));
  check("the chat hears they were stopped on the Mac", said.filter(s => /Stopped from the Gepetel menu|Oprit din meniul/.test(s.text)).length === 2, JSON.stringify(said));
  check("and the rows say cancelled", (await J.getJob(a1.job))?.status === "cancelled" && (await J.getJob(a2.job))?.status === "cancelled");

  // 6. browse: a job from the start, a real browser, the model through
  //    /device/llm, and the answer as its own message.
  if (hasChrome) {
    said.length = 0;
    const t1 = Date.now();
    const b = await call("browse", { goal: "How much was my August bill?", start_url: `http://127.0.0.1:${fixture.address().port}/` });
    check("browse hands back a job within a couple of seconds", /"status":"running"/.test(text(b)) && Date.now() - t1 < 4000, `${Date.now() - t1}ms ${text(b)}`);
    check("the answer arrives in the chat as the computer's own message",
      await until("browse answer", () => said.some(s => /^🖥️ .*131,05 lei, due 15 September/s.test(s.text)), 60000),
      JSON.stringify(said) + agentLog.join("").slice(-800));
    check("while it works, the chat hears where it is and what's next",
      said.some(s => /^🖥️ (On|Pe) 127\.0\.0\.1.*(Next|Urmează): /.test(s.text)), JSON.stringify(said.map(s => s.text.slice(0, 80))));
    check("every model call carried one page, never the one before",
      llmSeen.length >= 2 && !/142,30/.test(llmSeen[llmSeen.length - 1]), JSON.stringify(llmSeen.map(x => x.slice(0, 80))));
    check("the job is done", /done/.test(text(await call("job", { action: "status" }))));
  } else console.log("  (skipped browse: no Google Chrome here)");

  // 7. The live takeover link (Phase 6).
  if (hasChrome) {
    said.length = 0;
    await call("browse", { goal: "get past the check", start_url: `http://127.0.0.1:${fixture.address().port}/check` });
    check("a handoff puts a one-time link in the chat",
      await until("link", () => said.some(s => /(The link|Linkul) .*\/t\/[A-Za-z0-9_-]{40,}/s.test(s.text)), 30000), JSON.stringify(said));
    const url = said.map(s => s.text.match(/(http:\/\/[^\s]+\/t\/[A-Za-z0-9_-]+)/)?.[1]).find(Boolean);
    const pageRes = await fetch(url);
    const csp = pageRes.headers.get("content-security-policy") || "";
    check("the link serves the live page, locked down", pageRes.status === 200 && /default-src 'none'/.test(csp) && pageRes.headers.get("cache-control") === "no-store", `${pageRes.status} ${csp}`);

    const frames = [];
    const viewer = new WS(url.replace(/^http/, "ws") + "/ws");
    viewer.on("message", raw => { const m = JSON.parse(String(raw)); if (m.t === "frame") frames.push({ ...m, at: Date.now() }); });
    await new Promise((r, j) => { viewer.on("open", r); viewer.on("error", j); });
    check("frames arrive from the Mac", await until("frame", () => frames.length > 0, 15000), agentLog.join("").slice(-500));
    const second = new WS(url.replace(/^http/, "ws") + "/ws");
    check("a second viewer is refused while the first is live",
      await new Promise(r => { second.on("open", () => r(false)); second.on("error", () => r(true)); second.on("unexpected-response", () => r(true)); }));

    // Tap the target's centre as the phone page would, at three display widths.
    const f = frames[frames.length - 1];
    let worst = 0;
    for (const shown of [360, 720, 1280]) {
      const shownH = shown * f.h / f.w;
      const tx = 400 * shown / f.w + 0.37, ty = 400 * shownH / f.h + 0.61;   // where a finger lands, on screen
      lastHit = null;
      viewer.send(JSON.stringify({ kind: "tap", x: tx * f.w / shown, y: ty * f.h / shownH }));
      await until("hit", () => !!lastHit, 10000);
      worst = Math.max(worst, Math.abs(Number(lastHit?.x) - 400), Math.abs(Number(lastHit?.y) - 400));
    }
    check("taps land within ±4 CSS px at three display sizes", worst <= 4, `off by ${worst}px`);

    // The phone's own screen size no longer resizes the page: phone or
    // desktop is Gepetel's window size, set by the job (resizing the page
    // was an emulation Chrome dropped whenever it took the tab — the page
    // flipped between phone and desktop). Frames say where the text fields
    // are, so the phone can open its keyboard on a tap.
    const before = frames[frames.length - 1];
    viewer.send(JSON.stringify({ kind: "viewport", w: 390, h: 760 }));
    await new Promise(r => setTimeout(r, 2000));
    check("the phone's size leaves the page as it is", !frames.some(f => f.w === 390), JSON.stringify(frames.slice(-3).map(f => [f.w, f.h])));
    const pf = frames[frames.length - 1] || before;
    check("frames say where the text fields are", Array.isArray(pf?.fields) && pf.fields.length >= 1, JSON.stringify(pf?.fields));
    const [fx, fy, fw, fh] = pf?.fields?.[0] || [0, 0, 0, 0];
    viewer.send(JSON.stringify({ kind: "tap", x: fx + fw / 2, y: fy + fh / 2 }));
    for (const m of [{ kind: "text", text: "abc" }, { kind: "key", key: "Backspace" }, { kind: "text", text: "d" }]) viewer.send(JSON.stringify(m));
    check("typing lands in the field, in order (abc ⌫ d → abd)", await until("typed", () => lastTyped === "abd", 20000), `got ${JSON.stringify(lastTyped)}`);

    const span = (frames[frames.length - 1].at - frames[0].at) / 1000 || 1;
    const kbps = frames.reduce((n, x) => n + x.b64.length * 0.75, 0) / 1024 / Math.max(1, span);
    check("frames stay under 150 KB/s", kbps <= 150, `${kbps.toFixed(0)} KB/s over ${frames.length} frames`);

    said.length = 0;
    viewer.send(JSON.stringify({ kind: "done" }));
    check("Done resumes the job, which finishes",
      await until("resumed", () => said.some(s => /Past the check\./.test(s.text)), 30000), JSON.stringify(said));
    check("the step log says the person took over",
      llmSeen.some(t => /the person took over for \d+m/.test(t)));
    check("and the link is dead afterwards", (await fetch(url)).status === 410);
    const late = new WS(url.replace(/^http/, "ws") + "/ws");
    check("its socket too", await new Promise(r => { late.on("open", () => r(false)); late.on("error", () => r(true)); late.on("unexpected-response", () => r(true)); }));
    viewer.close();
  }

  // 8. One browsing job at a time: a job waiting on the person, then a new
  //    request — the older one is left, and the chat is told (OLX, 2026-10-13:
  //    two jobs drove one Chrome, tab against tab).
  if (hasChrome) {
    said.length = 0;
    const first = await call("browse", { goal: "get past the check", start_url: `http://127.0.0.1:${fixture.address().port}/check` });
    await until("the first job asks", () => said.some(s => /\/t\/[A-Za-z0-9_-]{40,}/.test(s.text)), 30000);
    const firstId = text(first).match(/"job":"(j_[^"]+)"/)?.[1];
    await call("browse", { goal: "How much was my August bill?", start_url: `http://127.0.0.1:${fixture.address().port}/` });
    check("a newer browse job replaces the one waiting — and the chat hears so",
      await until("replaced", () => said.some(s => /Left for your newer request|cererea ta mai nouă/.test(s.text)), 20000), JSON.stringify(said));
    check("the older job's row says cancelled", (await J.getJob(firstId))?.status === "cancelled", String((await J.getJob(firstId))?.status));
    check("and the newer one answers", await until("second answer", () => said.some(s => /131,05 lei/.test(s.text)), 60000), JSON.stringify(said));
  }

  // 9. The viewer on a phone, touched like one: Back and Done (the owner,
  //    2026-10-13: "when I click back or done, nothing happens"), and a tap
  //    held a moment without moving is a tap, not an empty drag.
  if (hasChrome) {
    said.length = 0;
    const ext = path.join(here, "..", "agent", "node_modules", "playwright", "index.js");
    const pw = await import(ext); const { chromium, devices } = pw.default ?? pw;
    await call("browse", { goal: "get past the check", start_url: `http://127.0.0.1:${fixture.address().port}/check` });
    await until("link", () => said.some(s => /\/t\/[A-Za-z0-9_-]{40,}/.test(s.text)), 30000);
    const url = said.map(s => s.text.match(/(http:\/\/[^\s]+\/t\/[A-Za-z0-9_-]+)/)?.[1]).find(Boolean);
    const phoneBrowser = await chromium.launch({ channel: "chrome", headless: true });
    const phone = await phoneBrowser.newContext({ ...devices["iPhone 13"] });
    const pg = await phone.newPage();
    await pg.goto(url);
    await pg.waitForFunction(() => document.getElementById("screen")?.naturalWidth > 0, null, { timeout: 15000 });
    const logFrom = agentLog.join("").length;
    const since = () => agentLog.join("").slice(logFrom);
    // A finger resting a moment on the page, not moving: a tap.
    const box = await pg.locator("#screen").boundingBox();
    const cdp = await phone.newCDPSession(pg);
    const tx = box.x + box.width / 2, ty = box.y + box.height / 2;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: tx, y: ty }] });
    await new Promise(r => setTimeout(r, 600));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    check("a tap held a moment is a tap, not an empty drag", await until("slow tap", () => /takeover: input tap/.test(since()), 10000) && !/takeover: input drag/.test(since()), since().slice(-400));
    // The phone switched to the chat and back: its socket dropped.
    await pg.evaluate(() => { /* as iOS does when the page goes to the background */ });
    await phone.setOffline(true); await new Promise(r => setTimeout(r, 1500)); await phone.setOffline(false);
    await pg.tap("#back");
    check("Back on the phone reaches the Mac — and shows it was pressed", await until("back", () => /takeover: input back/.test(since()), 15000) && /Back/.test(await pg.locator("#status").textContent()), since().slice(-400));
    await pg.tap("#done");
    check("Done on the phone resumes the job", await until("done", () => said.some(s => /Past the check\./.test(s.text)), 30000), since().split("\n").filter(l => /takeover|browse|back|forward/.test(l)).slice(-30).join("\n"));
    await phoneBrowser.close();
  }

  // 5. Jobs belong to their chat.
  const foreign = await call("job", { action: "status", job_id: "j_not_mine" });
  check("an unknown job id is 'no such job', whatever it is", foreign.result?.isError === true && /no such job/.test(text(foreign)), text(foreign));
} catch (e) {
  console.error(e); failures++;
}
console.log(failures ? `\n${failures} FAILED` : "\nall green");
finish(failures ? 1 : 0);
