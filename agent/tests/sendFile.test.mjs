// send_file: a picture made on the Mac, into the chat — and nothing else.
//
// Own process, like the other sandbox files: the SVG case runs the renderer
// inside the sandbox, and the manager holds one policy per process.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendFile, sniff, resolveInWorkspace, MAX_BYTES } from "../dist/sendFile.js";
import { Sandbox } from "../dist/sandbox.js";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "gep-sendfile-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gep-outside-"));
after(async () => {
    try { await SandboxManager.reset?.(); } catch { /* nothing to tear down */ }
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
});

// A real 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const SVG = `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#CC6B4E"/></svg>`;
const opts = { workspace: ws, sandbox: null };

describe("what can be sent", () => {
    test("a PNG goes as it is, and the model is told only that it was sent", async () => {
        fs.writeFileSync(path.join(ws, "chart.png"), PNG);
        const r = await sendFile({ path: "chart.png" }, opts);
        assert.equal(r.ok, true, r.content);
        assert.equal(r.image.mime, "image/png");
        assert.deepEqual(Buffer.from(r.image.b64, "base64"), PNG);
        assert.doesNotMatch(r.content, /base64|iVBOR/);
    });

    test("the paths a model writes all find the same file", async () => {
        for (const p of ["chart.png", "/workspace/chart.png", "~/Gepetel/workspace/chart.png", path.join(ws, "chart.png")]) {
            const r = await sendFile({ path: p }, opts);
            assert.equal(r.ok, true, `${p}: ${r.content}`);
        }
    });

    test("bytes, not names: a text file called .png is refused", async () => {
        fs.writeFileSync(path.join(ws, "fake.png"), "hello");
        const r = await sendFile({ path: "fake.png" }, opts);
        assert.equal(r.ok, false);
        assert.match(r.content, /not an image/);
    });

    test("over 5 MB is refused before it is read", async () => {
        const big = path.join(ws, "big.png");
        fs.writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(MAX_BYTES)]));
        const r = await sendFile({ path: "big.png" }, opts);
        assert.equal(r.ok, false);
        assert.match(r.content, /5 MB/);
    });

    test("an SVG with no renderer says to make a PNG, rather than sending text", async () => {
        fs.writeFileSync(path.join(ws, "plot.svg"), SVG);
        const r = await sendFile({ path: "plot.svg" }, opts);
        assert.equal(r.ok, false);
        assert.match(r.content, /PNG/);
    });
});

describe("what can never be sent", () => {
    test("a file outside the workspace", async () => {
        fs.writeFileSync(path.join(outside, "secret.png"), PNG);
        const r = await sendFile({ path: path.join(outside, "secret.png") }, opts);
        assert.equal(r.ok, false);
        assert.match(r.content, /working folder/);
    });

    test("climbing out with ..", async () => {
        const r = await sendFile({ path: `../${path.basename(outside)}/secret.png` }, opts);
        assert.equal(r.ok, false);
    });

    test("a symlink in the workspace that points out of it", async () => {
        fs.symlinkSync(path.join(outside, "secret.png"), path.join(ws, "innocent.png"));
        const r = await sendFile({ path: "innocent.png" }, opts);
        assert.equal(r.ok, false);
        assert.match(r.content, /working folder/);
    });

    test("a directory", async () => {
        fs.mkdirSync(path.join(ws, "dir.png"));
        const where = resolveInWorkspace(ws, "dir.png");
        assert.ok("why" in where);
    });
});

describe("the pieces", () => {
    test("sniff knows the four image types and SVG by their bytes", () => {
        assert.equal(sniff(PNG), "image/png");
        assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
        assert.equal(sniff(Buffer.from("GIF89a....")), "image/gif");
        assert.equal(sniff(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
        assert.equal(sniff(Buffer.from(SVG)), "svg");
        assert.equal(sniff(Buffer.from("<html><svg></svg></html>")), null);
        assert.equal(sniff(Buffer.from("%PDF-1.7")), null);
    });
});

// The real thing, when this machine has the app built: an SVG rendered by the
// app inside the sandbox comes back as a PNG.
const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = process.env.GEPETEL_RENDERER || path.join(here, "..", "..", "mac", ".build", "release", "Gepetel");
const canRender = process.platform === "darwin" && fs.existsSync(renderer);

describe("rendering an SVG", canRender ? {} : { skip: "needs macOS and the built app (mac/.build/release/Gepetel)" }, () => {
    test("it becomes a PNG, rendered inside the sandbox", async () => {
        fs.writeFileSync(path.join(ws, "plot.svg"), SVG);
        const box = new Sandbox({ workspace: ws, keepHours: 0 });
        const r = await sendFile({ path: "plot.svg" }, { workspace: ws, sandbox: box, renderer });
        assert.equal(r.ok, true, r.content);
        assert.equal(r.image.mime, "image/png");
        assert.equal(r.image.name, "plot.png");
        assert.equal(sniff(Buffer.from(r.image.b64, "base64").subarray(0, 16)), "image/png");
    });
});
