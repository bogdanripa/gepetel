// `shell` — a sandbox on the Mac, which is not the Mac.
//
// The upside: a real shell on the person's own machine and connection, doing
// work that would otherwise be a model guessing at arithmetic. The teeth: the
// thing asking for commands is a language model reading text off the public
// internet, so "run this" must never mean "run this on your Mac".
//
// It uses **the sandbox macOS already has** — Seatbelt, via
// `@anthropic-ai/sandbox-runtime`, which generates the profile and runs the
// command under `sandbox-exec`. That is the whole reason this needs no
// installer of its own: nothing to download, nothing to approve, no admin
// password, and it works on an Intel Mac as well as Apple silicon. (The first
// version drove Apple's `container` runtime instead — stronger isolation, a VM
// per command — but it is a separate signed .pkg that only runs on Apple
// silicon with macOS 26, which is a dependency a person installing a menu-bar
// app should never be handed.)
//
// What is enforced, and what the tests actually check:
//
//  - **The home directory is unreadable**, except the workspace. No documents,
//    no Keychain, no SSH keys, no browser profile.
//  - **Nothing outside the workspace is writable** — the rest of the disk is
//    read-only to the command, the agent's own files included.
//  - **The network is a setting**, off or on, enforced by a proxy rather than
//    by hoping a command does not try.
//
// ## Where things get installed
//
// A Seatbelt sandbox is a confinement around a process, not a machine, so there
// is no "inside" to install into — and the Mac itself is read-only to the
// command, which is the point. What a command CAN write is the workspace, so
// that is where everything installable goes, and because the workspace is a
// real folder it all persists: the second time, it is already there.
//
// The trick that makes this work without the model knowing any of it is giving
// the sandboxed command its **own HOME inside the workspace**. `pip`, `npm`,
// `git` and half of everything else write to `~`; pointed at the real home they
// would be denied, and pointed here they simply work, cached and kept. See
// `toolboxEnv`.
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_TIMEOUT_S = 60;
export const MAX_TIMEOUT_S = 1800;
/** Head and tail of the output the model is shown, in characters each. */
export const OUTPUT_HEAD = 1500;
export const OUTPUT_TAIL = 1500;
/** Tools worth telling the model about, if this Mac has them. */
export const PROBE_TOOLS = ["curl", "python3", "node", "npm", "jq", "git", "rg", "unzip"];
/** Everything installable lives here, inside the workspace, and persists. */
export const TOOLBOX = ".gepetel";
/** Anything in here is never swept up. */
export const KEEP = "keep";
/** How long ordinary working files live. A workspace that keeps everything
 *  becomes a junk drawer nobody dares empty; one that keeps nothing makes the
 *  person re-upload the same CSV twice an hour. A day is long enough for a
 *  conversation to finish and short enough that nothing accumulates. */
export const DEFAULT_KEEP_HOURS = 24;

export type ShellResult = { ok: boolean; content: string };

export function workspaceDir(): string {
    return process.env.GEPETEL_WORKSPACE || path.join(os.homedir(), "Gepetel", "workspace");
}

/** The directories a bundled Node lives in, so a command can run `node` even
 *  when the only copy on the machine is the one shipped inside the app. */
function nodeDirs(): string[] {
    try {
        const bin = fs.realpathSync(process.execPath);
        return [path.dirname(bin), path.dirname(path.dirname(bin))];
    } catch { return []; }
}

/** The policy this process initialized the shared SandboxManager with, if any.
 *  See init(): the manager is a singleton and re-initializing it hangs. */
let live: string | null = null;

export class Sandbox {
    readonly kind = "seatbelt";
    private workspace: string;
    private network: boolean;
    private ready: Promise<void> | null = null;
    private toolList: string | null = null;
    /** The queue. One command at a time per device, in the order they arrived. */
    private tail: Promise<unknown> = Promise.resolve();

    private keepHours: number;
    private janitor: NodeJS.Timeout | null = null;

    constructor(opts: { workspace?: string; network?: boolean; keepHours?: number } = {}) {
        this.workspace = opts.workspace || workspaceDir();
        this.network = opts.network !== false;
        const h = Number(opts.keepHours);
        this.keepHours = Number.isFinite(h) && h >= 0 ? h : DEFAULT_KEEP_HOURS;
    }

    get dir(): string { return this.workspace; }
    get toolbox(): string { return path.join(this.workspace, TOOLBOX); }
    get keepDir(): string { return path.join(this.workspace, KEEP); }

