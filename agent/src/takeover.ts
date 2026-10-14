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
import type { OsInputReq, OsInputRes } from "./osInput.js";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpResult } from "./mcpClient.js";
import type { Bridge } from "./bridge.js";

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
            // 1100 px at quality 55: at 720/35 a sign-in form was too blurry
            // to read on a phone (said by the first person to use it). Fewer
            // frames per second inside the same byte budget; a still screen
            // costs nothing either way.
            ["-Z", "1100", "-s", "format", "jpeg", "-s", "formatOptions", "55", inp, "--out", out],
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
    /** Where the page's text fields are, in CSS pixels: the phone focuses its
     *  own text box during a tap that lands on one, which is the only way
     *  iOS will open the keyboard. Refreshed on start and after each input. */
    private fields: number[][] = [];
    sentBytes = 0;

    constructor(
        private call: (tool: string, args: Record<string, unknown>) => Promise<McpResult>,
        private sendFrame: (f: { b64: string; w: number; h: number; fields?: number[][] }) => void,
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
        if (this.liteTab !== null) return this.startTimer();
        // Bring the job's tab to the front: Chrome does not draw a background
        // tab, and screenshots of one stall. On a real Mac the first takeover
        // got 18 frames in three minutes — one every ten seconds.
        try {
            const r = await this.within(this.call("browser_tabs", { action: "list" }), 5000);
            const m = r.content.map(c => c.text || "").join("\n").match(/^- (\d+): \(current\)/m);
            if (m) await this.within(this.call("browser_tabs", { action: "select", index: Number(m[1]) }), 5000);
        } catch (e: any) { console.error(`takeover: couldn't bring the tab to the front: ${e?.message || e}`); }
        await this.measure();
        await this.refreshFields();
        this.last = "";
        // A full budget, on the same clock the refills are measured on: a
        // field initialised from Date.now() and refilled from this.now() went
        // negative under any other clock and never sent a frame.
        await this.startTimer();
    }

    private async startTimer(): Promise<void> {
        if (this.liteTab !== null) {
            console.log(`takeover: via the extension, tab ${this.liteTab}`);
            await this.refreshFields();
        }
        this.last = "";
        this.budget = BYTES_PER_SECOND;
        this.refilled = this.now();
        this.timer = setInterval(() => void this.tick(), FRAME_EVERY_MS);
        void this.tick();
    }

    /** The direct line to the extension (bridge.ts), and the tab to show
     *  through it — a page the debugger can't hold (a password manager is
     *  active in it). null: back to Playwright. */
    bridge: Bridge | null = null;
    /** Real input from macOS, by the app (osInput.ts): for a tab Chrome took
     *  from the debugger, where the extension's clicks aren't gestures. */
    osInput: ((req: OsInputReq) => Promise<OsInputRes>) | null = null;
    /** The window size the job set (phone or desktop): asked for again to
     *  read the window's and the page's size — the same size changes nothing. */
    viewSize = { width: 1280, height: 900 };
    private liteTab: number | null = null;
    useTab(tabId: number | null): void {
        if (this.liteTab === tabId) return;
        console.log(tabId === null ? "takeover: back to the browser connection" : `takeover: the page goes through the extension now (tab ${tabId})`);
        this.liteTab = tabId;
        this.css = null;
        this.nudge();
        if (this.timer) void this.refreshFields();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        // Put the tab back to its own size (the job carries on in it). The
        // override itself ends when the job's connection does.
        if (this.original) {
            const { w, h } = this.original;
            this.original = null;
            void this.input({ kind: "_restore", w, h }).catch(() => {});
        }
    }

    /** The tab's size before it was set to the phone's, to put back. */
    private original: { w: number; h: number } | null = null;

    /** Send the next frame even if it looks the same — after an input. */
    nudge(): void { this.last = ""; }

    private async refreshFields(): Promise<void> {
        if (this.liteTab !== null && this.bridge) {
            try { this.fields = (await this.within(this.bridge.fields(this.liteTab), 5000)).slice(0, 40); }
            catch (e: any) { console.log(`takeover (via extension): fields failed: ${e?.message || e}`); }
            return;
        }
        try {
            const r = await this.within(this.call("browser_snapshot", { boxes: true }), 5000);
            const text = r.content.map(c => c.text || "").join("\n");
            const out: number[][] = [];
            for (const m of text.matchAll(/- (?:textbox|searchbox|combobox|spinbutton)\b[^\n]*\[box=(-?[\d.]+),(-?[\d.]+),([\d.]+),([\d.]+)\]/g)) {
                out.push([+m[1], +m[2], +m[3], +m[4]].map(Math.round));
                if (out.length >= 40) break;
            }
            this.fields = out;
        } catch { /* keep the last known fields */ }
    }

    /** The tab's size in CSS pixels, which is what taps are given in. */
    private async measure(): Promise<void> {
        try {
            // The size the page is shown at — what the screenshot is of — not
            // its layout width: a page made for desktops, shown at a phone's
            // size, is laid out 980 wide, and taps scaled to that missed
            // (OLX's sign-in, on a real Mac).
            const r = await this.call("browser_run_code_unsafe", { code: "async (page) => { const v = page.viewportSize(); return v ? [v.width, v.height] : await page.evaluate(() => [innerWidth, innerHeight]); }" });
            const m = r.content.map(c => c.text || "").join("\n").match(/### Result\n\s*\[\s*(\d+),\s*(\d+)\s*\]/);
            if (m) this.css = { w: +m[1], h: +m[2] };
        } catch { /* fall back to the screenshot's own size below */ }
    }

    /** The tabs there were, by address, last time they were looked at. */
    private tabsSeen: number | null = null;
    private lastInput = 0;
    private ticks = 0;

    /** "Continue with Google" (or Apple, or Facebook) opens a window of its
     *  own; the person on the phone kept seeing the page they tapped, while
     *  the sign-in waited on the Mac. Once a second: a tab that wasn't there
     *  is the one to show; when it closes, Playwright goes back to another
     *  and so does the picture. */
    /** Tabs Chrome had already taken when this takeover started. */
    private takenSeen: Set<number> | null = null;

    /** A popup Chrome takes the moment it opens (a password manager active
     *  in Google's sign-in): Playwright never sees it; the extension does.
     *  Shown through the extension, after the person's tap. */
    private async followTakenTab(): Promise<boolean> {
        if (!this.bridge?.connected) return false;
        const taken = await this.within(this.bridge.takenAway(), 3000).catch(() => []);
        if (this.takenSeen === null) { this.takenSeen = new Set(taken.map(t => t.tabId)); return false; }
        const fresh = taken.filter(t => !this.takenSeen!.has(t.tabId) && t.tabId !== this.liteTab);
        for (const t of taken) this.takenSeen.add(t.tabId);
        if (!fresh.length || this.now() - this.lastInput > 10_000) return false;
        console.log(`takeover: a new tab opened that Chrome took (another extension active in it); showing it through the extension`);
        this.useTab(fresh[fresh.length - 1].tabId);
        return true;
    }

    private async followNewTab(): Promise<void> {
        const r = await this.within(this.call("browser_tabs", { action: "list" }), 3000);
        const tabs = [...r.content.map(c => c.text || "").join("\n").matchAll(/^- (\d+): (\(current\) )?\[/gm)].map(m => ({ index: +m[1], current: !!m[2] }));
        const before = this.tabsSeen;
        this.tabsSeen = tabs.length;
        if (before === null || tabs.length <= before) return;
        // Only right after the person tapped or typed: that's when a sign-in
        // popup opens. Tabs kept from earlier jobs also turn up a moment after
        // a job connects, and the picture jumped to one of those (a real run).
        if (this.now() - this.lastInput > 10_000) return;
        const newest = Math.max(...tabs.map(t => t.index));
        if (tabs.find(t => t.index === newest)?.current) return;
        await this.within(this.call("browser_tabs", { action: "select", index: newest }), 3000);
        console.log(`takeover: a new tab opened; showing it`);
        this.css = null;
        await this.measure();
        this.nudge();
        void this.refreshFields();
    }

    private async tick(): Promise<void> {
        if (this.busy || !this.timer) return;
        this.busy = true;
        try {
            if (this.liteTab !== null && this.bridge) {
                // Chrome's capture: at most 2 a second.
                if (this.ticks++ % 2 !== 0) return;
                if (this.ticks % 4 === 1) await this.followTakenTab().catch(() => false);
                const cap = await this.within(this.bridge.capture(this.liteTab), 5000);
                const raw = Buffer.from(cap.b64, "base64");
                const sum = crypto.createHash("sha1").update(raw).digest("hex");
                if (sum === this.last) return;
                const small = await this.compress(raw);
                const t = this.now();
                this.budget = Math.min(BYTES_PER_SECOND, this.budget + (t - this.refilled) * BYTES_PER_SECOND / 1000);
                this.refilled = t;
                if (small.length > this.budget) return;
                this.budget -= small.length;
                this.last = sum;
                this.css = { w: cap.w, h: cap.h };
                this.sendFrame({ b64: small.toString("base64"), w: cap.w, h: cap.h, fields: this.fields });
                this.sentFrames++;
                this.sentBytes += small.length;
                return;
            }
            if (this.ticks++ % 4 === 0) { if (!(await this.followTakenTab().catch(() => false))) await this.followNewTab().catch(() => {}); }
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
            this.sendFrame({ b64: small.toString("base64"), w: size.w, h: size.h, fields: this.fields });
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

    private realInputOff = "";
    /** A tap, text, a key, a scroll or a drag as macOS input, through the
     *  app. False when it can't (no app, no permission, a locked Mac, the
     *  window not found) — then the extension's way. */
    private async realInput(tabId: number, m: any): Promise<boolean> {
        if (!this.osInput || !this.bridge || this.realInputOff) return false;
        const kind = String(m?.kind || "");
        if (!["tap", "text", "key", "scroll", "drag"].includes(kind)) return false;
        let size: { window: number[]; page: number[] | null };
        try { size = await this.within(this.bridge.window(tabId, this.viewSize.width, this.viewSize.height), 5000); }
        catch (e: any) { console.log(`takeover: real input — no window size (${e?.message || e})`); return false; }
        if (!size.page) return false;
        const base = { winW: size.window[0], winH: size.window[1], innerW: size.page[0], innerH: size.page[1] };
        const req: OsInputReq = kind === "tap" ? { op: "tap", ...base, x: Number(m.x), y: Number(m.y) }
            : kind === "text" ? { op: "text", ...base, text: String(m.text ?? "").slice(0, 2000) }
            : kind === "key" ? { op: "key", ...base, key: String(m.key ?? "") }
            : kind === "scroll" ? { op: "scroll", ...base, dy: Number(m.dy) || 0 }
            : { op: "drag", ...base, points: Array.isArray(m.points) ? m.points.slice(0, 200) : [] };
        const r = await this.osInput(req);
        console.log(`takeover (real input): ${kind}${kind === "tap" ? ` ${Math.round(Number(m.x))},${Math.round(Number(m.y))}` : ""} → ${r.ok ? "done" : `no: ${r.why}`}`);
        // Not allowed or the Mac locked: it won't change mid-takeover.
        if (!r.ok && /allowed|lock screen|isn't running/.test(r.why)) this.realInputOff = r.why;
        return r.ok;
    }

    /** Inputs run one at a time, in arrival order: typed text comes in
     *  bursts, and two of them racing would land scrambled. */
    private queue: Promise<void> = Promise.resolve();
    input(m: any): Promise<void> {
        if (m?.kind === "tap" || m?.kind === "text" || m?.kind === "key") this.lastInput = this.now();
        const next = this.queue.then(() => this.apply(m));
        this.queue = next.catch(() => {});
        return next;
    }

    /** One input from the person. Shapes were checked by the relay and are
     *  checked again here; text reaches the page as data, never as code. */
    private async apply(m: any): Promise<void> {
        console.log(`takeover: input ${String(m?.kind)}`);
        if (this.liteTab !== null && this.bridge) {
            // The page's own size, no emulation: nothing to resize.
            if (m?.kind === "viewport" || m?.kind === "_restore") return;
            // Real input first: a person's tap opens what a script's can't
            // (Google's sign-in window). The extension's way when it can't.
            if (await this.realInput(this.liteTab, m)) { this.nudge(); void this.refreshFields().then(() => this.nudge()); return; }
            const what = await this.within(this.bridge.input(this.liteTab, m), 8000).catch((e: any) => `failed: ${e?.message || e}`);
            console.log(`takeover (via extension): ${m?.kind}${m?.kind === "tap" ? ` ${m.x},${m.y}` : ""} → ${what}`);
            this.nudge();
            void this.refreshFields().then(() => this.nudge());
            return;
        }
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
            case "back": {
                // Not past the site's first page: back from it is the blank
                // page the tab began as, and the job then took its tab for
                // lost. Gone there: forward again.
                const r = await this.call("browser_navigate_back", {});
                const at = r.content.map(c => c.text || "").join("\n").match(/- Page URL: (.+)/)?.[1] ?? "";
                if (/^(about:|chrome-extension:|chrome:)/.test(at)) {
                    await this.call("browser_run_code_unsafe", { code: "async (page) => { await page.goForward().catch(() => null); return true; }" }).catch(() => null);
                    console.log("takeover: back — nothing before this page; stayed");
                }
                break;
            }
            case "drag": {
                // A slider check needs a real mouse: pressed, moved along the
                // person's own path at their pace, let go — numbers only, as data.
                const pts = Array.isArray(m.points) ? m.points.slice(0, 200).map((q: any) => [n(q?.[0], 0, 10000), n(q?.[1], 0, 10000), n(q?.[2], 0, 15000)]) : [];
                if (pts.length < 2 || pts.some((q: (number | null)[]) => q.includes(null))) break;
                const [x0, y0] = pts[0], [x1, y1, t1] = pts[pts.length - 1];
                const r = await this.call("browser_run_code_unsafe", { code: `async (page) => { const pts = ${JSON.stringify(pts)}; await page.mouse.move(pts[0][0], pts[0][1]); await page.mouse.down(); let last = 0; for (const [x, y, t] of pts.slice(1)) { await page.waitForTimeout(Math.min(200, Math.max(0, t - last))); last = t; await page.mouse.move(x, y, { steps: 2 }); } await page.mouse.up(); return true; }` });
                console.log(`takeover: drag ${x0},${y0} → ${x1},${y1} in ${t1} ms, ${pts.length} points${r.isError ? " — FAILED " + r.content.map(c => c.text).join(" ").slice(0, 120) : ""}`);
                break;
            }
            case "viewport":
                // Phone or desktop is Gepetel's window size now (the job sets
                // it); the page isn't resized for the phone any more — that
                // emulation was dropped whenever Chrome took the tab, and the
                // page flipped between phone and desktop.
                return;
            case "_restore": {
                const w = n(m.w, 200, 4000), h = n(m.h, 200, 4000);
                if (w !== null && h !== null) {
                    await this.call("browser_run_code_unsafe", { code: `async (page) => { await page.setViewportSize({ width: ${w}, height: ${h} }); return true; }` });
                    this.css = { w, h };
                }
                return;
            }
        }
        this.nudge();
        // The page may have changed under the tap: where are its fields now?
        void this.refreshFields().then(() => this.nudge());
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
