#!/usr/bin/env node
// The Gepetel agent: a small daemon on the owner's Mac.
//
// It dials OUT to Gepetel and keeps one WebSocket open. Nothing listens on the
// Mac, no port is forwarded, no tunnel is involved, and the only credential on
// disk is a device token this machine was given when somebody typed a six-digit
// code into their own WhatsApp chat.
//
// It answers `computer_status`, `fetch_url` and `shell` — "is the Mac on?",
// "read this page and give me only the part I asked about", and "run this, in a
// Linux VM that cannot see my files". The shape around them — pairing,
// reconnect, heartbeat, the call/result protocol — is the part that had to be
// right before anything more interesting was bolted on.
import { WebSocket } from "ws";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fetchUrl } from "./fetchUrl.js";
import { ContainerSandbox, DEFAULT_TIMEOUT_S, workspaceDir } from "./sandbox.js";

const VERSION = "0.3.0";
/** What this agent can do, as the relay filters its published tool list.
 *
 *  `shell` is **conditional, and re-checked on every connect**: it needs
 *  Apple's `container`, which needs an Apple-silicon Mac and an image somebody
 *  has to build. Advertising it regardless would offer the model a tool that
 *  fails on a computer which is otherwise perfectly fine — the Phase 1 lesson.
 *  A Mac without it reports *why* instead, through computer_status. */
const BASE_CAPABILITIES = ["status", "fetch"];

/** Built once the config is known, since it carries the network setting. */
let sandbox: ContainerSandbox | null = null;

async function capabilities(): Promise<string[]> {
    const can = [...BASE_CAPABILITIES];
    if (sandbox && (await sandbox.available()).ok) can.push("shell");
    return can;
}

const DEFAULT_SERVER = process.env.GEPETEL_SERVER || "https://gepetel.com";

function configDir(): string {
    // macOS convention, and it works on Linux too for development.
    const home = os.homedir();
    return process.platform === "darwin"
        ? path.join(home, "Library", "Application Support", "Gepetel")
        : path.join(home, ".config", "gepetel");
}

const CONFIG_FILE = () => path.join(configDir(), "agent.json");

type Config = {
    server: string; device_id: string; device_token: string; ws_url: string;
    /** The spec's `shell.network`, per device. On by default — the whole point
     *  of having curl in there — and worth having before the menu-bar app
     *  exists, because somebody installing this on a work laptop may well want
     *  the sandbox off the network entirely. */
    shell_network?: boolean;
};

/** Keep in step with CALL_TIMEOUT_MS in src/device/hub.ts. Past this, the relay
 *  has already answered with a job id and is no longer listening for a result. */
const PROMOTE_AFTER_MS = 20_000;

/** What the person reads in WhatsApp when a long job finishes.
 *
 *  The agent writes it, not the model: delivery costs no tokens and nothing is
 *  re-worded on the way. One line saying which command it was — a result that
 *  arrives minutes later with no idea what it answers is a puzzle, not news. */
function eventText(call: any, out: { ok: boolean; content: string }): string {
    const what = String(call?.tool === "shell" ? (call?.args?.command ?? "") : (call?.args?.url ?? "")).slice(0, 120);
    const ro = String(call?.chat_lang || "") === "Romanian";
    const head = ro
        ? (out.ok ? `Gata: \`${what}\`` : `N-a mers: \`${what}\``)
        : (out.ok ? `Done: \`${what}\`` : `Failed: \`${what}\``);
    return `${head}\n${out.content}`.slice(0, 1500);
}

function makeSandbox(cfg: Config | null): ContainerSandbox {
    return new ContainerSandbox({ network: cfg?.shell_network !== false });
}

function readConfig(): Config | null {
    try {
        const raw = fs.readFileSync(CONFIG_FILE(), "utf8");
        const c = JSON.parse(raw);
        return c?.device_token ? c : null;
    } catch { return null; }
}

function writeConfig(c: Config): void {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 0600 before anything is written: the token must never exist on disk, even
    // for an instant, in a file another local user could open.
    const fd = fs.openSync(CONFIG_FILE(), "w", 0o600);
    try { fs.writeSync(fd, JSON.stringify(c, null, 2)); } finally { fs.closeSync(fd); }
    fs.chmodSync(CONFIG_FILE(), 0o600);
}

