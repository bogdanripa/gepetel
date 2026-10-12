// The `shell` sandbox — against the real thing, not a double.
//
// This file used to drive a fake `container` CLI, because the sandbox was a VM
// and there is no VM on a Linux CI box. The built-in sandbox is better off:
// `@anthropic-ai/sandbox-runtime` enforces the same policy on Linux
// (bubblewrap) as on macOS (Seatbelt), so the claims that matter — your home is
// unreadable, the disk is read-only, the network setting is real — are checked
// here for real, by running commands and seeing what they are refused.
//
// What still cannot be checked here is macOS specifically: a Seatbelt profile
// is not a bubblewrap mount namespace, and only a Mac can prove the Mac. That
// is what `gepetel-agent selftest` is for, and its checks are these checks.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    Sandbox, clip, render, snapshot, changed, sweep,
    TOOLBOX, KEEP, DEFAULT_KEEP_HOURS, MAX_TIMEOUT_S, LONG_AFTER_S,
} from "../dist/sandbox.js";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

// A machine without the sandbox's own dependencies (bubblewrap and socat on
// Linux) cannot run these, and pretending otherwise would turn a missing
// dependency into a wall of confusing failures.
let why = null;
if (!SandboxManager.isSupportedPlatform()) why = `${process.platform} has no sandbox`;
else {
    const deps = await SandboxManager.checkDependenciesAsync().catch(e => ({ errors: [String(e?.message || e)] }));
    if (deps?.errors?.length) why = deps.errors.join(", ");
}
const needsSandbox = why ? { skip: `sandbox unavailable here: ${why}` } : {};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gep-ws-"));
const box = new Sandbox({ workspace: root, keepHours: 0 });
const sh = (cmd, t = 30) => box.run(cmd, t);

