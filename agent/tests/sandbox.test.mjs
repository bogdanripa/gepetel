// The `shell` sandbox, against a fake `container` CLI that is a real program.
//
// Two kinds of claim live in this file, and it is worth being clear about which
// is which, because the second kind is the one that matters most and the one
// these tests cannot make:
//
//  - **Checked here, for real:** the exact argv (the mount list, the limits, the
//    command arriving as ONE argument), the in-sandbox timeout, the output
//    budget, the queue, the bring-up ladder, the idle stop, the reset, and what
//    `computer_status` says when the runtime is missing.
//  - **Not checkable here:** that the thing is actually isolated. There is no
//    VM on a Linux CI box, so the fake runs commands on this machine. `ls
//    /Users` showing nothing of yours, and your SSH keys being unreachable, are
//    proven by `gepetel-agent selftest` on the Mac itself — which exists
//    precisely because this file cannot do it.
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    ContainerSandbox, clip, render, snapshot, changed, DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S,
} from "../dist/sandbox.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fake-container.sh");

let dir, ws;

/** A sandbox wired to the fake CLI. Each one gets its own state and argv log. */
function make(opts = {}) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gep-sbx-"));
    ws = path.join(dir, "workspace");
    fs.mkdirSync(ws, { recursive: true });
    process.env.GEPETEL_FAKE_DIR = dir;
    process.env.GEPETEL_FAKE_WS = ws;
    return new ContainerSandbox({ bin: FAKE, workspace: ws, idleMs: 0, ...opts });
}

/** Every invocation of the fake, as arrays of arguments. NUL-separated in the
 *  log on purpose: an argument may contain spaces or newlines, and the whole
 *  point of one of the tests below is that the command is a single argument. */
function invocations() {
    const raw = fs.existsSync(path.join(dir, "argv.log"))
        ? fs.readFileSync(path.join(dir, "argv.log"), "utf8") : "";
    return raw.split("\x1e").filter(r => r.length)
        .map(r => r.split("\0").filter((a, i, all) => !(a === "" && i === all.length - 1)));
}

const ofKind = k => invocations().filter(a => a[0] === k);

before(() => { fs.chmodSync(FAKE, 0o755); });
beforeEach(() => { /* each test makes its own sandbox */ });
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } });

describe("what gets run, exactly", () => {
    test("the command is ONE argument, never a string a host shell expands", async () => {
        const sb = make();
        // If this ever reached a host shell, the `;` would end the command and
        // the rest would run on the Mac. It must arrive whole.
        const nasty = `echo one; echo "two"; $(echo three) \`echo four\` && touch ${path.join(dir, "PWNED")}`;
        await sb.run(nasty, 20);
        const exec = ofKind("exec").at(-1);
        assert.ok(exec.includes(nasty), `the command was not passed intact: ${JSON.stringify(exec)}`);
        assert.equal(exec.filter(a => a === nasty).length, 1);
        // And it is the LAST argument, after $0 — a positional parameter, which
        // is what makes quoting in it inert.
        assert.equal(exec.at(-1), nasty);
        assert.equal(exec.at(-2), "gepetel-shell");
        assert.match(exec.at(-3), /^timeout -s KILL \d+ bash -c "\$1"$/);
    });

    test("one mount, hard limits, and no --rm", async () => {
        const sb = make();
        await sb.run("echo hi", 20);       // nothing exists yet, so this creates it
        const created = ofKind("run").at(-1);
        assert.ok(created, "the container was never created");
        // The whole isolation story in one assertion: exactly one path from the
        // Mac is mounted, and it is the workspace.
        const mounts = created.filter((a, i) => created[i - 1] === "--volume");
        assert.deepEqual(mounts, [`${ws}:/workspace`]);
        assert.ok(created.includes("--cpus") && created.includes("2"), created.join(" "));
        assert.ok(created.includes("--memory") && created.includes("2g"), created.join(" "));
        // --rm would throw the filesystem away on every stop, and with it
        // everything the person installed.
        assert.ok(!created.includes("--rm"), created.join(" "));
        assert.ok(created.includes("--detach"), created.join(" "));
        // Network on by default: curl in there is the point of the tool.
        assert.ok(!created.includes("none"), created.join(" "));
    });

    test("network off is a flag, not a hope", async () => {
        const sb = make({ network: false });
        await sb.run("echo hi", 20);
        const created = ofKind("run").at(-1);
        const i = created.indexOf("--network");
        assert.ok(i > 0 && created[i + 1] === "none", created.join(" "));
    });

    test("the working directory is the workspace", async () => {
        const sb = make();
        await sb.run("echo hi", 20);
        const exec = ofKind("exec").at(-1);
        const i = exec.indexOf("--workdir");
        assert.ok(i > 0 && exec[i + 1] === "/workspace", exec.join(" "));
    });
});

