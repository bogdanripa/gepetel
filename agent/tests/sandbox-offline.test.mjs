// `shell_network: false` means off.
//
// Its own file, and therefore its own process, on purpose: the sandbox manager
// is a singleton that owns proxy servers, so one process can hold exactly one
// policy. Asking it for a second one hung the entire test run, which is how
// that was found — see the guard in src/sandbox.ts.
//
// The direction matters more than the mechanism. A network switch that failed
// OPEN would be worse than having no switch at all.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Sandbox } from "../dist/sandbox.js";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

let why = null;
if (!SandboxManager.isSupportedPlatform()) why = `${process.platform} has no sandbox`;
else {
    const deps = await SandboxManager.checkDependenciesAsync().catch(e => ({ errors: [String(e?.message || e)] }));
    if (deps?.errors?.length) why = deps.errors.join(", ");
}

// Same teardown as the other file: the manager owns servers, and without it
// the process outlives its last assertion.
after(async () => { try { await SandboxManager.reset?.(); } catch { /* nothing to tear down */ } });

describe("the network switch", why ? { skip: `sandbox unavailable here: ${why}` } : {}, () => {
    test("off means no connection", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "gep-off-"));
        try {
            const box = new Sandbox({ workspace: root, network: false, keepHours: 0 });
            const r = await box.run("curl -sS -m 6 -o /dev/null -w '%{http_code}' https://example.com 2>&1", 20);
            assert.doesNotMatch(r.content, /\b200\b/, r.content);
            assert.equal(r.ok, false, r.content);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });

    test("a second policy in one process is refused in words, not by hanging", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "gep-two-"));
        try {
            const other = new Sandbox({ workspace: root, network: true, keepHours: 0 });
            const r = await other.run("echo hi", 20);
            assert.match(r.content, /already running with a different policy/);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
});
