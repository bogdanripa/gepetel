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
// sandbox that cannot see my files". The shape around them — pairing,
// reconnect, heartbeat, the call/result protocol — is the part that had to be
// right before anything more interesting was bolted on.
import { WebSocket } from "ws";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fetchUrl } from "./fetchUrl.js";
import { Sandbox, DEFAULT_TIMEOUT_S, workspaceDir } from "./sandbox.js";
import { sendFile, type Image } from "./sendFile.js";
import { Outbox } from "./outbox.js";
import { McpClient } from "./mcpClient.js";
import { browse } from "./browse.js";
import { Takeover } from "./takeover.js";
import { RecipeStore } from "./recipes.js";
import { EXTENSION_ID } from "./extension.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const VERSION = "0.10.1";
/** What this agent can do, as the relay filters its published tool list.
 *
 *  `shell` is **conditional, and re-checked on every connect**: it needs the
 *  sandbox to start on this machine. Advertising it regardless would offer the
 *  model a tool that fails on a computer which is otherwise perfectly fine —
 *  the Phase 1 lesson. A Mac without it reports *why* instead, through
 *  computer_status. */
const BASE_CAPABILITIES = ["status", "fetch", "send"];

/** Built once the config is known, since it carries the network setting. */
let sandbox: Sandbox | null = null;

/** `ask_demo`, a tool that only exists to exercise the question-and-answer
 *  loop end to end before the browser needs it. Never on in a real install. */
const TEST_TOOLS = process.env.GEPETEL_TEST_TOOLS === "1";

/** The config this process runs with, once `run` has read it. */
let config: Config | null = null;

/** How to start Playwright MCP: against the person's Chrome through the
 *  Playwright Extension (the token they pasted into the app), or — tests only
 *  — whatever GEPETEL_BROWSE_MCP_ARGS says, e.g. a headless throwaway Chrome. */
function browserCommand(): { args: string[]; env: NodeJS.ProcessEnv } | null {
    let cli: string;
    // Through package.json: the package exports neither cli.js nor any
    // other subpath, so resolving "…/cli.js" directly throws.
    try { cli = path.join(path.dirname(createRequire(import.meta.url).resolve("@playwright/mcp/package.json")), "cli.js"); }
    catch { return null; }
    const test = process.env.GEPETEL_BROWSE_MCP_ARGS;
    if (test) return { args: [cli, ...test.split(" ").filter(Boolean), "--caps=vision"], env: process.env };
    const token = config?.chrome_token;
    if (!token) return null;
    const chrome = chromeExecutable();
    // With Gepetel's own extension, Playwright is pointed at a stand-in for
    // Chrome that rewrites its connect page to our extension's id.
    const ours = config?.chrome_extension === "gepetel" && chrome;
    const opener = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "bin", "open-chrome");
    return {
        // vision: coordinate clicks and the wheel, for the takeover link only
        // — the model is never given those tools.
        args: [cli, "--extension", "--caps=vision", ...(config?.chrome_profile ? ["--profile-dir-name", config.chrome_profile] : [])],
        env: {
            ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token,
            // Given Chrome's program, Playwright opens its connect page in the
            // running Chrome and never reads Chrome's profile folder. Without
            // it, it reads that folder to check the extension is installed —
            // and macOS denies other apps that folder, so it refused with
            // "Playwright Extension not found" on a Mac where it was.
            ...(ours
                ? { PLAYWRIGHT_MCP_EXECUTABLE_PATH: opener, GEPETEL_REAL_CHROME: chrome, GEPETEL_EXTENSION_ID: EXTENSION_ID }
                : chrome ? { PLAYWRIGHT_MCP_EXECUTABLE_PATH: chrome } : {}),
        },
    };
}


/** Chrome's program: from the app (which asks macOS where Chrome is), else
 *  the usual places. Never from Chrome's profile folder. */
function chromeExecutable(): string | null {
    const fromApp = process.env.GEPETEL_CHROME;
    const candidates = [
        ...(fromApp ? [path.join(fromApp, "Contents", "MacOS", "Google Chrome")] : []),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
    ];
    return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
}

async function capabilities(): Promise<string[]> {
    // "jobs": this agent understands cancel and reply, and keeps an outbox.
    const can = [...BASE_CAPABILITIES, "jobs", ...(TEST_TOOLS ? ["demo"] : [])];
    if (browserCommand()) can.push("browse");
    if (sandbox && (await sandbox.available()).ok) can.push("shell");
    return can;
}