describe("running something", () => {
    test("output, exit code and duration come back", async () => {
        const sb = make();
        const r = await sb.run("echo hello from the sandbox", 20);
        assert.equal(r.ok, true, r.content);
        assert.match(r.content, /^exit 0 in \d+\.\ds$/m);
        assert.match(r.content, /hello from the sandbox/);
    });

    test("a failing command is a result, not an error", async () => {
        const sb = make();
        const r = await sb.run("echo to stderr >&2; exit 3", 20);
        assert.equal(r.ok, false);
        assert.match(r.content, /exit 3/);
        assert.match(r.content, /stderr:\nto stderr/);
    });

    test("an empty command is refused before anything runs", async () => {
        const sb = make();
        const r = await sb.run("   ", 20);
        assert.equal(r.ok, false);
        assert.equal(ofKind("exec").length, 0);
    });

    test("a command that overruns is killed inside the sandbox", async () => {
        const sb = make();
        const t0 = Date.now();
        const r = await sb.run("sleep 30", 1);
        const took = Date.now() - t0;
        assert.equal(r.ok, false);
        assert.match(r.content, /killed after 1s/);
        // The kill has to come from `timeout` in the sandbox, which means it
        // lands about when asked — not from the client's grace period, ten
        // seconds later.
        assert.ok(took < 5000, `took ${took}ms, so the in-sandbox timeout did not fire`);
    });

    test("a wall of output is clipped with the middle named", async () => {
        const sb = make();
        const r = await sb.run("yes gepetel | head -c 200000", 30);
        assert.ok(r.content.length < 5000, `${r.content.length} chars came back`);
        assert.match(r.content, /characters omitted/);
    });

    test("files the command left in the workspace are reported", async () => {
        const sb = make();
        const r = await sb.run("printf 'data' > /workspace/out.csv; mkdir -p sub; echo x > sub/deep.txt", 20);
        assert.match(r.content, /wrote in \/workspace: .*out\.csv/);
        assert.match(r.content, /sub\/deep\.txt/);
        // And it really is on the host side of the mount.
        assert.equal(fs.readFileSync(path.join(ws, "out.csv"), "utf8"), "data");
    });

    test("a file that was only read is not reported as written", async () => {
        const sb = make();
        fs.writeFileSync(path.join(ws, "input.txt"), "hello");
        const r = await sb.run("cat /workspace/input.txt", 20);
        assert.match(r.content, /hello/);
        assert.doesNotMatch(r.content, /wrote in/);
    });

    test("timeout_s is clamped, not trusted", async () => {
        const sb = make();
        await sb.run("echo hi", 99_999);
        assert.match(ofKind("exec").at(-1).at(-3), new RegExp(`timeout -s KILL ${MAX_TIMEOUT_S} `));
        await sb.run("echo hi", 0);
        assert.match(ofKind("exec").at(-1).at(-3), new RegExp(`timeout -s KILL ${DEFAULT_TIMEOUT_S} `));
        await sb.run("echo hi", -5);
        assert.match(ofKind("exec").at(-1).at(-3), new RegExp(`timeout -s KILL ${DEFAULT_TIMEOUT_S} `));
    });
});

describe("one at a time", () => {
    test("two commands queue instead of fighting over 2 GB of RAM", async () => {
        const sb = make();
        // The container path, as a real command would use it.
        const both = Promise.all([
            sb.run("echo a-start >> /workspace/order.txt; sleep 0.4; echo a-end >> /workspace/order.txt", 20),
            sb.run("echo b-start >> /workspace/order.txt; echo b-end >> /workspace/order.txt", 20),
        ]);
        const results = await both;
        assert.ok(results.every(r => r.ok), JSON.stringify(results));
        const order = fs.readFileSync(path.join(ws, "order.txt"), "utf8").trim().split("\n");
        // Interleaving would read a-start, b-start, …
        assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
    });

    test("a command that fails does not block the queue behind it", async () => {
        const sb = make();
        const [bad, good] = await Promise.all([
            sb.run("exit 9", 20),
            sb.run("echo still here", 20),
        ]);
        assert.equal(bad.ok, false);
        assert.equal(good.ok, true, good.content);
        assert.match(good.content, /still here/);
    });
});

