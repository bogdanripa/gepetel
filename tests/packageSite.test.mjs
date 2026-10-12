// The gate that decides what reaches the public site.
//
// scripts/package-site.sh is the only thing standing between `website/` and
// https://gepetel.com, and a gate nobody tests is a gate that passes
// everything. So each rule gets a fixture that would have been published before
// it existed — the first of them is the actual incident: `website/.env.example`
// answering 200 on the live site.
//
// It asserts the exit code AND the bundle's contents, because "the build failed"
// and "the build failed for the reason I think" are different claims, and only
// the second one keeps working after someone edits the script.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve("scripts/package-site.sh");

/** Run the packager over a fixture tree. Never throws: the exit code is the
 *  thing under test, so it is returned rather than raised. */
function pack(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-"));
    for (const [rel, body] of Object.entries(files)) {
        const f = path.join(dir, rel);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, body);
    }
    const zip = path.join(dir, "out", "site.zip");
    let code = 0, out = "";
    try {
        out = execFileSync("bash", [SCRIPT, dir, zip], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
        code = e.status ?? 1;
        out = String(e.stdout || "") + String(e.stderr || "");
    }
    const entries = fs.existsSync(zip)
        ? execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean)
        : null;
    return { code, out, entries, dir };
}

const PAGE = "<!doctype html><title>site</title>";

describe("package-site.sh", () => {
    test("publishes the site's assets and nothing else", () => {
        const r = pack({
            "index.html": PAGE,
            "privacy.html": PAGE,
            "assets/logo.png": "\x89PNG fake",
            "assets/app.css": "body{}",
            // Real repo plumbing that used to be swept in by the old denylist.
            "README.md": "# docs",
            "package.json": "{}",
            "vercel.json": "{}",
            // A server-side handler living in the site directory — the Vercel-era
            // `website/api/extend.js`. Publishing it would serve its source, which
            // is why .js is off the allowlist entirely.
            "api/extend.js": "module.exports = {}",
            "bundle.js.map": "{\"sources\":[\"../src/app.ts\"]}",
        });
        assert.equal(r.code, 0, r.out);
        assert.deepEqual([...r.entries].sort(),
            ["assets/app.css", "assets/logo.png", "index.html", "privacy.html"]);
        // A dropped file has to be visible, or an allowlist is just a silent
        // denylist with the failure moved to whoever reports the broken page.
        assert.match(r.out, /left out — not a site asset/);
        assert.match(r.out, /README\.md/);
    });

    test("nested directories keep their paths", () => {
        // The trap this guards: an unquoted '*.css' glob is expanded by the
        // shell before zip sees it, and then matches only the top directory.
        const r = pack({ "index.html": PAGE, "a/b/c/deep.css": "body{}" });
        assert.equal(r.code, 0, r.out);
        assert.ok(r.entries.includes("a/b/c/deep.css"), r.entries.join());
    });

    test("a credential-shaped NAME fails the build, published or not", () => {
        // .env.example is not on the allowlist, so it would never have been
        // served — but it has no business in the directory that gets zipped,
        // and the next one may not be an example.
        for (const name of [".env.example", ".env", "deploy.key", "server.pem",
                            "secrets.txt", "db-password.txt", "dump.sql"]) {
            const r = pack({ "index.html": PAGE, [name]: "whatever" });
            assert.equal(r.code, 1, `${name} was allowed to stay: ${r.out}`);
            assert.match(r.out, /reads like a credential/);
            assert.equal(r.entries, null, `${name}: a bundle was still written`);
        }
    });

    test("a secret inside a file that WOULD be published fails the build", () => {
        const cases = {
            "cfg.html": '<script>const c = { PAYMENT_SECRET: "s3cr3t-value" };</script>',
            "x.html": "<!-- OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123 -->",
            "t.html": '<script>const t="eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"</script>',
            "robots.txt": "mongodb+srv://user:pass123@cluster.mongodb.net/db",
            "k.svg": "<svg><desc>AKIAIOSFODNN7EXAMPLE</desc></svg>",
            "p.txt": "-----BEGIN RSA PRIVATE KEY-----\nMIIE...",
            "s.css": "/* xoxb-1234567890-abcdefghij */",
        };
        for (const [name, body] of Object.entries(cases)) {
            const r = pack({ "index.html": PAGE, [name]: body });
            assert.equal(r.code, 1, `${name} published a secret: ${r.out}`);
            assert.match(r.out, /contains what looks like/);
            assert.equal(r.entries, null, `${name}: a bundle was still written`);
        }
    });

    test("the scan does not fire on the site as it stands", () => {
        // The counterweight to the case above: a gate that fails on the real
        // site is a gate that gets bypassed. This runs against the actual
        // website/ directory, so a page that picks up a credential-shaped
        // string later fails here rather than on the live site.
        const zip = path.join(os.tmpdir(), `site-real-${process.pid}.zip`);
        const out = execFileSync("bash", [SCRIPT, "website", zip], { encoding: "utf8" });
        assert.match(out, /^ok — \d+ site asset/m, out);
        const entries = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" })
            .split("\n").filter(Boolean);
        assert.ok(entries.includes("index.html"), entries.join());
        assert.ok(entries.every(e => !/\.(md|json|env.*)$/i.test(e)), entries.join());
        fs.rmSync(zip, { force: true });
    });

    test("a bundle whose homepage is not at the root is refused", () => {
        // It unpacks happily and then 404s, from a deploy that looked fine.
        const r = pack({ "sub/index.html": PAGE });
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /index\.html is not at the root/);
    });

    test("an empty bundle is a failure, not an empty site", () => {
        const r = pack({ "README.md": "# just docs" });
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /nothing matched the allowlist/);
    });
});