    /** Tidy the workspace: working files older than the window go, the toolbox
     *  and `keep/` never do.
     *
     *  Both exemptions matter. Sweeping the toolbox would throw away the
     *  packages that make "install it once" true, and turn every second use
     *  into the first one. `keep/` is the answer to "don't delete that" — a
     *  place the person or the model can put something without needing a
     *  setting, and the one the prompt points at. */
    tidy(now = Date.now()): string[] {
        if (!this.keepHours) return [];
        return sweep(this.workspace, this.keepHours * 3_600_000, now);
    }

    /** Sweep now, then hourly. Unref'd: a quiet agent still exits when asked. */
    startJanitor(): void {
        const run = () => {
            try {
                const gone = this.tidy();
                if (gone.length) console.log(`workspace: tidied ${gone.length} file(s) older than ${this.keepHours}h`);
            } catch (e: any) { console.error("workspace tidy failed:", e?.message || e); }
        };
        run();
        if (this.janitor || !this.keepHours) return;
        this.janitor = setInterval(run, 3_600_000);
        this.janitor.unref?.();
    }

    /** The policy. Read is allow-by-default and narrowed by denying the home
     *  directory; write is deny-by-default and widened to the workspace alone.
     *  Both use the library's documented precedence — `allowRead` beats
     *  `denyRead`, `denyWrite` beats `allowWrite` — rather than a Seatbelt
     *  profile written by hand here. */
    config() {
        const home = os.homedir();
        return {
            network: {
                // `*` is the library's own wildcard. Off means off: an empty
                // list denies everything, which is what the setting is for.
                allowedDomains: this.network ? ["*"] : [],
                deniedDomains: [],
            },
            filesystem: {
                denyRead: [home],
                // The workspace, and wherever this Node came from — a bundled
                // one lives inside the app, but a developer's is often under
                // ~/.nvm, which the deny above would otherwise cover.
                allowRead: [this.workspace, ...nodeDirs()],
                // /tmp as well: too many ordinary tools write a temporary file
                // somewhere, and a shell that cannot is one that fails at
                // `sort`, `curl -o` and most of python.
                allowWrite: [this.workspace, os.tmpdir(), "/tmp"],
                denyWrite: [],
            },
        };
    }

    /** The environment that makes "install it" mean "install it in the
     *  workspace, once".
     *
     *  HOME is the load-bearing one. Point `~` at a directory inside the
     *  workspace and pip, npm, git and every tool that keeps a cache or a
     *  config simply work — and keep working next time, because the folder is
     *  still there. Point it at the real home and they are all denied, which
     *  reads to a model as "this computer is broken" rather than "that is not
     *  allowed". */
    toolboxEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
        const box = this.toolbox;
        const home = path.join(box, "home");
        const bin = path.join(box, "bin");
        const venv = path.join(box, "venv");
        for (const d of [box, home, bin, this.keepDir]) fs.mkdirSync(d, { recursive: true });
        const parts = [bin, path.join(venv, "bin"), ...nodeDirs().slice(0, 1),
            "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
        return {
            ...base,
            HOME: home,
            PATH: [...new Set(parts)].join(":"),
            TMPDIR: base.TMPDIR || os.tmpdir(),
            // A venv is only used once something has created it (see `pipInit`),
            // and naming it here is what makes `pip install` land in it rather
            // than failing against a read-only system python.
            ...(fs.existsSync(path.join(venv, "bin", "python")) ? { VIRTUAL_ENV: venv } : {}),
            npm_config_prefix: path.join(box, "npm"),
            npm_config_cache: path.join(box, "npm-cache"),
            PIP_DISABLE_PIP_VERSION_CHECK: "1",
            PYTHONUSERBASE: path.join(box, "python"),
            GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
            TERM: "dumb",
            NO_COLOR: "1",
            LANG: base.LANG || "en_US.UTF-8",
        };
    }

    /** Is there a usable sandbox here, and what can it run? The answer goes
     *  into `computer_status` verbatim, because "the shell didn't work" with no
     *  reason is the least useful thing a tool can say. */
    async available(): Promise<{ ok: boolean; why: string }> {
        if (!SandboxManager.isSupportedPlatform()) {
            return { ok: false, why: `I can't run commands here — ${process.platform} isn't a platform the sandbox supports.` };
        }
        try {
            const deps = await SandboxManager.checkDependenciesAsync();
            if (deps?.errors?.length) {
                // On a Mac this should not happen: Seatbelt is part of macOS.
                // On Linux (where this gets developed) it means bubblewrap or
                // socat is missing, and saying which is the whole point.
                return { ok: false, why: `The sandbox is missing something it needs: ${deps.errors.join(", ")}.` };
            }
        } catch (e: any) {
            return { ok: false, why: `The sandbox could not start: ${e?.message || e}` };
        }
        return { ok: true, why: this.toolList ? `sandbox ready — has ${this.toolList}` : "sandbox ready" };
    }