describe("bringing the sandbox up", () => {
    test("a container that exists but is not running is started, not rebuilt", async () => {
        const sb = make();
        await sb.run("echo first", 20);                  // creates it
        fs.rmSync(path.join(dir, "argv.log"), { force: true });
        // Stopped, but still there — which is what an idle sandbox becomes.
        // The fake refuses `exec` while `start` succeeds, because the container
        // exists.
        fs.rmSync(path.join(dir, "running"), { force: true });
        const r = await sb.run("echo second", 20);
        assert.equal(r.ok, true, r.content);
        assert.match(r.content, /second/);
        // `start` keeps what was installed in it; `run` would be a new
        // container and a clean slate nobody asked for.
        assert.equal(ofKind("start").length, 1, invocations().map(a => a[0]).join(","));
        assert.equal(ofKind("run").length, 0, "it built a second container instead of starting this one");
    });

    test("with no container at all, one is created and the command still runs", async () => {
        const sb = make();
        fs.rmSync(path.join(dir, "state"), { force: true });
        fs.rmSync(path.join(dir, "running"), { force: true });
        const r = await sb.run("echo made it", 20);
        assert.equal(r.ok, true, r.content);
        assert.match(r.content, /made it/);
        // The ladder: exec (fails, nothing there) → start (fails) → run.
        const kinds = invocations().map(a => a[0]);
        assert.deepEqual(kinds.slice(0, 3), ["exec", "start", "run"]);
    });

    test("'no such container' is told apart from a command that merely failed", async () => {
        const sb = make();
        await sb.run("echo warm", 20);                  // bring it up first
        fs.rmSync(path.join(dir, "argv.log"), { force: true });
        // exit 1 WITH output is the command's own failure: nothing should be
        // restarted and no second attempt made. Getting this wrong means every
        // failing command silently runs twice.
        const r = await sb.run("echo oops; exit 1", 20);
        assert.equal(r.ok, false);
        assert.equal(ofKind("start").length, 0, "it tried to restart a container that was fine");
        assert.equal(ofKind("exec").length, 1, "the command ran more than once");
    });

    test("a reset throws the container away", async () => {
        const sb = make();
        await sb.run("echo one", 20);
        const r = await sb.run("echo two", 20, { reset: true });
        assert.ok(fs.existsSync(path.join(dir, "removed")), "rm --force was never called");
        const rm = ofKind("rm").at(-1);
        assert.ok(rm.includes("--force"), rm.join(" "));
        assert.equal(r.ok, true, r.content);
    });

    test("the container is stopped when idle, and only when nothing is running", async () => {
        const sb = make({ idleMs: 120 });
        await sb.run("echo hi", 20);
        await new Promise(r => setTimeout(r, 400));
        assert.ok(fs.existsSync(path.join(dir, "stopped")), "it never stopped");
        assert.equal(ofKind("stop").at(-1)[1], "gepetel-sandbox");
    });
});

describe("when there is no runtime", () => {
    test("a missing CLI says what to install", async () => {
        const sb = make({ bin: path.join(dir, "definitely-not-here") });
        const av = await sb.available();
        assert.equal(av.ok, false);
        assert.match(av.why, /not installed/);
        assert.match(av.why, /apple\/container/);
        assert.match(av.why, /build\.sh/);
    });

    test("an installed-but-broken CLI says that instead", async () => {
        const sb = make();
        fs.writeFileSync(path.join(dir, "broken"), "1");
        const av = await sb.available();
        assert.equal(av.ok, false);
        assert.match(av.why, /not working/);
        assert.match(av.why, /cannot connect/);
    });

    test("a working CLI reports its version", async () => {
        const sb = make();
        const av = await sb.available();
        assert.equal(av.ok, true, av.why);
        assert.match(av.why, /1\.0\.0/);
    });
});

describe("the pieces", () => {
    test("clip names what it dropped", () => {
        const text = "x".repeat(10_000);
        const out = clip(text, 100, 100);
        assert.ok(out.length < 400, `${out.length}`);
        assert.match(out, /\[9,800 characters omitted\]/);
        // Short output is left exactly alone.
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
        const d = fs.mkdtempSync(path.join(os.tmpdir(), "gep-snap-"));
        fs.writeFileSync(path.join(d, "a.txt"), "one");
        const before = snapshot(d);
        fs.writeFileSync(path.join(d, "a.txt"), "two!!");   // same name, new size
        fs.writeFileSync(path.join(d, "b.txt"), "new");
        assert.deepEqual(changed(before, snapshot(d)), ["a.txt", "b.txt"]);
        fs.rmSync(d, { recursive: true, force: true });
    });
});
