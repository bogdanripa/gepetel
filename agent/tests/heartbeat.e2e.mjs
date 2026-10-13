// The Mac's own heartbeat: a connection that goes dead without closing (a
// phone hotspot, 2026-10-13 — the relay dropped the Mac, the Mac's socket
// still looked open, the menu said "working" and the chat said "offline")
// is noticed, and the agent connects again.
//
// The real agent (dist/index.js run) talks to a stand-in relay through a TCP
// proxy; the proxy then swallows everything in both directions, the way a dead
// network path does, and keeps both sockets open.
//   npm run build && node tests/heartbeat.e2e.mjs
import net from "node:net"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawn } from "node:child_process"; import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "  ok  " : "FAIL  "}${name}${cond ? "" : " — " + extra}`); if (!cond) failures++; };
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };

// The stand-in relay: counts hellos.
const hellos = [];
const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise(r => wss.on("listening", r));
wss.on("connection", ws => ws.on("message", m => { try { if (JSON.parse(String(m)).t === "hello") hellos.push(Date.now()); } catch {} }));

// The network in between. dead = everything is swallowed, nothing is closed.
let dead = false;
const proxy = net.createServer(client => {
  const up = net.connect(wss.address().port, "127.0.0.1");
  client.on("data", d => { if (!dead) up.write(d); });
  up.on("data", d => { if (!dead) client.write(d); });
  client.on("error", () => {}); up.on("error", () => {});
  client.on("close", () => up.destroy()); up.on("close", () => { if (!dead) client.destroy(); });
});
await new Promise(r => proxy.listen(0, "127.0.0.1", r));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "gep-hb-home-"));
const cfgDir = process.platform === "darwin" ? path.join(home, "Library", "Application Support", "Gepetel") : path.join(home, ".config", "gepetel");
fs.mkdirSync(cfgDir, { recursive: true });
fs.writeFileSync(path.join(cfgDir, "agent.json"), JSON.stringify({ server: "http://127.0.0.1:9", device_id: "d_hb", ws_url: `ws://127.0.0.1:${proxy.address().port}/device/ws` }));
const log = [];
const agent = spawn(process.execPath, [path.join(here, "..", "dist", "index.js"), "run"], {
  env: { ...process.env, HOME: home, GEPETEL_WORKSPACE: path.join(home, "ws"), GEPETEL_SECRETS: "stdin", GEPETEL_APP: "1", GEPETEL_PING_MS: "500" },
  stdio: ["pipe", "pipe", "pipe"],
});
agent.stdin.write(JSON.stringify({ device_token: "t" }) + "\n");
agent.stdout.on("data", d => log.push(String(d))); agent.stderr.on("data", d => log.push(String(d)));

check("the agent connects", await until(() => hellos.length === 1, 10000), log.join("").slice(-300));
await new Promise(r => setTimeout(r, 2000));
check("a live connection is left alone (pongs come back)", hellos.length === 1 && !/no word from the server/.test(log.join("")), log.join("").slice(-300));
dead = true;
const t0 = Date.now();
check("a dead path is noticed", await until(() => /no word from the server/.test(log.join("")), 10000), log.join("").slice(-300));
dead = false;
check("and the agent connects again", await until(() => hellos.length === 2, 10000), log.join("").slice(-300));
console.log(`    noticed and back in ${((Date.now() - t0) / 1000).toFixed(1)} s (pings every 0.5 s here; 20 s on a Mac)`);

agent.kill(); proxy.close(); wss.close();
fs.rmSync(home, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