    /** Which of the usual tools this Mac actually has. Asked once, inside the
     *  sandbox, because "it has python3" is a promise the model will act on and
     *  a stock macOS may not keep. */
    async tools(): Promise<string> {
        if (this.toolList !== null) return this.toolList;
        // `command -v` is not enough on macOS: /usr/bin/python3 exists as a stub
        // that installs the developer tools when run. Each one is executed.
        const probe = PROBE_TOOLS.map(t => `(${t} --version >/dev/null 2>&1 && printf '%s ' ${t})`).join("; ");
        const r = await this.run(probe, 30);
        const found = r.content.split("\n").slice(1).join(" ");
        this.toolList = PROBE_TOOLS.filter(t => new RegExp(`\\b${t}\\b`).test(found)).join(", ");
        return this.toolList;
    }

    private init(): Promise<void> {
        if (!this.ready) {
            this.ready = (async () => {
                fs.mkdirSync(this.workspace, { recursive: true, mode: 0o700 });
                this.startJanitor();
                const policy = JSON.stringify(this.config());
                // SandboxManager is a module-level singleton owning proxy
                // servers and OS state, so a second initialize with a different
                // policy does not give a second sandbox — it HANGS, which is
                // how this was found (a test run that never finished). One
                // agent means one policy: say so in words instead.
                if (live && live !== policy) {
                    throw new Error("a sandbox is already running with a different policy in this process");
                }
                live = policy;
                await SandboxManager.initialize(this.config() as any);
                // The proxies are what enforce the network setting; a command
                // started before they are listening sees "connection refused"
                // and reads it as "the internet is broken".
                if (this.network) await SandboxManager.waitForNetworkInitialization();
            })().catch(e => { this.ready = null; live = null; throw e; });
        }
        return this.ready;
    }

    /** Run one command, queued behind any other. Never throws. */
    async run(command: string, timeoutS = DEFAULT_TIMEOUT_S): Promise<ShellResult> {
        // Nonsense in, default out. `Number(x) || DEFAULT` looks like it covers
        // this and does not: a negative number is truthy, so `timeout_s: -5`
        // clamped to one second and every command came back "killed after 1s",
        // which reads as a broken sandbox rather than as a bad argument.
        const asked = Number(timeoutS);
        const seconds = Number.isFinite(asked) && asked > 0
            ? Math.min(MAX_TIMEOUT_S, Math.max(1, Math.round(asked)))
            : DEFAULT_TIMEOUT_S;
        const cmd = String(command ?? "").trim();
        if (!cmd) return { ok: false, content: "There was no command to run." };

        // The queue is a promise chain: whatever is already waiting finishes
        // first, in order, and a rejection in one never breaks the next.
        const mine = this.tail.then(() => this.exclusive(cmd, seconds));
        this.tail = mine.catch(() => {});
        return mine;
    }

    private async exclusive(command: string, seconds: number): Promise<ShellResult> {
        try {
            await this.init();
        } catch (e: any) {
            return { ok: false, content: `I couldn't start the sandbox: ${e?.message || e}` };
        }
        const before = snapshot(this.workspace);
        const started = Date.now();
        let out: { code: number | null; stdout: string; stderr: string; killed: boolean };
        try {
            out = await this.spawnSandboxed(command, seconds);
        } catch (e: any) {
            return { ok: false, content: `The sandbox failed: ${e?.message || e}` };
        }
        const wrote = changed(before, snapshot(this.workspace));
        return {
            ok: !out.killed && out.code === 0,
            content: render({
                code: out.code, stdout: out.stdout, stderr: out.stderr, killed: out.killed,
                seconds, elapsed: (Date.now() - started) / 1000, wrote,
            }),
        };
    }

    private async spawnSandboxed(command: string, seconds: number) {
        const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
            command, "/bin/bash", undefined, undefined, this.workspace);
        const full = this.toolboxEnv(env);
        return await new Promise<{ code: number | null; stdout: string; stderr: string; killed: boolean }>(resolve => {
            // Its own process group, so the kill below reaches the children a
            // shell command spawns and not only the shell.
            const child = spawn(argv[0], argv.slice(1), {
                cwd: this.workspace, env: full, detached: true, stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "", stderr = "", killed = false, done = false;
            // Capped while reading rather than after: a runaway `yes` would
            // otherwise fill the agent's memory long before the timeout fired.
            const cap = (s: string, add: string) => (s.length > 4_000_000 ? s : s + add);
            child.stdout?.on("data", d => { stdout = cap(stdout, String(d)); });
            child.stderr?.on("data", d => { stderr = cap(stderr, String(d)); });
            const timer = setTimeout(() => {
                killed = true;
                try { process.kill(-child.pid!, "SIGKILL"); }
                catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
            }, seconds * 1000);
            const finish = (code: number | null) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                // The library turns a bare "Operation not permitted" into a line
                // that says a sandbox did it and which rule — otherwise a model
                // reads a denial as a broken machine and tries again.
                let err = stderr;
                try { err = SandboxManager.annotateStderrWithSandboxFailures(command, stderr); } catch { /* keep the raw one */ }
                resolve({ code, stdout, stderr: err, killed });
            };
            child.on("error", e => { stderr = cap(stderr, String((e as any)?.message || e)); finish(null); });
            child.on("close", code => finish(code));
        });
    }
}

