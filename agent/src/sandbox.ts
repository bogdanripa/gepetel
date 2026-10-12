// `shell` — a Linux sandbox on the Mac, which is not the Mac.
//
// This is the tool with the most upside and the most teeth. The upside: a real
// shell with curl, jq, python3 and node, on the person's own connection, doing
// the work that would otherwise be a model guessing at arithmetic. The teeth:
// the thing asking for commands is a language model reading text off the public
// internet, so "run this" must never mean "run this on your Mac".
//
// So it runs in Apple's `container` — each container its own lightweight VM,
// not a namespace — with **one** path from the Mac mounted into it:
// `~/Gepetel/workspace`. No home directory, no Keychain, no SSH keys, no
// browser profile. The only way a command can see a file of the person's is if
// they put it in that folder.
//
// Four more rules, each of which exists because the obvious version is wrong:
//
//  - **The command is an argv element, never a string a shell expands.** It is
//    handed to bash inside the container as a positional parameter (see
//    `execArgv`), so no amount of quoting in it can reach the host.
//  - **The kill happens inside the sandbox.** Killing the `container exec`
//    client on the Mac leaves the process running in the VM, so the timeout is
//    `timeout -s KILL` *in there*, with the client's own deadline as a backstop.
//  - **One command at a time per device**, queued. Two models' worth of
//    concurrent `pip install` in one 2 GB VM is not a thing anybody needs.
//  - **The container is stopped when idle, not removed.** Packages someone
//    installed survive until they ask for a reset, which is the difference
//    between a sandbox and a toy.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_TIMEOUT_S = 60;
export const MAX_TIMEOUT_S = 1800;
/** Head and tail of the output the model is shown, in characters each. */
export const OUTPUT_HEAD = 1500;
export const OUTPUT_TAIL = 1500;
const IDLE_STOP_MS = 15 * 60 * 1000;
/** The client's own deadline, past the in-sandbox one: if `timeout` itself is
 *  somehow not doing its job, the call still returns. */
const CLIENT_GRACE_MS = 10_000;

export const IMAGE = "gepetel/sandbox";
export const CONTAINER_NAME = "gepetel-sandbox";

export type ShellResult = { ok: boolean; content: string };

export type ExecOut = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
export type Exec = (argv: string[], timeoutMs: number) => Promise<ExecOut>;

export function workspaceDir(): string {
    return process.env.GEPETEL_WORKSPACE || path.join(os.homedir(), "Gepetel", "workspace");
}

/** Spawn without a shell. argv[0] is the program; nothing is ever parsed. */
export const spawnExec: Exec = (argv, timeoutMs) => new Promise<ExecOut>(resolve => {
    let child;
    try {
        child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e: any) {
        return resolve({ code: null, stdout: "", stderr: String(e?.message || e), timedOut: false });
    }
    let stdout = "", stderr = "", timedOut = false, done = false;
    // Capped while reading rather than after: a runaway `yes` would otherwise
    // fill the agent's memory long before the timeout fired.
    const cap = (s: string, add: string) => (s.length > 4_000_000 ? s : s + add);
    child.stdout?.on("data", d => { stdout = cap(stdout, String(d)); });
    child.stderr?.on("data", d => { stderr = cap(stderr, String(d)); });
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    const finish = (code: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
    };
    child.on("error", e => { stderr = cap(stderr, String((e as any)?.message || e)); finish(null); });
    child.on("close", code => finish(code));
});

/** Text that says the container was not there to run anything in.
 *
 *  Needed because a missing container and a command that merely exited 1 both
 *  come back as "the CLI exited non-zero": the difference is that the CLI
 *  complains on stderr and the command produced nothing. Checked rather than
 *  assumed, so `container exec` is the only subcommand on the happy path — no
 *  dependence on `inspect` or `list`, whose names and output this code cannot
 *  verify from a Linux box. */
const NOT_UP = /(no such|not found|not running|does not exist|is not running|cannot find|unknown container)/i;