after(async () => {
    // The sandbox manager owns proxy servers and socat bridges; without this
    // the process stays alive after the last assertion and the run only ends
    // when something kills it.
    try { await SandboxManager.reset?.(); } catch { /* nothing to tear down */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("what a command cannot reach", needsSandbox, () => {
    test("your home directory is unreadable", async () => {
        const r = await sh(`ls -a '${os.homedir()}' 2>&1 | head -20`);
        // Named explicitly: inside the sandbox `~` is the workspace's own home,
        // so `ls ~` would prove nothing at all.
        assert.doesNotMatch(r.content, /Desktop|Documents|\.ssh|Library/);
    });

    test("a private key cannot be read even when the path is handed over", async () => {
        const secret = path.join(os.homedir(), ".ssh", "gepetel-test-key");
        fs.mkdirSync(path.dirname(secret), { recursive: true });
        fs.writeFileSync(secret, "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n");
        try {
            const r = await sh(`cat '${secret}' 2>&1`);
            assert.doesNotMatch(r.content, /BEGIN OPENSSH PRIVATE KEY/);
            assert.equal(r.ok, false);
        } finally { fs.rmSync(secret, { force: true }); }
    });

    test("nothing a command writes outside the workspace reaches the disk", async () => {
        // The claim is about the MACHINE, not about the exit code, and the two
        // sandboxes differ on the latter: Seatbelt refuses the write outright
        // (EPERM), while bubblewrap lets it succeed inside a mount namespace
        // that is then thrown away. Asserting the exit code would pass on one
        // platform and fail on the other while the actual guarantee — your
        // files are untouched — holds on both.
        const outside = path.join(os.homedir(), "gepetel-should-not-exist");
        await sh(`echo pwned > '${outside}' 2>&1`);
        assert.equal(fs.existsSync(outside), false, "a command wrote outside the workspace");
    });

});

describe("what a command can do", needsSandbox, () => {
    test("it runs, and says how it went", async () => {
        const r = await sh("echo hello from the sandbox");
        assert.equal(r.ok, true, r.content);
        assert.match(r.content, /^exit 0 in \d+\.\ds$/m);
        assert.match(r.content, /hello from the sandbox/);
    });

    test("a failing command is a result, not an error", async () => {
        const r = await sh("echo to stderr >&2; exit 3");
        assert.equal(r.ok, false);
        assert.match(r.content, /exit 3/);
        assert.match(r.content, /stderr:\nto stderr/);
    });

    test("files it writes land in the workspace and are reported", async () => {
        const r = await sh("printf 'data' > out.csv; mkdir -p sub; echo x > sub/deep.txt");
        assert.match(r.content, /wrote: .*out\.csv/);
        assert.match(r.content, /sub\/deep\.txt/);
        assert.equal(fs.readFileSync(path.join(root, "out.csv"), "utf8"), "data");
    });

    test("~ is inside the workspace, so what it installs is still there next time", async () => {
        // The whole answer to "will it reinstall every time": pip, npm and git
        // all write to ~, and ~ is a folder in the workspace.
        const first = await sh("echo marker > ~/persist-check; echo $HOME");
        assert.equal(first.ok, true, first.content);
        assert.match(first.content, new RegExp(TOOLBOX.replace(".", "\\.")));
        const second = await sh("cat ~/persist-check");
        assert.match(second.content, /marker/);
        // And it is a real folder on the disk, not a tmpfs that vanishes.
        assert.equal(fs.existsSync(path.join(root, TOOLBOX, "home", "persist-check")), true);
    });

    test("a command that overruns is killed, children and all", async () => {
        // `sleep 30 &` outlives its shell: killing only the shell would leave
        // it running and the sandbox would never be free again.
        const t0 = Date.now();
        const r = await sh("sleep 30 & sleep 30", 2);
        const took = Date.now() - t0;
        assert.equal(r.ok, false);
        assert.match(r.content, /killed after 2s/);
        assert.ok(took < 8000, `took ${took}ms`);
    });

    test("a wall of output is clipped with the middle named", async () => {
        const r = await sh("yes gepetel | head -c 200000");
        assert.ok(r.content.length < 5000, `${r.content.length} chars came back`);
        assert.match(r.content, /characters omitted/);
    });

    test("an empty command is refused before anything runs", async () => {
        const r = await sh("   ");
        assert.equal(r.ok, false);
        assert.match(r.content, /no command/);
    });

    test("a nonsense timeout falls back to the default rather than to one second", async () => {
        const r = await sh("sleep 2; echo survived", -5);
        assert.equal(r.ok, true, r.content);
        assert.match(r.content, /survived/);
    });

    test("two commands queue instead of fighting over the laptop", async () => {
        const results = await Promise.all([
            sh("echo a-start >> order.txt; sleep 0.4; echo a-end >> order.txt"),
            sh("echo b-start >> order.txt; echo b-end >> order.txt"),
        ]);
        assert.ok(results.every(r => r.ok), JSON.stringify(results));
        assert.deepEqual(fs.readFileSync(path.join(root, "order.txt"), "utf8").trim().split("\n"),
            ["a-start", "a-end", "b-start", "b-end"]);
    });

    test("network on reaches the internet from node, not only from curl", async (t) => {
        // Skipped only when this machine itself is offline; a host that can
        // reach the page while the sandbox cannot is exactly the failure.
        const host = await fetch("https://example.com", { signal: AbortSignal.timeout(8000) }).then(r => r.ok, () => false);
        if (!host) return t.skip("this machine has no network");
        const tools = await box.tools();
        if (!/\bnode\b/.test(tools)) return t.skip("no node on PATH here");
        const r = await sh(`node -e "fetch('https://example.com',{signal:AbortSignal.timeout(10000)}).then(r=>console.log(r.status),e=>console.log(e.cause?.code||e.message))"`);
        assert.match(r.content, /\b200\b/, r.content);
    });

    test("progress lines are seen as they are printed, and stay in the output", async () => {
        const seen = [];
        const r = await box.run("for i in 1 2 3; do echo \"::progress:: page $i/3\"; sleep 0.2; done; echo finished", 30,
            undefined, line => seen.push(line));
        assert.deepEqual(seen, ["page 1/3", "page 2/3", "page 3/3"]);
        assert.match(r.content, /finished/);
    });

    test("a long command does not hold up a quick one", async () => {
        const t0 = Date.now();
        const long = box.run("sleep 3; echo long-done", LONG_AFTER_S + 60);
        await new Promise(res => setTimeout(res, 200));
        const quick = await box.run("echo quick", 10);
        const quickAt = Date.now() - t0;
        assert.match(quick.content, /quick/);
        assert.ok(quickAt < 2500, `the quick one waited ${quickAt}ms behind the long one`);
        assert.match((await long).content, /long-done/);
    });

    test("it reports the tools this machine actually has", async () => {
        const tools = await box.tools();
        // Whatever the list is, it must be probed rather than assumed: the
        // claim "it has python3" is one the model will act on.
        assert.match(tools, /curl|node|python3|git/);
    });
});

describe("tidying the workspace", () => {
    const old = 48 * 3600_000, now = Date.now();
    let d;
    const age = (rel, ms) => {
        const f = path.join(d, rel);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, "x");
        fs.utimesSync(f, new Date(now - ms) / 1000, new Date(now - ms) / 1000);
    };

    test("old working files go, recent ones stay", () => {
        d = fs.mkdtempSync(path.join(os.tmpdir(), "gep-sweep-"));
        age("stale.csv", old);
        age("fresh.csv", 60_000);
        const gone = sweep(d, DEFAULT_KEEP_HOURS * 3600_000, now);
        assert.deepEqual(gone, ["stale.csv"]);
        assert.equal(fs.existsSync(path.join(d, "fresh.csv")), true);
    });

    test("what was installed, and anything in keep/, is never swept", () => {
        // Sweeping the toolbox would throw away the packages that make
        // "install it once" true, and turn every second use into the first.
        age(`${TOOLBOX}/home/.npmrc`, old);
        age(`${TOOLBOX}/venv/bin/python`, old);
        age(`${KEEP}/invoice.pdf`, old);
        const gone = sweep(d, DEFAULT_KEEP_HOURS * 3600_000, now);
        assert.deepEqual(gone, []);
        assert.equal(fs.existsSync(path.join(d, TOOLBOX, "venv", "bin", "python")), true);
        assert.equal(fs.existsSync(path.join(d, KEEP, "invoice.pdf")), true);
    });

    test("a directory left empty goes with its files", () => {
        age("scratch/one.txt", old);
        age("scratch/two.txt", old);
        sweep(d, DEFAULT_KEEP_HOURS * 3600_000, now);
        assert.equal(fs.existsSync(path.join(d, "scratch")), false);
    });

    test("a symlink is never followed out of the workspace", () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gep-outside-"));
        fs.writeFileSync(path.join(outside, "precious.txt"), "do not delete");
        fs.utimesSync(path.join(outside, "precious.txt"), new Date(now - old) / 1000, new Date(now - old) / 1000);
        fs.symlinkSync(outside, path.join(d, "escape"));
        sweep(d, DEFAULT_KEEP_HOURS * 3600_000, now);
        assert.equal(fs.existsSync(path.join(outside, "precious.txt")), true,
            "the sweep followed a symlink out of the workspace");
        fs.rmSync(outside, { recursive: true, force: true });
        fs.rmSync(d, { recursive: true, force: true });
    });

    test("keepHours 0 keeps everything", () => {
        const keep = fs.mkdtempSync(path.join(os.tmpdir(), "gep-keep-"));
        fs.writeFileSync(path.join(keep, "ancient.txt"), "x");
        fs.utimesSync(path.join(keep, "ancient.txt"), new Date(now - old) / 1000, new Date(now - old) / 1000);
        assert.deepEqual(new Sandbox({ workspace: keep, keepHours: 0 }).tidy(now), []);
        assert.equal(fs.existsSync(path.join(keep, "ancient.txt")), true);
        fs.rmSync(keep, { recursive: true, force: true });
    });
});

describe("the pieces", () => {
    test("clip names what it dropped", () => {
        const out = clip("x".repeat(10_000), 100, 100);
        assert.ok(out.length < 400, `${out.length}`);
        assert.match(out, /\[9,800 characters omitted\]/);
        assert.equal(clip("short"), "short");
    });

    test("render puts the verdict on the first line", () => {
        const killed = render({ code: 137, stdout: "part", stderr: "", killed: true, seconds: 30, elapsed: 30.2, wrote: [] });
        assert.match(killed.split("\n")[0], /^killed after 30s/);
        const fine = render({ code: 0, stdout: "", stderr: "", killed: false, seconds: 60, elapsed: 0.4, wrote: [] });
        assert.match(fine, /exit 0 in 0\.4s/);
        assert.match(fine, /\(no output\)/);
    });

    test("the workspace diff sees content changes, not just new names", () => {
        const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "gep-snap-"));
        fs.writeFileSync(path.join(d2, "a.txt"), "one");
        const before = snapshot(d2);
        fs.writeFileSync(path.join(d2, "a.txt"), "two!!");
        fs.writeFileSync(path.join(d2, "b.txt"), "new");
        // The toolbox is skipped: `npm install` writing four thousand files is
        // not news the model needs.
        fs.mkdirSync(path.join(d2, TOOLBOX), { recursive: true });
        fs.writeFileSync(path.join(d2, TOOLBOX, "noise.txt"), "x");
        assert.deepEqual(changed(before, snapshot(d2)), ["a.txt", "b.txt"]);
        fs.rmSync(d2, { recursive: true, force: true });
    });

    test("the timeout ceiling is four hours, and long means over five minutes", () => {
        assert.equal(MAX_TIMEOUT_S, 4 * 3600);
        assert.equal(LONG_AFTER_S, 300);
    });
});