// --- what the model is shown -----------------------------------------------

/** Head and tail, with the middle named rather than silently dropped. A model
 *  that can see "48,210 characters omitted" asks for a narrower command; one
 *  handed a truncated head believes it has the whole thing. */
export function clip(s: string, head = OUTPUT_HEAD, tail = OUTPUT_TAIL): string {
    const text = s.replace(/\s+$/, "");
    if (text.length <= head + tail + 40) return text;
    const omitted = text.length - head - tail;
    return `${text.slice(0, head)}\n…[${omitted.toLocaleString("en-US")} characters omitted]…\n${text.slice(-tail)}`;
}

export function render(x: {
    code: number | null; stdout: string; stderr: string; killed: boolean;
    seconds: number; elapsed: number; wrote: string[];
}): string {
    const lines: string[] = [];
    lines.push(x.killed
        ? `killed after ${x.seconds}s (it was still running)`
        : `exit ${x.code ?? "?"} in ${x.elapsed.toFixed(1)}s`);
    const body = clip(x.stdout || "");
    if (body) lines.push(body);
    const err = clip(x.stderr || "", 600, 600);
    if (err) lines.push(`stderr:\n${err}`);
    if (!body && !err) lines.push("(no output)");
    if (x.wrote.length) {
        lines.push(`wrote: ${x.wrote.slice(0, 8).join(", ")}` +
            (x.wrote.length > 8 ? ` and ${x.wrote.length - 8} more` : ""));
    }
    return lines.join("\n");
}

// --- which files the command left behind ------------------------------------

type Snap = Map<string, string>;

/** Names, sizes and mtimes under the workspace. Bounded: somebody's command
 *  will one day untar a kernel tree in there, and this must not become the
 *  slowest part of running a command. The toolbox is skipped — `npm install`
 *  writing four thousand files is not news. */
export function snapshot(dir: string, limit = 2000): Snap {
    const out: Snap = new Map();
    const walk = (base: string, rel: string) => {
        if (out.size >= limit) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (out.size >= limit) return;
            if (!rel && e.name === TOOLBOX) continue;
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) { walk(path.join(base, e.name), r); continue; }
            if (!e.isFile()) continue;
            try {
                const st = fs.statSync(path.join(base, e.name));
                out.set(r, `${st.size}:${Math.round(st.mtimeMs)}`);
            } catch { /* vanished between readdir and stat */ }
        }
    };
    walk(dir, "");
    return out;
}

/**
 * Delete working files older than `maxAgeMs`, and the directories left empty.
 *
 * Deliberately **not** recursive into the toolbox or `keep/`, and deliberately
 * mtime-based rather than "created": a file the person keeps editing keeps its
 * place. Nothing outside the workspace is ever touched — the function takes a
 * root and never follows a symlink out of it.
 */
export function sweep(root: string, maxAgeMs: number, now = Date.now()): string[] {
    const removed: string[] = [];
    const walk = (base: string, rel: string): boolean => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return false; }
        let empty = true;
        for (const e of entries) {
            if (!rel && (e.name === TOOLBOX || e.name === KEEP)) { empty = false; continue; }
            const full = path.join(base, e.name);
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isSymbolicLink()) { empty = false; continue; }   // never follow one out
            if (e.isDirectory()) {
                if (walk(full, r)) { try { fs.rmdirSync(full); } catch { empty = false; } }
                else empty = false;
                continue;
            }
            if (!e.isFile()) { empty = false; continue; }
            try {
                if (now - fs.statSync(full).mtimeMs > maxAgeMs) { fs.unlinkSync(full); removed.push(r); }
                else empty = false;
            } catch { empty = false; }
        }
        return empty;
    };
    walk(root, "");
    return removed;
}

export function changed(before: Snap, after: Snap): string[] {
    const names: string[] = [];
    for (const [name, stamp] of after) {
        if (before.get(name) !== stamp) names.push(name);
    }
    return names.sort();
}

export default { Sandbox, workspaceDir, clip, render, snapshot, changed, sweep,
    DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S, PROBE_TOOLS, TOOLBOX, KEEP, DEFAULT_KEEP_HOURS };