const DEFAULT_SERVER = process.env.GEPETEL_SERVER || "https://gepetel.com";

/** For the menu-bar app, which runs this as its child and reads stdout.
 *
 *  One line per change, `@status {"state":…}`, so the app never has to parse
 *  prose meant for a person — and the prose can keep changing. Only printed
 *  when the app asks (GEPETEL_APP=1): on a terminal it is noise. States:
 *  connecting, online, busy, offline (between attempts), unpaired (stop
 *  restarting me; a new code is needed). */
function status(state: "connecting" | "online" | "busy" | "offline" | "unpaired", detail = ""): void {
    if (process.env.GEPETEL_APP !== "1") return;
    console.log(`@status ${JSON.stringify({ state, detail })}`);
}

/** The server's `{error}` in words, or the status code when there is none. */
async function errorOf(res: Response): Promise<string> {
    const body = await res.text().catch(() => "");
    try { const e = JSON.parse(body)?.error; if (e) return String(e); } catch { /* not JSON */ }
    return `the server answered ${res.status}`;
}

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
    /** How long ordinary files in the workspace live, in hours. 0 keeps
     *  everything for ever. Installed packages and anything in `keep/` are
     *  never swept, whatever this says. */
    workspace_keep_hours?: number;
    /** From the Playwright Extension's status page, pasted into the app once:
     *  lets the agent reach the person's Chrome without an approval prompt. */
    chrome_token?: string;
    /** The Chrome profile directory to use, when there are several. */
    chrome_profile?: string;
    /** "gepetel": our own extension, whose key the app made and the person
     *  allowed in Chrome. Absent: Microsoft's Playwright Extension with a
     *  pasted token (0.7–0.10), which keeps working. */
    chrome_extension?: "gepetel";
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

function makeSandbox(cfg: Config | null): Sandbox {
    return new Sandbox({
        network: cfg?.shell_network !== false,
        keepHours: cfg?.workspace_keep_hours,
    });
}

/**
 * Secrets the app handed us, when the app runs us (GEPETEL_SECRETS=stdin).
 *
 * The device token and the Chrome token live in the macOS Keychain, in an item
 * the signed Gepetel app owns — so macOS gives them only to that app, and any
 * other process asking (a command in the sandbox included) gets a prompt, not
 * the token. The app reads them and writes one JSON line on our stdin before
 * anything else. Never argv (visible to `ps`), never the environment.
 *
 * Without the app — the command line, a developer — there is no such line and
 * the tokens stay in agent.json (0600), as before.
 */
const SECRET_KEYS = ["device_token", "chrome_token"] as const;
let appSecrets: Partial<Record<(typeof SECRET_KEYS)[number], string>> = {};
const secretsFromApp = process.env.GEPETEL_SECRETS === "stdin";

async function readAppSecrets(): Promise<void> {
    if (!secretsFromApp) return;
    const line = await new Promise<string>(resolve => {
        let buf = "";
        const done = (v: string) => { clearTimeout(t); process.stdin.off("data", onData); process.stdin.pause(); resolve(v); };
        const onData = (d: Buffer) => { buf += String(d); const nl = buf.indexOf("\n"); if (nl >= 0) done(buf.slice(0, nl)); };
        const t = setTimeout(() => done(""), 5000);
        process.stdin.on("data", onData);
        process.stdin.resume();
    });
    try {
        const j = JSON.parse(line);
        for (const k of SECRET_KEYS) if (typeof j?.[k] === "string" && j[k]) appSecrets[k] = j[k];
    } catch { /* no secrets: as if unpaired */ }
}

function readConfig(): Config | null {
    let c: any = {};
    try { c = JSON.parse(fs.readFileSync(CONFIG_FILE(), "utf8")); } catch { /* none yet */ }
    // What the app passed wins over anything still in the file.
    c = { ...c, ...appSecrets };
    return c?.device_token ? c : null;
}

