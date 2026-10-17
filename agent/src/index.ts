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
import { HomeHosts } from "./homeHosts.js";
import { SiteNotes } from "./siteNotes.js";
import { gated } from "./pwGate.js";
import { Takeover } from "./takeover.js";
import { enableOsInput, osInputAnswer, osInput, osInputAvailable } from "./osInput.js";
import { enablePeople, peopleAnswer, peopleAvailable, askPeople } from "./people.js";
import { enablePasswords, passwordsAnswer, passwordsAvailable, savedLogin, saveLogin, forgetLogin, savedSitesNear, fillApiKeys, saveApiKey } from "./passwords.js";
import { JobLog } from "./jobLog.js";
import { logUrl } from "./mcpClient.js";
import { Bridge } from "./bridge.js";
import { RecipeStore } from "./recipes.js";
import { SiteMemory } from "./sites.js";
import { EXTENSION_ID } from "./extension.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const VERSION = "0.13.52";
/** What this agent can do, as the relay filters its published tool list.
 *
 *  `shell` is **conditional, and re-checked on every connect**: it needs the
 *  sandbox to start on this machine. Advertising it regardless would offer the
 *  model a tool that fails on a computer which is otherwise perfectly fine —
 *  the Phase 1 lesson. A Mac without it reports *why* instead, through
 *  computer_status. */
