// The Mac's half of the live takeover link (Phase 6).
//
// While a job is handed over, the person can drive the tab from their phone:
// we send what the tab looks like, they send taps and text. No model is in
// this loop — it is the person's own hands on their own browser.
//
// Measured on this machine before it was written (headless Chrome, Playwright
// MCP 0.0.83): `browser_take_screenshot` answers in ~30 ms, but its JPEG is
// ~290 KB; `browser_run_code_unsafe` costs ~500 ms per call whatever it does,
// and a CDP screencast cannot be kept alive across those calls. So frames are
// screenshots, polled, sent ONLY when the screen changed, shrunk by macOS's
// own `sips` (720 px wide, quality 35: ~64 KB for a page of dense text, in
// ~15 ms), and held under a byte budget per second. Taps use the coordinate
// click (lands exactly; ~1 s), text a single fixed script with the text as
// JSON data — never as code.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpResult } from "./mcpClient.js";

export const FRAME_EVERY_MS = 250;
/** The spec's ceiling for the link: ≤ 150 KB/s. */
export const BYTES_PER_SECOND = 150 * 1024;
export const KEYS = ["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

/** Shrink a JPEG with macOS's sips; elsewhere (Linux CI) send it as it is. */
export async function shrink(jpeg: Buffer): Promise<Buffer> {
    if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sips")) return jpeg;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gep-frame-"));
    try {
        const inp = path.join(dir, "in.jpg"), out = path.join(dir, "out.jpg");
        fs.writeFileSync(inp, jpeg);
        await new Promise<void>((resolve, reject) => execFile("/usr/bin/sips",
            ["-Z", "720", "-s", "format", "jpeg", "-s", "formatOptions", "35", inp, "--out", out],
            { timeout: 5000 }, e => e ? reject(e) : resolve()));
        return fs.readFileSync(out);
    } catch {
        return jpeg;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

export class Takeover {
    private timer: NodeJS.Timeout | null = null;
    private busy = false;
    private last = "";
    private css: { w: number; h: number } | null = null;
    /** Byte budget: refilled each second, spent on frames. */
    private budget = BYTES_PER_SECOND;
    private refilled = 0;
    sentFrames = 0;
    sentBytes = 0;

    constructor(
        private call: (tool: string, args: Record<string, unknown>) => Promise<McpResult>,
        private sendFrame: (f: { b64: string; w: number; h: number }) => void,
        private compress: (jpeg: Buffer) => Promise<Buffer> = shrink,
        private now: () => number = Date.now,
    ) {}

    get running(): boolean { return !!this.timer; }

    private failures = 0;

    /** A call that gives up after `ms` instead of freezing the stream. */
    private within<T>(p: Promise<T>, ms: number): Promise<T> {
        return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`no answer in ${ms} ms`)), ms))]);
    }

    async start(): Promise<void> {
        if (this.timer) return;
        // Bring the job's tab to the front: Chrome does not draw a background
        // tab, and screenshots of one stall. On a real Mac the first takeover
        // got 18 frames in three minutes — one every ten seconds.
        try {
            const r = await this.within(this.call("browser_tabs", { action: "list" }), 5000);
            const m = r.content.map(c => c.text || "").join("\n").match(/^- (\d+): \(current\)/m);
            if (m) await this.within(this.call("browser_tabs", { action: "select", index: Number(m[1]) }), 5000);
        } catch (e: any) { console.error(`takeover: couldn't bring the tab to the front: ${e?.message || e}`); }
        // The tab's size in CSS pixels, which is what taps are given in.
        try {
            const r = await this.call("browser_run_code_unsafe", { code: "async (page) => await page.evaluate(() => [innerWidth, innerHeight])" });
            const m = r.content.map(c => c.text || "").join("\n").match(/### Result\n\s*\[\s*(\d+),\s*(\d+)\s*\]/);
            if (m) this.css = { w: +m[1], h: +m[2] };
        } catch { /* fall back to the screenshot's own size below */ }
        this.last = "";
        // A full budget, on the same clock the refills are measured on: a
        // field initialised from Date.now() and refilled from this.now() went
        // negative under any other clock and never sent a frame.
        this.budget = BYTES_PER_SECOND;
        this.refilled = this.now();
        this.timer = setInterval(() => void this.tick(), FRAME_EVERY_MS);
        void this.tick();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /** Send the next frame even if it looks the same — after an input. */
    nudge(): void { this.last = ""; }

    private async tick(): Promise<void> {
        if (this.busy || !this.timer) return;
        this.busy = true;
        try {
            const r = await this.within(this.call("browser_take_screenshot", { type: "jpeg" }), 5000);
            const img = r.content.find(c => c.type === "image" && c.data);
            if (!img) return;
            const sum = crypto.createHash("sha1").update(img.data!).digest("hex");
            if (sum === this.last) return;   // nothing changed: nothing sent
            const small = await this.compress(Buffer.from(img.data!, "base64"));
            const t = this.now();
            this.budget = Math.min(BYTES_PER_SECOND, this.budget + (t - this.refilled) * BYTES_PER_SECOND / 1000);
            this.refilled = t;
            if (small.length > this.budget) return;   // over budget: try again next tick
            this.budget -= small.length;
            this.last = sum;
            const size = this.css ?? jpegSize(small) ?? { w: 1280, h: 720 };
            this.sendFrame({ b64: small.toString("base64"), w: size.w, h: size.h });
            this.sentFrames++;
            this.sentBytes += small.length;
        } catch (e: any) {
            // Logged, not swallowed: the first takeover on a real Mac failed
            // and left nothing in either log to say why.
            this.failures++;
            if (this.failures === 1 || this.failures % 20 === 0) console.error(`takeover: frame failed (${this.failures}): ${e?.message || e}`);
        } finally {
            this.busy = false;
        }
    }

    /** One input from the person. Shapes were checked by the relay and are
     *  checked again here; text reaches the page as data, never as code. */
    async input(m: any): Promise<void> {
        console.log(`takeover: input ${String(m?.kind)}`);
        const n = (v: unknown, lo: number, hi: number) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? Math.round(x) : null; };
        switch (m?.kind) {
            case "tap": {
                const x = n(m.x, 0, 10000), y = n(m.y, 0, 10000);
                if (x !== null && y !== null) await this.call("browser_mouse_click_xy", { x, y });
                break;
            }
            case "text": {
                const t = String(m.text ?? "").slice(0, 500);
                if (t) await this.call("browser_run_code_unsafe", { code: `async (page) => { await page.keyboard.insertText(${JSON.stringify(t)}); return true; }` });
                break;
            }
            case "key":
                if (KEYS.includes(String(m.key))) await this.call("browser_press_key", { key: String(m.key) });
                break;
            case "scroll": {
                const dy = n(m.dy, -3000, 3000);
                if (dy !== null) await this.call("browser_mouse_wheel", { deltaX: 0, deltaY: dy });
                break;
            }
            case "back":
                await this.call("browser_navigate_back", {});
                break;
        }
        this.nudge();
    }
}

/** Width and height from a JPEG's SOF marker, without an image library. */
export function jpegSize(b: Buffer): { w: number; h: number } | null {
    let i = 2;
    while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        }
        i += 2 + len;
    }
    return null;
}