function writeConfig(c: Config): void {
    // Under the app, secrets never go to disk: the app keeps them.
    if (secretsFromApp) {
        c = { ...c };
        for (const k of SECRET_KEYS) delete (c as any)[k];
    }
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
        // One line, in words: the app shows exactly this line to the person.
        console.error(`Pairing failed: ${await errorOf(res)}.`);
        process.exit(1);
    }
    const out: any = await res.json();
    writeConfig({
        server,
        device_id: out.device_id,
        device_token: out.device_token,
        ws_url: out.ws_url || `${server.replace(/^http/, "ws")}/device/ws`,
    });
    // Under the app, the token goes up to it — for the Keychain — and nowhere
    // else. The app takes this line out of the output before showing any.
    if (secretsFromApp) console.log(`@secret ${JSON.stringify({ device_token: out.device_token })}`);
    console.log(`Paired. Device ${out.device_id}. Now run: gepetel-agent run`);
}

/** Everything this agent can currently be asked to do.
 *
 *  `meta` is for the relay's log and nothing else — it never reaches the model.
 *  The spec wants the saving measured against `read_url` for the first fifty
 *  calls, and the only side that can report the page's own size is this one. */
/** What a running tool can do besides return: notice it was cancelled, and
 *  ask the person something and wait for the answer. */
type ToolCtx = { signal: AbortSignal; ask: (question: string, image?: { mime: string; b64: string }, opts?: { takeover?: boolean }) => Promise<string>; progress: (line: string) => void;
                jobId?: string; chatLang?: string;
                /** Live takeover (Phase 6): the job's controller, and where its frames go. */
                setTakeover: (t: Takeover | null) => void; frame: (f: { b64: string; w: number; h: number }) => void };