const BASE_CAPABILITIES = ["status", "fetch", "send", "memory"];

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
    if (test) return { args: [cli, ...test.split(" ").filter(Boolean), "--caps=vision,network,storage"], env: process.env };
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
        args: [cli, "--extension", "--caps=vision,network,storage", ...(config?.chrome_profile ? ["--profile-dir-name", config.chrome_profile] : [])],
        env: {
            ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token,
            // Given Chrome's program, Playwright opens its connect page in the
            // running Chrome and never reads Chrome's profile folder. Without
            // it, it reads that folder to check the extension is installed —
            // and macOS denies other apps that folder, so it refused with
            // "Playwright Extension not found" on a Mac where it was.
            ...(ours
                ? { PLAYWRIGHT_MCP_EXECUTABLE_PATH: opener, GEPETEL_REAL_CHROME: chrome, GEPETEL_EXTENSION_ID: EXTENSION_ID,
                    ...(config?.chrome_profile_email ? { GEPETEL_PROFILE_EMAIL: config.chrome_profile_email } : {}) }
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
    /** The job clicks and types with the Mac's own pointer and keys (on
     *  unless set to false). */
    real_input?: boolean;
    /** The Chrome profile that has Gepetel for Chrome, by its account's email
     *  — learned from the extension at the connection check. */
    chrome_profile_email?: string;
};

/** Site notes (Phase 9): one store for the agent's life, next to the recipes. */
let siteNotesStore: SiteNotes | null = null;
const siteNotesFor = () => (siteNotesStore ??= new SiteNotes(path.join(configDir(), "site-notes.json")));
/** Home addresses they allowed — read fresh each time: removing one in the
 *  Manage Memories window takes effect at once. */
const homeHostsFor = () => new HomeHosts(path.join(configDir(), "home-hosts.json"));

/** Resolves when the last browse job has let go of Chrome. */
let browseGone: Promise<void> = Promise.resolve();

/** Keep in step with CALL_TIMEOUT_MS in src/device/hub.ts. Past this, the relay
 *  has already answered with a job id and is no longer listening for a result. */
const PROMOTE_AFTER_MS = 20_000;

/** What the person reads in WhatsApp when a long job finishes.
 *
 *  The agent writes it, not the model: delivery costs no tokens and nothing is
 *  re-worded on the way. One line saying which command it was — a result that
 *  arrives minutes later with no idea what it answers is a puzzle, not news. */
function eventText(call: any, out: { ok: boolean; content: string }): string {
    // A browse job has no url but a start_url: its site, then. Nothing at
    // all: no empty quotes ("Done: ``" on the owner's phone).
    const site = (u: unknown) => { try { return new URL(String(u)).host.replace(/^www\./, ""); } catch { return ""; } };
    const what = String(call?.tool === "shell" ? (call?.args?.command ?? "") : (call?.args?.url ?? site(call?.args?.start_url))).slice(0, 120);
    const ro = String(call?.chat_lang || "") === "Romanian";
    const q = what ? ` \`${what}\`` : "";
    const head = ro
        ? (out.ok ? `Gata:${q}` : `N-a mers:${q}`)
        : (out.ok ? `Done:${q}` : `Failed:${q}`);
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

/** What came on stdin after the secrets line, before the line reader started. */
let stdinLeftover = "";

async function readAppSecrets(): Promise<void> {
    if (!secretsFromApp) return;
    process.stdin.setEncoding("utf8");
    const line = await new Promise<string>(resolve => {
        let buf = "";
        const done = (v: string) => { clearTimeout(t); process.stdin.off("data", onData); process.stdin.pause(); resolve(v); };
        // The rest of the chunk (a line the app sent right after) is kept for
        // the reader below, not dropped.
        const onData = (d: Buffer | string) => { buf += String(d); const nl = buf.indexOf("\n"); if (nl >= 0) { stdinLeftover = buf.slice(nl + 1); done(buf.slice(0, nl)); } };
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
/** A job the relay asked for, while it runs. */
type JobEntry = {
    abort: AbortController;
    /** It asked the person something: its answer goes out as an event. */
    asked: boolean;
    promoted?: boolean;
    /** A question waiting for its answer: one of these is called once, then
     *  all are cleared together (settle). */
    reply?: (text: string) => void;
    secret?: (s: { username: string; password: string; remember: boolean }) => void;
    giveUp?: () => void;
    waiting?: boolean;
    takeover?: Takeover | null;
    lang: string;
    stopProgress?: () => void;
    stoppedHere?: boolean;
    tool?: string;
    replaced?: boolean;
    /** What the person added while it ran, read before each step. */
    added?: string[];
    /** They asked, while it ran, for it to be done. */
    maySubmit?: boolean;
};

/** The question is answered (or the job's over): nothing waits any more. */
function settle(job: JobEntry): void {
    job.reply = job.secret = job.giveUp = undefined;
    job.waiting = false;
}

type SignInAnswer = { username: string; password: string; remember: boolean } | { reply: string };
type ToolCtx = { signal: AbortSignal; ask: (question: string, image?: { mime: string; b64: string }, opts?: { takeover?: boolean }) => Promise<string>;
    /** A sign-in form on the phone (the relay's signin.ts): what was typed
     *  there, straight from the relay, or their chat reply instead. */
    askSignIn?: (question: string, signin: { site: string; username: string; need_user: boolean }) => Promise<SignInAnswer>;
    maySubmitNow?: () => boolean; progress: (line: string) => void;
                jobId?: string; chatLang?: string;
                /** A short line to the chat: where the work is, what's next. */
                update?: (text: string) => void;
                /** What the person added to this work since last asked (and clears it). */
                added?: () => string[];
                /** Live takeover (Phase 6): the job's controller, and where its frames go. */
                setTakeover: (t: Takeover | null) => void; frame: (f: { b64: string; w: number; h: number; fields?: number[][] }) => void };

async function runTool(tool: string, args: Record<string, unknown>, ctx: ToolCtx):
        Promise<{ ok: boolean; content: string; meta?: Record<string, unknown>; image?: Image }> {
    if (tool === "fetch_url") {
        const home = homeHostsFor();
        const r = await fetchUrl({ ...(args as any), homeOk: (h: string) => home.has(h) });
        return { ok: r.ok, content: r.content, meta: r.rawChars ? { raw_chars: r.rawChars } : undefined };
    }
    if (tool === "shell") {
        if (!sandbox) return { ok: false, content: "The sandbox isn't set up on this computer." };
        // API keys kept on the Mac, named as ‹api key: site›: filled in here,
        // and taken back out of what the command printed.
        const filled = await fillApiKeys(String((args as any).command ?? ""));
        if ("missing" in filled) return { ok: false, content: `No API key is kept for ${filled.missing}. Get one first with browse (from their account on ${filled.missing}, keeping it with keep_api_key), or use a service that needs none.` };
        const unkey = (t: string) => { for (const [ph, key] of filled.keys) t = t.split(key).join(ph); return t; };
        const r = await sandbox.run(filled.command, Number((args as any).timeout_s) || DEFAULT_TIMEOUT_S, ctx.signal, line => ctx.progress(unkey(line)));
        const content = unkey(r.content);
        return { ok: r.ok, content };
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
        // The direct line to the extension (bridge.ts): its port goes to the
        // connect page through bin/open-chrome; the key is the one the person
        // approved in Chrome.
        const key = String(how.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN || "");
        // Everything this job logs also goes to its own file (jobLog.ts).
        const jl = new JobLog(ctx.jobId || "");
        const out = (line: string) => { console.log(line); jl.line(line); };
        const bridge = key && cfg.chrome_extension === "gepetel" ? new Bridge(key, line => out(`[${ctx.jobId}] ${line}`)) : null;
        const bridgePort = bridge ? await bridge.start().catch(e => { console.log(`[${ctx.jobId}] bridge: couldn't start (${e?.message || e})`); return 0; }) : 0;
        const mcp = new McpClient(process.execPath, how.args, { cwd: dir, env: { ...how.env, ...(bridgePort ? { GEPETEL_BRIDGE_PORT: String(bridgePort) } : {}) }, log: line => out(`[${ctx.jobId}] ${line}`) });
        out(`[${ctx.jobId}] browse: goal ${JSON.stringify(String((args as any).goal ?? "")).slice(0, 200)}, start ${String((args as any).start_url ?? "-")}, their words ${String((args as any).asked ?? "").length} chars, profile ${config?.chrome_profile_email || "(last used)"}`);
        // Never to Playwright while each of Gepetel's tabs is taken (pwGate.ts).
        const pw = gated((t, a, ms) => mcp.call(t, a, ms), () => bridge, line => out(`[${ctx.jobId}] ${line}`));
        const tk = new Takeover((t, a) => pw(t, a), ctx.frame);
        tk.bridge = bridge;
        tk.osInput = osInput;
        // After the job this one replaced has let go of Chrome: two at once,
        // the extension gave the second its own tab group, which closes with
        // its job — the person's tab went with it (2026-10-14).
        const before = browseGone;
        let let_go: () => void = () => {};
        browseGone = new Promise(r => { let_go = r; });
        await Promise.race([before, new Promise(r => setTimeout(r, 20_000))]);
        try {
            await mcp.start();
            ctx.setTakeover(tk);
            /** Input the provider served from its cache (billed at a fraction). */
            let cachedTokens = 0;
            const r = await browse({ ...(args as any), chat_lang: ctx.chatLang }, {
                call: pw,
                journal: line => jl.line(line),
                notes: siteNotesFor(),
                homeHosts: homeHostsFor(),
                handoffHosts: () => tk.hosts(),
                ...(peopleAvailable() ? { people: {
                    // Short: an app from before 0.13.16 doesn't answer, and the job waits.
                    list: async () => (await askPeople({ op: "list" }, 2500)).people ?? [],
                    value: async (person: string, label: string) => { const r = await askPeople({ op: "value", person, label }); return r.ok && typeof r.value === "string" ? r.value : null; },
                } } : {}),
                ...(config?.chrome_profile_email ? { myEmail: config.chrome_profile_email } : {}),
                ...(passwordsAvailable() ? { passwords: { get: savedLogin, save: saveLogin, forget: forgetLogin, sites: savedSitesNear }, saveApiKey } : {}),
                ...(ctx.askSignIn ? { askSignIn: ctx.askSignIn } : {}),
                ...(cfg.real_input !== false && osInputAvailable() ? { osInput } : {}),
                llm: async req => {
                    // A server's passing failure (502 at the very end of the
                    // payment that went through, 2026-10-17) is tried again
                    // twice, a few seconds apart, before the job gives up.
                    let res: Response | null = null;
                    let body: any = {};
                    for (let attempt = 0; attempt < 3; attempt++) {
                        if (attempt) await new Promise(r => setTimeout(r, 3000 * attempt));
                        res = await fetch(`${cfg.server}/device/llm`, {
                            method: "POST",
                            headers: { "content-type": "application/json", authorization: `Bearer ${cfg.device_token}` },
                            body: JSON.stringify(req),
                            signal: AbortSignal.timeout(120_000),
                        }).catch(() => null);
                        body = res ? await res.json().catch(() => ({})) : {};
                        if (res && (res.ok || res.status < 500)) break;
                        out(`[${ctx.jobId}] the model call failed (${res?.status ?? "no answer"})${attempt < 2 ? "; once more" : ""}`);
                    }
                    if (!res?.ok) throw new Error(body?.error || `the model call failed (${res?.status ?? "no answer"})`);
                    cachedTokens += Number(body?.usage?.cached_tokens) || 0;
                    return body;
                },
                signal: ctx.signal,
                progress: ctx.progress,
                update: ctx.update,
                ...(Number(process.env.GEPETEL_UPDATE_MS) > 0 ? { updateEveryMs: Number(process.env.GEPETEL_UPDATE_MS) } : {}),
                ask: ctx.ask,
                added: ctx.added,
                ...(ctx.maySubmitNow ? { maySubmitNow: ctx.maySubmitNow } : {}),
                log: line => out(line),
                jobId: ctx.jobId,
                // Outside the workspace on purpose: the sandboxed shell can
                // write the workspace, and must not be able to edit a recipe.
                recipes: new RecipeStore(path.join(configDir(), "recipes")),
                // Phone view needs our extension: it makes a phone-sized page a phone.
                phoneView: readConfig()?.chrome_extension === "gepetel",
                sites: new SiteMemory(path.join(configDir(), "sites.json")),
                ...(bridge ? { bridge, lostTab: (id: number | null) => tk.useTab(id) } : {}),
                viewChanged: (w: number, h: number) => { tk.viewSize = { width: w, height: h }; },
                allowLoopback: !!process.env.GEPETEL_BROWSE_MCP_ARGS,
            });
            out(`browse: ${r.ok ? "answered" : "stopped"} after ${r.steps} steps, ${r.calls} model calls, ${r.inputTokens} input tokens${r.recipe ? `, recipe ${r.recipe}` : ""}`);
            jl.summary({ goal: String((args as any).goal ?? ""), startUrl: String((args as any).start_url ?? ""), ok: r.ok, answer: r.content, steps: r.steps, calls: r.calls, tokens: r.inputTokens, cached: cachedTokens, recipe: r.recipe });
            // How it ended, whichever way (an answer, a stop, a loop, the person's no).
            jl.line(`journal ended: ${r.ok ? "ok" : "not ok"}, ${r.steps} steps, ${r.calls} model calls, ${r.inputTokens} input tokens${r.recipe ? `, recipe ${r.recipe}` : ""} — ${r.content.replace(/\s*\n\s*/g, " ⏎ ").slice(0, 3000)}`);
            return { ok: r.ok, content: r.content, meta: { steps: r.steps, llm_calls: r.calls, input_tokens: r.inputTokens, ...(r.recipe ? { recipe: r.recipe } : {}) } };
        } catch (e: any) {
            const why = String(e?.message || e);
            jl.summary({ goal: String((args as any).goal ?? ""), startUrl: String((args as any).start_url ?? ""), ok: false, answer: `failed: ${why}` });
            return { ok: false, content: /token|extension|connect/i.test(why)
                ? `Couldn't reach Chrome: ${why}. Is Chrome open, with the Playwright Extension on?`
                : `The browser job failed: ${why}` };
        } finally {
            tk.stop();
            ctx.setTakeover(null);
            // The job's tabs close when its connection does — the extension
            // (Gepetel for Chrome) closes Gepetel's group. Closing them one by
            // one from here made Chrome open and close tabs in front of the
            // person (0.11.1: "closed 20 tab(s)").
            if (tk.sentFrames) out(`takeover: ${tk.sentFrames} frames, ${Math.round(tk.sentBytes / 1024)} KB`);
            // Windows the job's tabs opened (a sign-in popup) go with it:
            // otherwise they pile up, one a job (the owner, 2026-10-14).
            if (bridge?.connected) {
                for (const t of await bridge.tabs().catch(() => [])) {
                    if (t.popup) await bridge.closeTab(t.tabId).then(() => out(`[${ctx.jobId}] closed a window the job opened (${logUrl(t.url)})`)).catch(() => {});
                }
            }
            mcp.close();
            bridge?.close();
            // The extension takes a moment to see the connection close.
            void Promise.race([mcp.gone(), new Promise(r => setTimeout(r, 5000))]).then(() => setTimeout(let_go, 1000));
            setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 5000).unref?.();
        }
    }
    // What's remembered on this Mac (Phase 9), from the chat: "remember: on
    // OLX I sign in with Google", "what do you remember about OLX?", "forget
    // that". Site notes here; people's details are the app's (encrypted).
    if (tool === "memory") {
        const a = args as any;
        const about = String(a.about || "site"), action = String(a.action || "list");
        if (about === "person") {
            // Kept by the app, encrypted (people.ts). Listed by what's kept,
            // never read back: the values are in the app's Manage Memories.
            if (!peopleAvailable()) return { ok: false, content: "People's details are kept by the Gepetel app on the Mac, and it isn't running this agent." };
            const person = String(a.person || "").trim().slice(0, 60);
            if (action === "add") {
                const label = String(a.label || "").trim().slice(0, 60), value = String(a.text || "").trim().slice(0, 500);
                if (!person || !label || !value) return { ok: false, content: "Whose, which detail, and what is it?" };
                const r = await askPeople({ op: "set", person, relation: String(a.relation || "").slice(0, 40) || undefined, label, value });
                return r.ok ? { ok: true, content: `Kept on the Mac: ${person}'s ${label}.` } : { ok: false, content: `Not kept: ${r.why || "the app couldn't"}` };
            }
            if (action === "forget") {
                if (!person) return { ok: false, content: "Whose?" };
                const r = await askPeople({ op: "forget", person, label: String(a.label || "").trim() || undefined });
                return r.ok ? { ok: true, content: a.label ? `Forgot ${person}'s ${a.label}.` : `Forgot everything about ${person}.` } : { ok: false, content: r.why || "Nothing matched." };
            }
            const r = await askPeople({ op: "list" });
            const all = (r.people ?? []).filter(p => !person || p.name.toLowerCase() === person.toLowerCase());
            if (!all.length) return { ok: true, content: person ? `Nothing kept about ${person}.` : "No one's details are kept yet." };
            return { ok: true, content: all.map(p => `${p.name}${p.relation ? ` (${p.relation})` : ""}: ${p.labels.join(", ") || "nothing yet"}`).join("\n") + "\n(The values stay on the Mac: Gepetel menu → Manage Memories….)" };
        }
        if (about !== "site") return { ok: false, content: "About a site, or a person?" };
        const notes = siteNotesFor();
        const site = String(a.site || "").trim();
        if (action === "add") {
            if (!site) return { ok: false, content: "Which site is it about?" };
            const r = notes.add(site, String(a.text || ""), "person");
            return "why" in r ? { ok: false, content: `Not kept: ${r.why}. A site note says how a site works, never anyone's details.` } : { ok: true, content: `Kept for ${r.site}: "${r.text}"` };
        }
        if (action === "forget") {
            const gone = notes.forget({ site: site || undefined, text: String(a.text || "") || undefined });
            return { ok: true, content: gone ? `Forgot ${gone} note(s)${site ? ` about ${site}` : ""}.` : "Nothing matched." };
        }
        const list = site ? notes.forSite(site, 50) : notes.all().slice(0, 80);
        if (!list.length) return { ok: true, content: site ? `Nothing remembered about ${site}.` : "Nothing remembered about any site yet." };
        return { ok: true, content: list.map(n => `${n.site}: ${n.kind === "address" ? `page that worked: ${n.text}` : n.text} (${n.source === "person" ? "from you" : "learned by a job"})`).join("\n").slice(0, 3000) };
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
    // A token with no server beside it (the settings deleted, the Keychain
    // kept) isn't a pairing: it crashed here every 30 s on "Invalid URL".
    if (!cfg || !cfg.ws_url || !cfg.device_token) {
        status("unpaired", "not paired");
        console.error("Not paired. Ask Gepetel to connect your computer, then run: gepetel-agent pair <code>");
        process.exit(2);
    }

    sandbox = makeSandbox(cfg);
    config = cfg;

    let backoff = 1000;
    const MAX_BACKOFF = 60_000;
    /** The Mac's own heartbeat. The relay pings every 20 s and drops a Mac
     *  that misses two; the Mac never checked the other way. On a phone
     *  hotspot (2026-10-13) the path went dead, the relay dropped it, and the
     *  socket here still looked open: the menu said "working", the chat said
     *  "offline", for as long as nobody restarted the app. Ping, and give up
     *  on a socket that hasn't been heard from — a pong, a ping, a message. */
    const PING_EVERY_MS = Number(process.env.GEPETEL_PING_MS) || 20_000;
    const SILENT_FOR_MS = PING_EVERY_MS * 2.5;
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
    const running = new Map<string, JobEntry>();

    const connect = () => {
        status("connecting");
        const ws = new WebSocket(cfg.ws_url, { headers: { Authorization: `Bearer ${cfg.device_token}` } });
        let alive = true;
        let heard = Date.now();
        const hear = () => { heard = Date.now(); };
        ws.on("pong", hear);
        ws.on("ping", hear);
        ws.on("message", hear);
        const heartbeat = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (Date.now() - heard > SILENT_FOR_MS) {
                console.log(`no word from the server in ${Math.round((Date.now() - heard) / 1000)}s; the connection is dead, reconnecting`);
                clearInterval(heartbeat);
                ws.terminate();   // emits close → schedule()
                return;
            }
            try { ws.ping(); } catch { /* close follows */ }
        }, PING_EVERY_MS);
        heartbeat.unref?.();
        ws.on("close", () => clearInterval(heartbeat));

        ws.on("open", async () => {
            hear();
            backoff = 1000;   // a connection that opened resets the ladder
            // Probed per connection, not at startup: somebody installs the
            // runtime, restarts nothing, and the next reconnect picks it up.
            const can = await capabilities();
            console.log(`connected to ${cfg.ws_url} — can: ${can.join(", ")}`);
            status(inFlight ? "busy" : "online", can.join(", "));
            if (ws.readyState === WebSocket.OPEN) {
                sock = ws;
                // Which jobs are running here: the relay answers with a cancel
                // for any the person cancelled while this Mac was offline.
                ws.send(JSON.stringify({ t: "hello", agent_version: VERSION, capabilities: can, running: [...running.keys()] }));
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
                else if (action === "pause") { console.log(`takeover ${msg.job}: viewer gone (paused)`); tk.stop(); }
                else if (action === "done") {
                    console.log(`takeover ${msg.job}: Done on the phone; the job carries on`);
                    tk.stop();
                    // Done on the phone answers the handoff, as "done" in the chat would.
                    const answer = job.reply;
                    if (answer) { settle(job); answer("done (they took over from their phone)"); }
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
            // A sign-in typed on the phone (Phase 10). Never logged: who, what.
            if (msg?.t === "secret") {
                const job = running.get(String(msg.job || ""));
                const take = job?.secret;
                if (take && typeof msg.password === "string") {
                    settle(job!);
                    console.log(`job ${msg.job}: a sign-in came from the phone`);
                    take({ username: String(msg.username ?? "").slice(0, 300), password: msg.password.slice(0, 500), remember: msg.remember === true });
                }
                return;
            }
            if (msg?.t === "reply") {
                const job = running.get(String(msg.job || ""));
                const answer = job?.reply;
                if (answer) { settle(job!); answer(String(msg.text ?? "")); }
                // Not waiting on a question: the person adds to work in
                // progress ("for 4 guests", "two rooms"); the job reads it
                // before its next step.
                else if (job) { (job.added ??= []).push(String(msg.text ?? "").slice(0, 2000)); console.log(`job ${msg.job}: the person added to it (${String(msg.text ?? "").length} chars)`); }
                if (job && msg.may_submit === true) job.maySubmit = true;
                return;
            }
            if (msg?.t !== "call" || !msg.id) return;

            const jobId = String(msg.job || "");
            const entry: JobEntry = { abort: new AbortController(), asked: false, lang: String(msg.chat_lang || "") };
            entry.tool = String(msg.tool || "");
            // One browsing job at a time. A new one means the person moved on
            // (on OLX, 2026-10-13, a job waited on a question while the chat
            // started a second; both drove the same Chrome, tab against tab).
            if (entry.tool === "browse") {
                for (const [id, job] of running) {
                    if (job.tool !== "browse") continue;
                    console.log(`job ${id}: a newer browse job (${jobId}) replaces it`);
                    job.replaced = true; job.abort.abort(); job.giveUp?.();
                }
            }
            if (jobId) running.set(jobId, entry);
            const ctx: ToolCtx = {
                jobId,
                chatLang: String(msg.chat_lang || ""),
                added: () => { const a = entry.added ?? []; entry.added = []; return a; },
                maySubmitNow: () => !!entry.maySubmit,
                // Not through the outbox: an update is about now, and one
                // that missed its moment isn't worth sending later.
                // Not while a question waits for its answer; again once it came
                // (after the person sent a code, no update came at all —
                // 2026-10-15: "asked" never went back).
                update: text => { if (jobId && !entry.waiting && running.has(jobId) && !entry.abort.signal.aborted) send({ t: "event", id: `u_${jobId}_${Date.now()}`, job: jobId, tool: String(msg.tool || ""), kind: "update", text: text.slice(0, 300) }); },
                signal: entry.abort.signal,
                setTakeover: t => { entry.takeover = t; },
                frame: f => send({ t: "frame", job: jobId, ...f }),
                ask: (question, image, opts) => new Promise<string>((resolve, reject) => {
                    if (entry.abort.signal.aborted) { reject(new Error("cancelled")); return; }
                    entry.asked = true; entry.waiting = true;
                    entry.reply = resolve;
                    entry.giveUp = () => reject(new Error("cancelled"));
                    // The question IS the message: the agent writes it, the
                    // relay delivers it verbatim, no model is involved.
                    emit({ job: jobId, tool: String(msg.tool || ""), kind: "question", text: question.slice(0, 1000), lang: entry.lang,
                           ...(image ? { image } : {}), ...(opts?.takeover ? { takeover: true } : {}) });
                }),
                askSignIn: (question, signin) => new Promise<SignInAnswer>((resolve, reject) => {
                    if (entry.abort.signal.aborted) { reject(new Error("cancelled")); return; }
                    entry.asked = true; entry.waiting = true;
                    entry.reply = text => resolve({ reply: text });
                    entry.secret = resolve;
                    entry.giveUp = () => reject(new Error("cancelled"));
                    emit({ job: jobId, tool: String(msg.tool || ""), kind: "question", text: question.slice(0, 1000), lang: entry.lang, signin });
                }),
                // Kept on the job for "how's it going?", never sent to the
                // chat: at most one a minute, and the latest wins — a script
                // printing every row must not become a stream of events.
                progress: (() => {
                    let last = 0, latest = "", timer: NodeJS.Timeout | null = null;
                    // Cancelled when the job ends: a pending one used to fire
                    // after "done" and report progress on a finished job.
                    entry.stopProgress = () => { if (timer) clearTimeout(timer); timer = null; };
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
                entry.stopProgress?.();
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
            } else if (jobId && unwaited && entry.replaced) {
                emit({ job: jobId, tool: String(msg.tool || ""), kind: "cancelled",
                    text: entry.lang === "Romanian" ? "Am lăsat asta pentru cererea ta mai nouă." : "Left for your newer request." });
            } else if (jobId && unwaited && entry.stoppedHere) {
                // Stopped from the Mac's own menu: the relay never heard, and
                // its row would say "running" for ever. Tell it — and the chat.
                emit({ job: jobId, tool: String(msg.tool || ""), kind: "cancelled",
                    text: entry.lang === "Romanian" ? "Oprit din meniul Gepetel de pe Mac." : "Stopped from the Gepetel menu on the Mac." });
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
            // Read and drop the answer and close the request: left alone, each
            // retry during a deploy's 502s kept a socket open. (Not ws.terminate:
            // its close event would schedule a second reconnect.)
            res.resume();
            _req.destroy();
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
        // "Stop Everything" in the menu: the app writes {"t":"stop-all"}. And
        // real input (osInput.ts): asked on stdout, answered here.
        enableOsInput();
        // People's details (people.ts): kept by the app, asked for one at a time.
        enablePeople();
        // Sign-ins (passwords.ts): kept by the app, one at the moment of typing.
        enablePasswords();
        process.stdin.setEncoding("utf8");
        let inbuf = "";
        const onLine = (d: string) => {
            inbuf += d;
            let nl: number;
            while ((nl = inbuf.indexOf("\n")) >= 0) {
                const line = inbuf.slice(0, nl); inbuf = inbuf.slice(nl + 1);
                try {
                    const m = JSON.parse(line);
                    if (osInputAnswer(m)) continue;
                    if (peopleAnswer(m)) continue;
                    if (passwordsAnswer(m)) continue;
                    if (m?.t === "stop-all") {
                        console.log(`stop-all from the app: ${running.size} job(s)`);
                        for (const [, job] of running) { job.stoppedHere = true; job.abort.abort(); job.giveUp?.(); }
                    }
                } catch { /* not ours */ }
            }
        };
        process.stdin.on("data", d => onLine(String(d)));
        if (stdinLeftover) onLine(stdinLeftover);
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
    const mcp = new McpClient(process.execPath, how.args, { cwd: dir, env: how.env, log: line => console.log(`[checkchrome] ${line}`) });
    let ok = false, why = "";
    try {
        await mcp.start();
        // Long enough for the person to click Allow in Chrome the first time.
        const r = await mcp.call("browser_tabs", { action: "list" }, 120_000);
        if (r.isError) throw new Error(r.content.map(c => c.text).join(" ").slice(0, 200));
        ok = true;
        // Which profile answered: our extension writes its account's email
        // into its connect page's address. Remember it, so later connections
        // open in this profile and not whichever one was used last.
        let tabs = r.content.map(c => c.text || "").join("\n");
        for (let i = 0; i < 6 && !/#profile=/.test(tabs); i++) {
            await new Promise(res => setTimeout(res, 500));
            tabs = (await mcp.call("browser_tabs", { action: "list" }, 10_000).catch(() => r)).content.map(c => c.text || "").join("\n");
        }
        const email = tabs.match(/#profile=([^)\s&]+)/)?.[1];
        if (email && config) {
            const decoded = decodeURIComponent(email);
            if (/^[^@\s]+@[^@\s]+$/.test(decoded) && decoded !== config.chrome_profile_email) {
                writeConfig({ ...config, chrome_profile_email: decoded });
                console.log(`Chrome profile: ${decoded}`);
            }
        }
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