export class ContainerSandbox {
    readonly kind = "container";
    private bin: string;
    private name: string;
    private image: string;
    private workspace: string;
    private network: boolean;
    private exec: Exec;
    private idleMs: number;
    private idleTimer: NodeJS.Timeout | null = null;
    /** The queue. One command at a time per device, in the order they arrived. */
    private tail: Promise<unknown> = Promise.resolve();
    private running = 0;

    constructor(opts: {
        bin?: string; name?: string; image?: string; workspace?: string;
        network?: boolean; exec?: Exec; idleMs?: number;
    } = {}) {
        this.bin = opts.bin || process.env.GEPETEL_CONTAINER_BIN || "container";
        this.name = opts.name || CONTAINER_NAME;
        this.image = opts.image || IMAGE;
        this.workspace = opts.workspace || workspaceDir();
        this.network = opts.network !== false;
        this.exec = opts.exec || spawnExec;
        this.idleMs = opts.idleMs ?? IDLE_STOP_MS;
    }

    /** Is there a usable sandbox on this machine? Cheap, and the answer goes
     *  into `computer_status` verbatim, because "the shell didn't work" with no
     *  reason is the least useful thing a tool can say. */
    async available(): Promise<{ ok: boolean; why: string }> {
        const r = await this.exec([this.bin, "--version"], 8_000);
        if (r.code === 0) return { ok: true, why: `Apple container (${(r.stdout || "").trim().split("\n")[0] || "ok"})` };
        if (/ENOENT|not found|no such file/i.test(r.stderr) || r.code === null) {
            return {
                ok: false,
                // Read out loud in a chat, so: short, and every clause is
                // something the person can act on. The full version, with the
                // hardware check, is in agent/sandbox/build.sh.
                why: "I can't run commands on this Mac yet: Apple's `container` runtime isn't installed. " +
                     "Get the installer from github.com/apple/container/releases, run `container system start`, " +
                     "then `agent/sandbox/build.sh`. It needs an Apple-silicon Mac on macOS 26.",
            };
        }
        return { ok: false, why: `\`container\` is installed but not working: ${(r.stderr || "").trim().slice(0, 160)}` };
    }

    /** The argv for one command. Kept as its own function because it is the
     *  part a test can check exactly, and the part where a mistake is a hole
     *  rather than a bug: the mount list, the limits, and the fact that the
     *  command is a positional parameter rather than string interpolation. */
    execArgv(command: string, timeoutS: number): string[] {
        return [
            this.bin, "exec", "--workdir", "/workspace", this.name,
            "bash", "-lc",
            // $1 is the command, handed to bash as one argument. `timeout` runs
            // INSIDE the container, so the kill lands on the process rather
            // than on the client that was watching it.
            `timeout -s KILL ${Math.round(timeoutS)} bash -c "$1"`,
            "gepetel-shell",   // $0, which is what bash calls itself in errors
            command,           // $1
        ];
    }

    /** The argv that creates the container. One mount, hard limits, and no
     *  `--rm`: a stopped container keeps its filesystem, which is how an
     *  installed package survives until someone asks for a reset. */
    createArgv(): string[] {
        const argv = [
            this.bin, "run", "--detach", "--name", this.name,
            "--cpus", "2", "--memory", "2g",
            // The only path from the Mac that exists in there.
            "--volume", `${this.workspace}:/workspace`,
        ];
        if (!this.network) argv.push("--network", "none");
        argv.push(this.image, "sleep", "infinity");
        return argv;
    }

    private async bringUp(): Promise<{ ok: boolean; why: string }> {
        fs.mkdirSync(this.workspace, { recursive: true, mode: 0o700 });
        // Start the one that exists before making another: `start` on a stopped
        // container keeps whatever was installed in it.
        const started = await this.exec([this.bin, "start", this.name], 120_000);
        if (started.code === 0) return { ok: true, why: "" };
        const made = await this.exec(this.createArgv(), 180_000);
        if (made.code === 0) return { ok: true, why: "" };
        const why = (made.stderr || made.stdout || "").trim().slice(0, 200);
        if (/image|not found|pull/i.test(why)) {
            return { ok: false, why: `the sandbox image isn't built yet — run agent/sandbox/build.sh on the Mac (${why})` };
        }
        // The installer puts the CLI in place and leaves the service stopped,
        // which is a separate step people miss — and the runtime's own error
        // for it does not say so.
        if (/daemon|service|socket|connect|xpc|not running/i.test(why)) {
            return { ok: false, why: `the container service isn't running — run \`container system start\` on the Mac (${why})` };
        }
        return { ok: false, why: why || "the sandbox would not start" };
    }