async function runTool(tool: string, args: Record<string, unknown>, ctx: ToolCtx):
        Promise<{ ok: boolean; content: string; meta?: Record<string, unknown>; image?: Image }> {
    if (tool === "fetch_url") {
        const r = await fetchUrl(args as any);
        return { ok: r.ok, content: r.content, meta: r.rawChars ? { raw_chars: r.rawChars } : undefined };
    }
    if (tool === "shell") {
        if (!sandbox) return { ok: false, content: "The sandbox isn't set up on this computer." };
        const r = await sandbox.run(
            String((args as any).command ?? ""),
            Number((args as any).timeout_s) || DEFAULT_TIMEOUT_S,
            ctx.signal,
            ctx.progress,
        );
        return { ok: r.ok, content: r.content };
    }
    if (tool === "ask_demo" && TEST_TOOLS) {
        // picture: true sends a 1×1 PNG with the question — the path a
        // numbered screenshot takes, without needing a browser.
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        const name = await ctx.ask(String((args as any).question || "What should I call you?"),
            (args as any).picture ? { mime: "image/png", b64: png } : undefined);
        return { ok: true, content: `Hello, ${name}!` };
    }
    if (tool === "browse") {
        const how = browserCommand();
        if (!how || !config) return { ok: false, content: "Chrome isn't connected on this computer yet. In the Gepetel menu: Connect Chrome…" };
        const cfg = config;
        const dir = path.join(sandbox?.toolbox || os.tmpdir(), "browser", ctx.jobId || String(Date.now()));
        const mcp = new McpClient(process.execPath, how.args, { cwd: dir, env: how.env });
        const tk = new Takeover((t, a) => mcp.call(t, a), ctx.frame);
        try {
            await mcp.start();
            ctx.setTakeover(tk);
            const r = await browse({ ...(args as any), chat_lang: ctx.chatLang }, {
                call: (t, a) => mcp.call(t, a),
                llm: async req => {
                    const res = await fetch(`${cfg.server}/device/llm`, {
                        method: "POST",
                        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.device_token}` },
                        body: JSON.stringify(req),
                        signal: AbortSignal.timeout(120_000),
                    });
                    const body: any = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(body?.error || `the model call failed (${res.status})`);
                    return body;
                },
                signal: ctx.signal,
                progress: ctx.progress,
                ask: ctx.ask,
                jobId: ctx.jobId,
                // Outside the workspace on purpose: the sandboxed shell can
                // write the workspace, and must not be able to edit a recipe.
                recipes: new RecipeStore(path.join(configDir(), "recipes")),
                allowLoopback: !!process.env.GEPETEL_BROWSE_MCP_ARGS,
            });
            console.log(`browse: ${r.ok ? "answered" : "stopped"} after ${r.steps} steps, ${r.calls} model calls, ${r.inputTokens} input tokens${r.recipe ? `, recipe ${r.recipe}` : ""}`);
            return { ok: r.ok, content: r.content, meta: { steps: r.steps, llm_calls: r.calls, input_tokens: r.inputTokens, ...(r.recipe ? { recipe: r.recipe } : {}) } };
        } catch (e: any) {
            const why = String(e?.message || e);
            return { ok: false, content: /token|extension|connect/i.test(why)
                ? `Couldn't reach Chrome: ${why}. Is Chrome open, with the Playwright Extension on?`
                : `The browser job failed: ${why}` };
        } finally {
            tk.stop();
            ctx.setTakeover(null);
            if (tk.sentFrames) console.log(`takeover: ${tk.sentFrames} frames, ${Math.round(tk.sentBytes / 1024)} KB`);
            mcp.close();
            setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 5000).unref?.();
        }
    }
    if (tool === "send_file") {
        // The app sets GEPETEL_RENDERER to its own executable, which renders
        // SVG; run on its own, the agent sends PNG/JPEG/GIF/WebP only.
        const r = await sendFile(args as any, { workspace: workspaceDir(), sandbox, renderer: process.env.GEPETEL_RENDERER });
        if (r.image) console.log(`send_file: ${r.image.name}, ${r.image.mime}, ${Math.round(r.image.b64.length * 0.75 / 1024)} KB`);
        else console.log(`send_file refused: ${r.content}`);
        return r;
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
        if (sandbox) {
            const av = await sandbox.available();
            // What it HAS, not what it theoretically could: a stock macOS has
            // no python3 until the developer tools are installed, and a model
            // told otherwise writes a command that cannot run.
            lines.push(av.ok ? `sandbox: ${await sandbox.tools() || "no usual tools found"}` : av.why);
        }
        return { ok: true, content: lines.join("\n") };
    }
    return { ok: false, content: `This agent does not know "${tool}" yet.` };
}

function run(): void {
    const cfg = readConfig();
    if (!cfg) {
        status("unpaired", "not paired");
        console.error("Not paired. Ask Gepetel to connect your computer, then run: gepetel-agent pair <code>");
        process.exit(2);
    }

    sandbox = makeSandbox(cfg);
    config = cfg;

    let backoff = 1000;
    const MAX_BACKOFF = 60_000;
    let stopping = false;

    let inFlight = 0;
    // The socket in use now. Events go out on it whichever socket their call
    // came in on: a job that outlives a reconnect reports on the new one.
    let sock: WebSocket | null = null;
    const outbox = new Outbox(path.join(configDir(), "outbox.json"));
    const send = (m: unknown) => { if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify(m)); };
    /** Kept on disk first, then sent; resent on every connect until acked. */
    const emit = (e: Parameters<Outbox["add"]>[0]) => send(outbox.add(e));
    /** Jobs in progress: how to cancel each, and where its answer goes. */
    const running = new Map<string, { abort: AbortController; asked: boolean; promoted?: boolean; reply?: (text: string) => void; giveUp?: () => void; takeover?: Takeover | null; lang?: string }>();

    const connect = () => {
        status("connecting");
        const ws = new WebSocket(cfg.ws_url, { headers: { Authorization: `Bearer ${cfg.device_token}` } });
        let alive = true;

        ws.on("open", async () => {
            backoff = 1000;   // a connection that opened resets the ladder
            // Probed per connection, not at startup: somebody installs the
            // runtime, restarts nothing, and the next reconnect picks it up.
            const can = await capabilities();
            console.log(`connected to ${cfg.ws_url} — can: ${can.join(", ")}`);
            status(inFlight ? "busy" : "online", can.join(", "));
            if (ws.readyState === WebSocket.OPEN) {
                sock = ws;
                ws.send(JSON.stringify({ t: "hello", agent_version: VERSION, capabilities: can }));
                // Whatever the last connection did not get acknowledged.
                const owed = outbox.pending();
                if (owed.length) console.log(`resending ${owed.length} event(s) from the outbox`);
                for (const ev of owed) send(ev);
            }
        });

        ws.on("message", async raw => {
            let msg: any;
            try { msg = JSON.parse(String(raw)); } catch { return; }
            if (msg?.t === "ack") { outbox.ack(String(msg.id || "")); return; }
            if (msg?.t === "cancel") {
                const job = running.get(String(msg.job || ""));
                if (job) { console.log(`job ${msg.job} cancelled`); job.abort.abort(); job.giveUp?.(); }
                return;
            }
            if (msg?.t === "takeover") {
                const job = running.get(String(msg.job || ""));
                const tk = job?.takeover;
                if (!job || !tk) return;
                const action = String(msg.action || "");
                if (action === "start") { console.log(`takeover ${msg.job}: viewer connected`); void tk.start(); }
                else if (action === "pause") tk.stop();
                else if (action === "done") {
                    tk.stop();
                    // Done on the phone answers the handoff, as "done" in the chat would.
                    const answer = job.reply;
                    if (answer) { job.reply = undefined; job.giveUp = undefined; answer("done (they took over from their phone)"); }
                } else if (action === "expired") {
                    tk.stop();
                    // Closed without Done: ask in the chat rather than wait in silence.
                    if (job.reply) emit({ job: String(msg.job), kind: "question",
                        text: /roman/i.test(String(job.lang || "")) ? "Linkul a expirat. Spune „gata” când ai terminat pe Mac, sau „stop”."
                                                               : "The link expired. Reply \"done\" when you've finished on your Mac, or \"stop\"." });
                }
                return;
            }
            if (msg?.t === "input") {
                const tk = running.get(String(msg.job || ""))?.takeover;
                if (tk?.running) void tk.input(msg).catch(e => console.error(`takeover input failed: ${e?.message || e}`));
                return;
            }
            if (msg?.t === "promoted") {
                const job = running.get(String(msg.job || ""));
                if (job) job.promoted = true;
                return;
            }
            if (msg?.t === "reply") {
                const job = running.get(String(msg.job || ""));
                const answer = job?.reply;
                if (answer) { job!.reply = undefined; job!.giveUp = undefined; answer(String(msg.text ?? "")); }
                return;
            }
            if (msg?.t !== "call" || !msg.id) return;

            const jobId = String(msg.job || "");
            const entry = { abort: new AbortController(), asked: false, lang: String(msg.chat_lang || "") } as {
                abort: AbortController; asked: boolean; promoted?: boolean; reply?: (t: string) => void; giveUp?: () => void;
                takeover?: Takeover | null; lang: string };
            if (jobId) running.set(jobId, entry);
            const ctx: ToolCtx = {
                jobId,
                chatLang: String(msg.chat_lang || ""),
                signal: entry.abort.signal,
                setTakeover: t => { entry.takeover = t; },
                frame: f => send({ t: "frame", job: jobId, ...f }),
                ask: (question, image, opts) => new Promise<string>((resolve, reject) => {
                    if (entry.abort.signal.aborted) { reject(new Error("cancelled")); return; }
                    entry.asked = true;
                    entry.reply = resolve;
                    entry.giveUp = () => reject(new Error("cancelled"));
                    // The question IS the message: the agent writes it, the
                    // relay delivers it verbatim, no model is involved.
                    emit({ job: jobId, tool: String(msg.tool || ""), kind: "question", text: question.slice(0, 1000),
                           ...(image ? { image } : {}), ...(opts?.takeover ? { takeover: true } : {}) });
                }),
                // Kept on the job for "how's it going?", never sent to the
                // chat: at most one a minute, and the latest wins — a script
                // printing every row must not become a stream of events.
                progress: (() => {
                    let last = 0, latest = "", timer: NodeJS.Timeout | null = null;
                    const flush = () => { timer = null; last = Date.now(); if (jobId) send({ t: "event", id: `p_${jobId}_${last}`, job: jobId, kind: "progress", text: latest }); };
                    return (line: string) => {
                        latest = line;
                        if (timer) return;
                        const wait = Math.max(0, last + 60_000 - Date.now());
                        timer = setTimeout(flush, wait);
                        timer.unref?.();
                    };
                })(),
            };

            // Run it, then answer. A tool that throws still gets a result:
            // silence would leave the other side waiting out its whole timeout.
            const started = Date.now();
            let out: { ok: boolean; content: string; meta?: Record<string, unknown>; image?: Image };
            if (inFlight++ === 0) status("busy", String(msg.tool || ""));
            try { out = await runTool(String(msg.tool || ""), msg.args || {}, ctx); }
            catch (e: any) {
                out = entry.abort.signal.aborted
                    ? { ok: false, content: "Cancelled." }
                    : { ok: false, content: `Failed: ${e?.message || e}` };
            }
            finally {
                if (jobId) running.delete(jobId);
                if (--inFlight === 0 && sock?.readyState === WebSocket.OPEN) status("online");
            }

            // The direct answer, if the call is still being waited on. Sent on
            // the socket it came in on: a result on a newer socket would be
            // for a call that socket never made.
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ t: "result", id: msg.id, ok: out.ok, content: out.content, meta: out.meta, image: out.image }));
            }
            // And as an event when nobody is waiting any more: it ran past the
            // relay's patience, it asked a question (which ended the wait), or
            // the socket it came in on is gone. Sending both is deliberate —
            // the relay ignores a result for a call it already promoted, and
            // guessing which side of the line we landed on would lose the
            // answer whenever the guess was wrong. A cancelled job says
            // nothing more: the person already knows.
            const unwaited = entry.promoted || Date.now() - started > PROMOTE_AFTER_MS || entry.asked || ws !== sock || ws.readyState !== WebSocket.OPEN;
            if (jobId && unwaited && !entry.abort.signal.aborted) {
                emit({ job: jobId, tool: String(msg.tool || ""), kind: out.ok ? "done" : "failed", text: eventText(msg, out) });
            }
        });

        ws.on("close", code => {
            alive = false;
            if (stopping) return;
            if (code === 1008 || code === 4001) {
                status("unpaired", "the server rejected this device");
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
                status("unpaired", "this device is no longer paired");
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
        status("offline", `reconnecting in ${Math.round(wait / 1000)}s`);
        setTimeout(connect, wait);
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
    };

    for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.on(sig, () => { stopping = true; console.log("stopping"); process.exit(0); });
    }
    // Under the app, stdin is a pipe from it. When the pipe closes the app is
    // gone — quit, or crashed without a chance to stop us — and an agent left
    // behind would keep this Mac online with nobody's menu bar to stop it.
    if (process.env.GEPETEL_APP === "1") {
        process.stdin.on("end", () => { stopping = true; console.log("the app went away; stopping"); process.exit(0); });
        process.stdin.resume();
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
    console.log(`toolbox: ${sandbox.toolbox}`);
    const ws = workspaceDir();
    console.log(`workspace: ${ws}  (files tidied after ${cfg?.workspace_keep_hours ?? 24}h; keep/ and installed packages are not)`);
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

    const home = os.homedir();

    await check("your home directory is unreadable", async () => {
        // The real one, named explicitly: inside the sandbox `~` is the
        // toolbox's own home, so `ls ~` would prove nothing.
        const out = await sh(`ls -a '${home}' 2>&1 | head -20`);
        const leaked = /Desktop|Documents|Library|\.ssh/.test(out);
        return [!leaked, leaked ? out.replace(/\n/g, " | ").slice(0, 160) : "nothing of yours is visible"];
    });

    await check("SSH keys are out of reach", async () => {
        const out = await sh(`cat '${home}'/.ssh/id_* 2>&1 | head -5`);
        return [!/BEGIN [A-Z ]*PRIVATE KEY/.test(out), "no key material came back"];
    });

    await check("the rest of the disk is read-only", async () => {
        const out = await sh(`touch '${home}/gepetel-should-not-exist' /usr/local/gepetel-should-not-exist 2>&1 | head -3; ls '${home}/gepetel-should-not-exist' 2>&1 | head -1`);
        const wrote = !/No such file|not permitted|Read-only|denied/i.test(out);
        return [!wrote, wrote ? out.replace(/\n/g, " | ").slice(0, 160) : "writes outside the workspace are refused"];
    });

    await check("a file written by a command lands in the workspace", async () => {
        // No /workspace mount any more: a command simply starts in the folder.
        await sh(`printf '%s' ${nonce} > gepetel-selftest.txt`);
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

    await check("what gets installed stays installed", async () => {
        // The sandbox has no machine of its own, so "installed" means "in the
        // workspace" — and `~` inside is a folder in there, which is what makes
        // pip, npm and git caches survive to the next command instead of being
        // denied against your real home.
        await sh(`echo ${nonce} > ~/persist-check`);
        const out = await sh("cat ~/persist-check 2>&1");
        return [out.includes(nonce), out.includes(nonce)
            ? "a file written to ~ in one command is there in the next"
            : out.split("\n").slice(0, 2).join(" | ")];
    });

    await check("the usual tools", async () => {
        const have = await sandbox!.tools();
        // Not a failure: a stock Mac has no python3 until the developer tools
        // are installed, and the point is that the model is TOLD rather than
        // left to write a command that cannot run.
        return [true, have || "none of the usual tools are on this Mac"];
    });

    // Per client, not just curl: the network arrives through a proxy, and each
    // client finds the proxy its own way. curl alone passing once hid that
    // Node's fetch had no network at all.
    const clients: [string, string][] = [
        ["curl", "curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com 2>&1"],
        ["python3", `python3 -c "import urllib.request as u;print(u.urlopen('https://example.com',timeout=10).status)" 2>&1`],
        ["node", `node -e "fetch('https://example.com',{signal:AbortSignal.timeout(10000)}).then(r=>console.log(r.status),e=>console.log(e.cause?.code||e.message))" 2>&1`],
    ];
    const present = (await sandbox!.tools()).split(/[ ,]+/);
    for (const [name, cmd] of clients) {
        if (!present.includes(name)) continue;
        await check(`the network is as configured (${name})`, async () => {
            const out = await sh(cmd, 20);
            const reachable = /\b200\b/.test(out);
            const wanted = cfg?.shell_network !== false;
            return [reachable === wanted, reachable ? "reaches the internet" : `no network — ${out.trim().split("\n").pop()?.slice(0, 80)}`];
        });
    }

    console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
    process.exit(failed ? 1 : 0);
}

/**
 * `gepetel-agent checkchrome` — does Chrome answer, through the extension,
 * with the token we have? The app runs this right after the token is pasted.
 *
 * Proof by doing, because the alternative failed: the app used to look for
 * the extension in Chrome's profile folder, and macOS protects that folder from
 * other apps — so it never found an extension that was there.
 */
async function checkChrome(): Promise<void> {
    config = readConfig();
    const how = browserCommand();
    if (!how) { console.log("Chrome isn't set up: no token saved yet."); process.exit(1); }
    const dir = path.join(os.tmpdir(), `gepetel-checkchrome-${process.pid}`);
    const mcp = new McpClient(process.execPath, how.args, { cwd: dir, env: how.env });
    let ok = false, why = "";
    try {
        await mcp.start();
        // Long enough for the person to click Allow in Chrome the first time.
        const r = await mcp.call("browser_tabs", { action: "list" }, 120_000);
        if (r.isError) throw new Error(r.content.map(c => c.text).join(" ").slice(0, 200));
        ok = true;
    } catch (e: any) {
        why = String(e?.message || e).slice(0, 200);
    }
    mcp.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(ok ? "Chrome answered through the extension." : `Chrome didn't answer: ${why}`);
    process.exit(ok ? 0 : 1);
}

/** Revoke the token on the server, then forget it here.
 *
 *  Forgetting alone used to be all this did, which left a token that still
 *  opened a socket on a Mac that believed it was unpaired. The server is asked
 *  first; if it cannot be reached, the local copy goes anyway (the person asked
 *  for this Mac to stop) and they are told the one thing still to do. */
async function unpair(): Promise<void> {
    const cfg = readConfig();
    if (!cfg) { console.log("Nothing to unpair."); return; }
    let revoked = false;
    try {
        const res = await fetch(`${cfg.server}/device/unpair`, {
            method: "POST",
            headers: { authorization: `Bearer ${cfg.device_token}` },
            signal: AbortSignal.timeout(15_000),
        });
        // 401: the server no longer knows this token — revoked already.
        revoked = res.ok || res.status === 401;
        if (!revoked) console.error(`Gepetel could not revoke it: ${await errorOf(res)}.`);
    } catch (e: any) {
        console.error(`Gepetel could not be reached: ${e?.message || e}.`);
    }
    fs.rmSync(CONFIG_FILE(), { force: true });
    console.log(revoked
        ? "Disconnected. This Mac's token no longer works."
        : "Removed from this Mac. To revoke it on Gepetel's side too, tell Gepetel in the chat to disconnect your computer.");
}

await readAppSecrets();
const [, , cmd, arg] = process.argv;
switch (cmd) {
    case "pair": await pair(arg || ""); break;
    case "run": run(); break;
    case "selftest": await selftest(); break;
    case "unpair": await unpair(); break;
    case "checkchrome": await checkChrome(); break;
    default:
        console.log("gepetel-agent <pair CODE | run | selftest | unpair>");
        process.exit(cmd ? 2 : 0);
}
