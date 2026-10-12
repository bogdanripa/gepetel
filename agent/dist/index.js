// The Gepetel agent: a small daemon on the owner's Mac.
//
// It dials OUT to Gepetel and keeps one WebSocket open. Nothing listens on the
// Mac, no port is forwarded, no tunnel is involved, and the only credential on
// disk is a device token this machine was given when somebody typed a six-digit
// code into their own WhatsApp chat.
//
// Phase 0 answers exactly one tool, `computer_status`. The shape around it —
// pairing, reconnect, heartbeat, the call/result protocol — is the part that has
// to be right before anything more interesting is bolted on.
import { WebSocket } from "ws";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
const VERSION = "0.1.0";
/** Phase 0 can do one thing; the relay filters the tool list by this. */
const CAPABILITIES = ["status"];
const DEFAULT_SERVER = process.env.GEPETEL_SERVER || "https://gepetel.com";
function configDir() {
    // macOS convention, and it works on Linux too for development.
    const home = os.homedir();
    return process.platform === "darwin"
        ? path.join(home, "Library", "Application Support", "Gepetel")
        : path.join(home, ".config", "gepetel");
}
const CONFIG_FILE = () => path.join(configDir(), "agent.json");
function readConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_FILE(), "utf8");
        const c = JSON.parse(raw);
        return c?.device_token ? c : null;
    }
    catch {
        return null;
    }
}
function writeConfig(c) {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 0600 before anything is written: the token must never exist on disk, even
    // for an instant, in a file another local user could open.
    const fd = fs.openSync(CONFIG_FILE(), "w", 0o600);
    try {
        fs.writeSync(fd, JSON.stringify(c, null, 2));
    }
    finally {
        fs.closeSync(fd);
    }
    fs.chmodSync(CONFIG_FILE(), 0o600);
}
async function pair(code, server = DEFAULT_SERVER) {
    const clean = String(code || "").replace(/\D/g, "");
    if (clean.length !== 6) {
        console.error("Usage: gepetel-agent pair <6-digit code>");
        process.exit(2);
    }
    const res = await fetch(`${server}/device/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            code: clean,
            device_name: os.hostname(),
            os: `${os.type()} ${os.release()}`,
            arch: os.arch(),
            agent_version: VERSION,
            capabilities: CAPABILITIES,
        }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`Pairing failed (${res.status}). ${body.slice(0, 200)}`);
        process.exit(1);
    }
    const out = await res.json();
    writeConfig({
        server,
        device_id: out.device_id,
        device_token: out.device_token,
        ws_url: out.ws_url || `${server.replace(/^http/, "ws")}/device/ws`,
    });
    console.log(`Paired. Device ${out.device_id}. Now run: gepetel-agent run`);
}
/** Everything this agent can currently be asked to do. */
async function runTool(tool, _args) {
    if (tool === "computer_status") {
        const up = Math.round(os.uptime() / 60);
        const upText = up >= 120 ? `${Math.round(up / 60)}h` : `${up}m`;
        return {
            ok: true,
            content: [
                `${os.hostname()} — ${os.type()} ${os.release()} (${os.arch()})`,
                `agent ${VERSION}, up ${upText}`,
                `can: ${CAPABILITIES.join(", ")}`,
            ].join("\n"),
        };
    }
    return { ok: false, content: `This agent does not know "${tool}" yet.` };
}
function run() {
    const cfg = readConfig();
    if (!cfg) {
        console.error("Not paired. Ask Gepetel to connect your computer, then run: gepetel-agent pair <code>");
        process.exit(2);
    }
    let backoff = 1000;
    const MAX_BACKOFF = 60_000;
    let stopping = false;
    const connect = () => {
        const ws = new WebSocket(cfg.ws_url, { headers: { Authorization: `Bearer ${cfg.device_token}` } });
        let alive = true;
        ws.on("open", () => {
            backoff = 1000; // a connection that opened resets the ladder
            console.log(`connected to ${cfg.ws_url}`);
            ws.send(JSON.stringify({ t: "hello", agent_version: VERSION, capabilities: CAPABILITIES }));
        });
        ws.on("message", async (raw) => {
            let msg;
            try {
                msg = JSON.parse(String(raw));
            }
            catch {
                return;
            }
            if (msg?.t !== "call" || !msg.id)
                return;
            // Run it, then answer. A tool that throws still gets a result:
            // silence would leave the other side waiting out its whole timeout.
            let out;
            try {
                out = await runTool(String(msg.tool || ""), msg.args || {});
            }
            catch (e) {
                out = { ok: false, content: `Failed: ${e?.message || e}` };
            }
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ t: "result", id: msg.id, ok: out.ok, content: out.content }));
            }
        });
        ws.on("close", code => {
            alive = false;
            if (stopping)
                return;
            if (code === 1008 || code === 4001) {
                console.error("The server rejected this device. Pair again: gepetel-agent pair <code>");
                process.exit(1);
            }
            schedule();
        });
        ws.on("error", err => {
            if (!alive)
                return;
            console.error(`socket error: ${err?.message || err}`);
        });
        ws.on("unexpected-response", (_req, res) => {
            alive = false;
            if (res.statusCode === 401) {
                console.error("This device is no longer paired (401). Pair again: gepetel-agent pair <code>");
                process.exit(1);
            }
            console.error(`server said ${res.statusCode}`);
            schedule();
        });
    };
    const schedule = () => {
        if (stopping)
            return;
        // Jittered, so a server restart does not bring every agent back at the
        // same instant.
        const wait = Math.min(backoff, MAX_BACKOFF) * (0.5 + Math.random());
        console.log(`reconnecting in ${Math.round(wait / 1000)}s`);
        setTimeout(connect, wait);
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
    };
    for (const sig of ["SIGINT", "SIGTERM"]) {
        process.on(sig, () => { stopping = true; console.log("stopping"); process.exit(0); });
    }
    connect();
}
function unpair() {
    try {
        fs.unlinkSync(CONFIG_FILE());
        console.log("Unpaired locally. Also remove it from the chat to revoke the token.");
    }
    catch {
        console.log("Nothing to unpair.");
    }
}
const [, , cmd, arg] = process.argv;
switch (cmd) {
    case "pair":
        await pair(arg || "");
        break;
    case "run":
        run();
        break;
    case "unpair":
        unpair();
        break;
    default:
        console.log("gepetel-agent <pair CODE | run | unpair>");
        process.exit(cmd ? 2 : 0);
}