async function pair(code: string, server = DEFAULT_SERVER): Promise<void> {
    const clean = String(code || "").replace(/\D/g, "");
    if (clean.length !== 6) {
        console.error("Usage: gepetel-agent pair <6-digit code>");
        process.exit(2);
    }
    // Probe here too, so the very first tools/list after pairing is already
    // right rather than waiting for the first reconnect.
    sandbox = makeSandbox(null);
    const res = await fetch(`${server}/device/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            code: clean,
            device_name: os.hostname(),
            os: `${os.type()} ${os.release()}`,
            arch: os.arch(),
            agent_version: VERSION,
            capabilities: await capabilities(),
        }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`Pairing failed (${res.status}). ${body.slice(0, 200)}`);
        process.exit(1);
    }
    const out: any = await res.json();
    writeConfig({
        server,
        device_id: out.device_id,
        device_token: out.device_token,
        ws_url: out.ws_url || `${server.replace(/^http/, "ws")}/device/ws`,
    });
    console.log(`Paired. Device ${out.device_id}. Now run: gepetel-agent run`);
}

/** Everything this agent can currently be asked to do.
 *
 *  `meta` is for the relay's log and nothing else — it never reaches the model.
 *  The spec wants the saving measured against `read_url` for the first fifty
 *  calls, and the only side that can report the page's own size is this one. */
async function runTool(tool: string, args: Record<string, unknown>):
        Promise<{ ok: boolean; content: string; meta?: Record<string, unknown> }> {
    if (tool === "fetch_url") {
        const r = await fetchUrl(args as any);
        return { ok: r.ok, content: r.content, meta: r.rawChars ? { raw_chars: r.rawChars } : undefined };
    }
    if (tool === "shell") {
        if (!sandbox) return { ok: false, content: "The sandbox isn't set up on this computer." };
        const r = await sandbox.run(
            String((args as any).command ?? ""),
            Number((args as any).timeout_s) || DEFAULT_TIMEOUT_S,
            { reset: !!(args as any).reset },
        );
        return { ok: r.ok, content: r.content };
    }
    if (tool === "computer_status") {
        const up = Math.round(os.uptime() / 60);
        const upText = up >= 120 ? `${Math.round(up / 60)}h` : `${up}m`;
        const can = await capabilities();
        const lines = [
            `${os.hostname()} — ${os.type()} ${os.release()} (${os.arch()})`,
            `agent ${VERSION}, up ${upText}`,
            `can: ${can.join(", ")}`,
        ];
        // Why, not just whether. "I can't run commands" with no reason is the
        // least useful thing this tool could say, and every reason is something
        // the person can act on: install the runtime, build the image.
        if (sandbox && !can.includes("shell")) lines.push((await sandbox.available()).why);
        return { ok: true, content: lines.join("\n") };
    }
    return { ok: false, content: `This agent does not know "${tool}" yet.` };
}

function run(): void {
    const cfg = readConfig();
    if (!cfg) {
        console.error("Not paired. Ask Gepetel to connect your computer, then run: gepetel-agent pair <code>");
        process.exit(2);
    }

    sandbox = makeSandbox(cfg);

    let backoff = 1000;
    const MAX_BACKOFF = 60_000;
    let stopping = false;

    const connect = () => {
        const ws = new WebSocket(cfg.ws_url, { headers: { Authorization: `Bearer ${cfg.device_token}` } });
        let alive = true;

        ws.on("open", async () => {
            backoff = 1000;   // a connection that opened resets the ladder
            // Probed per connection, not at startup: somebody installs the
            // runtime, restarts nothing, and the next reconnect picks it up.
            const can = await capabilities();
            console.log(`connected to ${cfg.ws_url} — can: ${can.join(", ")}`);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ t: "hello", agent_version: VERSION, capabilities: can }));
            }
        });

        ws.on("message", async raw => {
            let msg: any;
            try { msg = JSON.parse(String(raw)); } catch { return; }
            if (msg?.t !== "call" || !msg.id) return;
            // Run it, then answer. A tool that throws still gets a result:
            // silence would leave the other side waiting out its whole timeout.
            const started = Date.now();
            let out: { ok: boolean; content: string; meta?: Record<string, unknown> };
            try { out = await runTool(String(msg.tool || ""), msg.args || {}); }
            catch (e: any) { out = { ok: false, content: `Failed: ${e?.message || e}` }; }
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ t: "result", id: msg.id, ok: out.ok, content: out.content, meta: out.meta }));
                // The relay stops waiting at PROMOTE_AFTER_MS and hands the
                // caller a job id, which means the result above is dropped on
                // arrival. So anything that took longer than that is ALSO sent
                // as an event, which is the path that reaches the chat. Sending
                // both is deliberate: the relay ignores a result for a call it
                // has already promoted, and guessing which side of the line we
                // landed on would lose the answer whenever we guessed wrong.
                if (msg.job && Date.now() - started > PROMOTE_AFTER_MS) {
                    ws.send(JSON.stringify({
                        t: "event", job: msg.job, kind: out.ok ? "done" : "failed",
                        text: eventText(msg, out),
                    }));
                }
            }
        });

        ws.on("close", code => {
            alive = false;
            if (stopping) return;
            if (code === 1008 || code === 4001) {
                console.error("The server rejected this device. Pair again: gepetel-agent pair <code>");
                process.exit(1);
            }
            schedule();
        });
        ws.on("error", err => {
            if (!alive) return;
            console.error(`socket error: ${(err as any)?.message || err}`);
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
        if (stopping) return;
        // Jittered, so a server restart does not bring every agent back at the
        // same instant.
        const wait = Math.min(backoff, MAX_BACKOFF) * (0.5 + Math.random());
        console.log(`reconnecting in ${Math.round(wait / 1000)}s`);
        setTimeout(connect, wait);
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
    };

    for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.on(sig, () => { stopping = true; console.log("stopping"); process.exit(0); });
    }
    connect();
}

/**
 * `gepetel-agent selftest` — prove the sandbox is a sandbox, on this Mac.
 *
 * It exists because the claims that matter most about `shell` are the ones that
 * cannot be checked anywhere but here. A test suite on a Linux CI box can prove
 * the queueing, the timeout plumbing and the exact argv; only this machine can
 * prove that `ls /Users` shows nothing of yours and that your SSH keys are out
 * of reach. Those are the spec's acceptance criteria, and this runs them.
 *
 * Run it after building the image, and again any time you change the setup.
 */
async function selftest(): Promise<void> {
    const cfg = readConfig();
    sandbox = makeSandbox(cfg);
    const av = await sandbox.available();
    console.log(av.ok ? `sandbox: ${av.why}` : `sandbox unavailable — ${av.why}`);
    if (!av.ok) process.exit(1);
    const ws = workspaceDir();
    console.log(`workspace: ${ws}`);
    console.log(`network in the sandbox: ${cfg?.shell_network === false ? "off" : "on"}\n`);

    const nonce = `n${Date.now().toString(36)}`;
    let failed = 0;
    const check = async (name: string, fn: () => Promise<[boolean, string]>) => {
        let pass = false, detail = "";
        try { [pass, detail] = await fn(); }
        catch (e: any) { detail = `threw: ${e?.message || e}`; }
        console.log(`${pass ? "  ok   " : "  FAIL " }${name}${detail ? `  — ${detail}` : ""}`);
        if (!pass) failed++;
    };
    const sh = async (cmd: string, t = 30) => (await sandbox!.run(cmd, t)).content;

    await check("the Mac's home is not in there", async () => {
        const out = await sh("ls -a /Users 2>&1 | head -20; echo ---; ls -a /host 2>&1 | head -5");
        const leaked = out.includes(os.userInfo().username) || /Desktop|Documents|Library/.test(out);
        return [!leaked, leaked ? out.replace(/\n/g, " | ").slice(0, 160) : "nothing of yours is visible"];
    });

    await check("SSH keys are out of reach", async () => {
        const out = await sh("cat ~/.ssh/id_* /Users/*/.ssh/id_* /host/.ssh/id_* 2>&1 | head -5");
        return [!/BEGIN [A-Z ]*PRIVATE KEY/.test(out), "no key material came back"];
    });

    await check("a file written to /workspace lands on the Mac", async () => {
        await sh(`printf '%s' ${nonce} > /workspace/gepetel-selftest.txt`);
        const onHost = path.join(ws, "gepetel-selftest.txt");
        const got = fs.existsSync(onHost) ? fs.readFileSync(onHost, "utf8").trim() : "(missing)";
        try { fs.unlinkSync(onHost); } catch { /* fine */ }
        return [got === nonce, got === nonce ? onHost : `read back ${JSON.stringify(got)}`];
    });

    await check("a command that overruns is killed", async () => {
        const t0 = Date.now();
        const out = await sh("sleep 30", 2);
        const took = (Date.now() - t0) / 1000;
        return [/killed after 2s/.test(out) && took < 15, `${out.split("\n")[0]} (returned in ${took.toFixed(1)}s)`];
    });

    await check("a wall of output is clipped, not forwarded", async () => {
        const out = await sh("yes gepetel | head -c 200000");
        return [out.length < 5000 && /characters omitted/.test(out), `${out.length} chars came back`];
    });

    await check("what you install stays installed", async () => {
        // Not --rm: the container is stopped when idle, never removed, which is
        // the difference between a sandbox and a toy.
        await sh(`echo ${nonce} > /tmp/gepetel-persist`);
        const out = await sh("cat /tmp/gepetel-persist 2>&1");
        return [out.includes(nonce), out.split("\n").slice(0, 2).join(" | ")];
    });

    await check("the network is as configured", async () => {
        const out = await sh("curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com 2>&1", 20);
        const reachable = /\b200\b/.test(out);
        const wanted = cfg?.shell_network !== false;
        return [reachable === wanted, reachable ? "the sandbox can reach the internet" : "the sandbox has no network"];
    });

    await check("a reset gives a clean sandbox", async () => {
        const out = (await sandbox!.run("cat /tmp/gepetel-persist 2>&1; echo done", 60, { reset: true })).content;
        return [!out.includes(nonce), out.includes(nonce) ? "the old container survived a reset" : "fresh container"];
    });

    console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
    sandbox.stop();
    process.exit(failed ? 1 : 0);
}

function unpair(): void {
    try { fs.unlinkSync(CONFIG_FILE()); console.log("Unpaired locally. Also remove it from the chat to revoke the token."); }
    catch { console.log("Nothing to unpair."); }
}

const [, , cmd, arg] = process.argv;
switch (cmd) {
    case "pair": await pair(arg || ""); break;
    case "run": run(); break;
    case "selftest": await selftest(); break;
    case "unpair": unpair(); break;
    default:
        console.log("gepetel-agent <pair CODE | run | selftest | unpair>");
        process.exit(cmd ? 2 : 0);
}
