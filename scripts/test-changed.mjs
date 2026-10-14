#!/usr/bin/env node
// Runs the tests that cover what changed — while developing. The owner,
// 2026-10-14: "split them so that you look at what changed and only run
// relevant tests … when launching in the stores, that's when a full test
// suite must run."
//
//   node scripts/test-changed.mjs                 uncommitted changes (or the last commit, if none)
//   node scripts/test-changed.mjs --since <ref>   everything since <ref> (e.g. mac-v0.12.8)
//   node scripts/test-changed.mjs --all           the full suite — before a store release
//   node scripts/test-changed.mjs --dry           say what would run, run nothing
//
// The map below is the whole policy: a changed path → the suites that cover
// it. Extension e2e sections are named in agent/tests/extension.e2e.mjs
// (run("1i") …); ONLY= runs a subset of them.
import { execSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dry = args.includes("--dry"), all = args.includes("--all");
const since = args.includes("--since") ? args[args.indexOf("--since") + 1] : null;
const sh = c => execSync(c, { cwd: root, encoding: "utf8" }).trim();

const EXT_ALL = ["1c", "1d", "1d2", "1d3", "1e", "1f", "1g", "1h", "1i", "1j", "1l", "1m"];

/** [path pattern, suites]. Suites: server, agent, chrome (build), ext:<sections|all>,
 *  devicejobs, device, heartbeat, file:<test file>. First match wins per file,
 *  so the specific come before the general. */
const MAP = [
    [/^agent\/src\/human\.ts$/, ["agent", "ext:1i,1j,1l,1m"]],
    [/^agent\/src\/sites\.ts$/, ["agent", "ext:1e"]],
    [/^agent\/src\/takeover\.ts$/, ["agent", "ext:1d3,1h", "devicejobs"]],
    [/^agent\/src\/(browse|bridge|mcpClient|extension)\.ts$/, ["agent", "ext:all"]],
    [/^agent\/src\/(index|outbox)\.ts$/, ["agent", "devicejobs", "heartbeat"]],
    [/^agent\/src\//, ["agent"]],
    [/^agent\/bin\//, ["ext:all"]],
    [/^agent\/tests\/extension\.e2e\.mjs$/, ["ext:all"]],
    [/^agent\/tests\/(heartbeat)\.e2e\.mjs$/, ["heartbeat"]],
    [/^agent\/tests\/.*\.test\.mjs$/, ["agent"]],
    [/^chrome\/(src|guard|manifest\.json|vite|package)/, ["chrome", "ext:all"]],
    [/^src\/device\/takeover\.ts$/, ["server", "devicejobs"]],
    [/^src\/device\//, ["server", "devicejobs", "device"]],
    [/^tests\/device-jobs\.e2e\.mjs$/, ["devicejobs"]],
    [/^tests\/device\.e2e\.mjs$/, ["device"]],
    [/^(src|prompts|website|tests)\//, ["server"]],
];

let files = [];
if (!all) {
    if (since) files = sh(`git diff --name-only ${since}`).split("\n");
    else {
        files = [...sh("git diff --name-only HEAD").split("\n"), ...sh("git ls-files --others --exclude-standard").split("\n")];
        if (!files.filter(Boolean).length) files = sh("git diff --name-only HEAD~1 HEAD").split("\n");
    }
    files = files.filter(Boolean);
}

const suites = new Set(), ext = new Set(), why = new Map(), unmatched = [];
const add = (s, f) => {
    if (s.startsWith("ext:")) { for (const x of s.slice(4) === "all" ? EXT_ALL : s.slice(4).split(",")) ext.add(x); s = "ext"; }
    suites.add(s); if (!why.has(s)) why.set(s, []); if (f) why.get(s).push(f);
};
if (all) for (const s of ["chrome", "server", "agent", "ext:all", "devicejobs", "device", "heartbeat"]) add(s);
for (const f of files) {
    const hit = MAP.find(([re]) => re.test(f));
    if (hit) hit[1].forEach(s => add(s, f)); else unmatched.push(f);
}

// In order: builds first, cheap before slow.
const plan = [];
if (suites.has("chrome")) plan.push(["chrome build", "npm run build", "chrome"]);
if (suites.has("server") || suites.has("devicejobs") || suites.has("device")) plan.push(["server build + unit tests", "npm test", "."]);
if (suites.has("agent") || suites.has("ext") || suites.has("devicejobs") || suites.has("heartbeat")) plan.push(["agent build + unit tests", "npm test", "agent"]);
if (suites.has("heartbeat")) plan.push(["heartbeat e2e", "node tests/heartbeat.e2e.mjs", "agent"]);
if (suites.has("ext")) plan.push([`extension e2e (${ext.size === EXT_ALL.length ? "all" : [...ext].join(",")})`, "node tests/extension.e2e.mjs", "agent", ext.size === EXT_ALL.length ? {} : { ONLY: [...ext].join(",") }]);
if (suites.has("devicejobs")) plan.push(["device jobs e2e", "node tests/device-jobs.e2e.mjs", "."]);
if (suites.has("device")) plan.push(["device e2e", "node tests/device.e2e.mjs", "."]);

console.log(all ? "Full suite (store release)." : `${files.length} changed file(s)${since ? ` since ${since}` : ""}.`);
for (const [s, fs] of why) if (fs.length) console.log(`  ${s}: ${[...new Set(fs)].slice(0, 4).join(", ")}${fs.length > 4 ? ", …" : ""}`);
if (unmatched.length) console.log(`  no tests for: ${unmatched.slice(0, 6).join(", ")}${unmatched.length > 6 ? ", …" : ""}`);
if (!plan.length) { console.log("Nothing to run."); process.exit(0); }
console.log("Plan:"); plan.forEach(([name], i) => console.log(`  ${i + 1}. ${name}`));
if (dry) process.exit(0);

const results = [];
for (const [name, cmd, dir, env] of plan) {
    const t0 = Date.now();
    console.log(`\n▶ ${name}`);
    const r = spawnSync(cmd, { cwd: path.join(root, dir), shell: true, encoding: "utf8", env: { ...process.env, ...(env || {}) }, maxBuffer: 64 * 1024 * 1024 });
    const out = (r.stdout || "") + (r.stderr || "");
    // The lines that say how it went: failures, and the totals.
    const lines = out.split("\n").filter(l => /^(FAIL |not ok|✖|ℹ (pass|fail) )|all green|\d+ FAILED/.test(l.trim()));
    console.log(lines.slice(-12).join("\n") || out.split("\n").slice(-6).join("\n"));
    results.push([name, r.status === 0, Math.round((Date.now() - t0) / 1000)]);
    if (r.status !== 0 && /build/.test(name) && !/unit/.test(name)) break;
}
console.log("\nSummary:");
for (const [name, ok, s] of results) console.log(`  ${ok ? "ok  " : "FAIL"} ${name} (${s}s)`);
process.exit(results.every(r => r[1]) ? 0 : 1);
