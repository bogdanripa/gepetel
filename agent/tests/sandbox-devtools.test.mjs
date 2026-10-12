// A Mac without Apple's developer tools.
//
// Its /usr/bin/python3 and /usr/bin/git are stubs that, when run, offer to
// install the developer tools in a dialog. Somebody who installed an app and
// never opened a terminal must not get that dialog because a probe ran, so the
// sandbox shadows the stubs with stand-ins that say what is missing.
//
// Own file, own process: the sandbox manager holds one policy per process, and
// these stand-ins live in the workspace the other files use.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Sandbox, DEVTOOLS_STUBS, TOOLBOX } from "../dist/sandbox.js";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

let why = null;
if (!SandboxManager.isSupportedPlatform()) why = `${process.platform} has no sandbox`;
else {
    const deps = await SandboxManager.checkDependenciesAsync().catch(e => ({ errors: [String(e?.message || e)] }));
    if (deps?.errors?.length) why = deps.errors.join(", ");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gep-dev-"));
after(async () => {
    try { await SandboxManager.reset?.(); } catch { /* nothing to tear down */ }
    fs.rmSync(root, { recursive: true, force: true });
});

// Which stubs this machine would actually reach: a tool that also exists in
// Homebrew's or /usr/local's bin is real, and must not be shadowed.
const reachesStub = t => !["/opt/homebrew/bin", "/usr/local/bin"].some(d => fs.existsSync(path.join(d, t)));
const shadowed = DEVTOOLS_STUBS.filter(reachesStub);

describe("without the developer tools", why ? { skip: `sandbox unavailable here: ${why}` } : {}, () => {
    test("a stub is never run: the stand-in answers, and says what is missing", async (t) => {
        if (!shadowed.length) return t.skip("every stub has a real copy on this machine");
        const box = new Sandbox({ workspace: root, keepHours: 0, devTools: false });
        const tools = await box.tools();
        for (const name of shadowed) assert.doesNotMatch(tools, new RegExp(`\\b${name}\\b`), tools);
        const r = await box.run(`${shadowed[0]} --version`, 20);
        assert.match(r.content, /not installed on this Mac/, r.content);
        assert.equal(r.ok, false);
    });

    test("a real tool of the same name is left alone", () => {
        for (const name of DEVTOOLS_STUBS.filter(t => !reachesStub(t))) {
            assert.equal(fs.existsSync(path.join(root, TOOLBOX, "bin", name)), false, name);
        }
    });

    test("something of the person's own in the toolbox is never overwritten", () => {
        const bin = path.join(root, TOOLBOX, "bin");
        fs.mkdirSync(bin, { recursive: true });
        const mine = path.join(bin, "git");
        fs.writeFileSync(mine, "#!/bin/sh\necho mine\n", { mode: 0o755 });
        // standIns runs once per process; call it the way init does.
        new Sandbox({ workspace: root, keepHours: 0, devTools: false })["standIns"]();
        assert.equal(fs.readFileSync(mine, "utf8"), "#!/bin/sh\necho mine\n");
    });

    test("once the tools are there, the stand-ins go", () => {
        const bin = path.join(root, TOOLBOX, "bin");
        new Sandbox({ workspace: root, keepHours: 0, devTools: true })["standIns"]();
        for (const name of shadowed.filter(n => n !== "git")) {
            assert.equal(fs.existsSync(path.join(bin, name)), false, name);
        }
        assert.equal(fs.existsSync(path.join(bin, "git")), true, "the person's own git stays");
    });
});