    /** Throw the container away and build a fresh one. The escape hatch for a
     *  sandbox somebody has made a mess of. */
    async reset(): Promise<void> {
        await this.exec([this.bin, "rm", "--force", this.name], 60_000);
    }

    stop(): void {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        void this.exec([this.bin, "stop", this.name], 60_000).catch(() => {});
    }

    private touchIdle(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        if (!this.idleMs) return;
        // Stopped, never removed — see reset(). unref so an idle agent can still
        // exit when asked to.
        this.idleTimer = setTimeout(() => {
            if (this.running === 0) void this.exec([this.bin, "stop", this.name], 60_000).catch(() => {});
        }, this.idleMs);
        this.idleTimer.unref?.();
    }

    /** Run one command, queued behind any other. Never throws. */
    async run(command: string, timeoutS = DEFAULT_TIMEOUT_S, opts: { reset?: boolean } = {}): Promise<ShellResult> {
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
        const mine = this.tail.then(() => this.exclusive(cmd, seconds, !!opts.reset));
        this.tail = mine.catch(() => {});
        return mine;
    }

    private async exclusive(command: string, seconds: number, reset: boolean): Promise<ShellResult> {
        this.running++;
        try {
            if (reset) await this.reset();
            const before = snapshot(this.workspace);
            const started = Date.now();

            let out = await this.exec(this.execArgv(command, seconds), seconds * 1000 + CLIENT_GRACE_MS);
            if (notUp(out)) {
                const up = await this.bringUp();
                if (!up.ok) return { ok: false, content: `I couldn't start the sandbox: ${up.why}` };
                out = await this.exec(this.execArgv(command, seconds), seconds * 1000 + CLIENT_GRACE_MS);
                if (notUp(out)) {
                    return { ok: false, content: `The sandbox isn't answering: ${(out.stderr || "").trim().slice(0, 200)}` };
                }
            }
            const elapsed = (Date.now() - started) / 1000;
            // 137 is SIGKILL, which is what `timeout -s KILL` leaves behind, and
            // 124 is `timeout` itself reporting it fired.
            const killed = out.timedOut || out.code === 124 || out.code === 137;
            const wrote = changed(before, snapshot(this.workspace));
            return {
                ok: !killed && out.code === 0,
                content: render({ code: out.code, stdout: out.stdout, stderr: out.stderr, killed, seconds, elapsed, wrote }),
            };
        } catch (e: any) {
            return { ok: false, content: `The sandbox failed: ${e?.message || e}` };
        } finally {
            this.running--;
            this.touchIdle();
        }
    }
}

function notUp(out: ExecOut): boolean {
    return out.code !== 0 && !out.stdout && NOT_UP.test(out.stderr || "");
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
        lines.push(`wrote in /workspace: ${x.wrote.slice(0, 8).join(", ")}` +
            (x.wrote.length > 8 ? ` and ${x.wrote.length - 8} more` : ""));
    }
    return lines.join("\n");
}

// --- which files the command left behind ------------------------------------

type Snap = Map<string, string>;

/** Names, sizes and mtimes under the workspace. Bounded: somebody's command
 *  will one day untar a kernel tree in there, and this must not become the
 *  slowest part of running a command. */
export function snapshot(dir: string, limit = 2000): Snap {
    const out: Snap = new Map();
    const walk = (base: string, rel: string) => {
        if (out.size >= limit) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (out.size >= limit) return;
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

export function changed(before: Snap, after: Snap): string[] {
    const names: string[] = [];
    for (const [name, stamp] of after) {
        if (before.get(name) !== stamp) names.push(name);
    }
    return names.sort();
}

export default { ContainerSandbox, workspaceDir, clip, render, snapshot, changed,
    DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S, IMAGE, CONTAINER_NAME };
