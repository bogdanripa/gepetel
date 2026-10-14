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

/** What the phone is told when a passkey window was cancelled. */
export const PASSKEY_NOTE = "Your Mac asked for a passkey (Touch ID needs a finger on the Mac), so I cancelled it. Pick another way to sign in.";

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
        private sendFrame: (f: { b64: string; w: number; h: number; fields?: number[][]; note?: string }) => void,
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
    /** The tabs shown before this one, through the extension: a window
     *  opened from one goes back to it when it closes. */
    private liteBack: number[] = [];
    private async backFromClosed(): Promise<void> {
        if (!this.bridge || this.liteTab === null) return;
        const gone = this.liteTab;
        const open = new Set((await this.within(this.bridge.tabs(), 3000)).map(t => t.tabId));
        if (open.has(gone) || this.liteTab !== gone) return;
        let back: number | null = null;
        while (this.liteBack.length) { const t = this.liteBack.pop()!; if (open.has(t)) { back = t; break; } }
        console.log(`takeover: tab ${gone} closed; back to ${back === null ? "the job's tab" : `tab ${back}`}`);
        this.last = "";
        this.useTab(back, false);
    }

    useTab(tabId: number | null, remember = true): void {
        if (this.liteTab === tabId) return;
        if (remember && this.liteTab !== null && tabId !== null) this.liteBack.push(this.liteTab);
        if (tabId === null) this.liteBack = [];
        console.log(tabId === null ? "takeover: back to the browser connection" : `takeover: the page goes through the extension now (tab ${tabId})`);
        this.liteTab = tabId;
        this.css = null;
        // Gepetel's tabs as they are now: a tab opened from here on is new.
        this.liteTabsSeen = null;
        if (tabId !== null && this.bridge) void this.bridge.tabs().then(ts => { this.liteTabsSeen ??= new Set(ts.map(t => t.tabId)); }).catch(() => {});
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
            try {
                this.fields = (await this.within(this.bridge.fields(this.liteTab), 5000)).slice(0, 40);
                // For the phone's keyboard: it opens on a tap inside one of these.
                const key = JSON.stringify(this.fields.slice(0, 3));
                if (key !== this.fieldsSeen) { this.fieldsSeen = key; console.log(`takeover (via extension): ${this.fields.length} text field(s)${this.fields.length ? `, first at ${this.fields[0].join(",")}` : ""}`); }
            }
            catch (e: any) { console.log(`takeover (via extension): fields failed: ${e?.message || e}`); }
            return;
        }
        try {
            const r = await this.within(this.call("browser_snapshot", { boxes: true }), 5000);
            const text = r.content.map(c => c.text || "").join("\n");
            const out: number[][] = [];
            // A line may come single-quoted (its text has a colon in it).
            for (const m of text.matchAll(/- '?(?:textbox|searchbox|combobox|spinbutton)\b[^\n]*\[box=(-?[\d.]+),(-?[\d.]+),([\d.]+),([\d.]+)\]/g)) {
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

    /** Gepetel's tabs when the takeover went through the extension. */
    private liteTabsSeen: Set<number> | null = null;
    private liteDebug = "";
    /** Through the extension, a tab the person's tap opened — Google's
     *  "Choose an account" window from booking.com's sign-in (2026-10-14) —
     *  is shown next: through Playwright when it can see it, else through the
     *  extension too. Only right after their input, as for Playwright's. */
    private async followLiteNewTab(): Promise<void> {
        if (!this.bridge || this.liteTab === null) return;
        // Playwright's list first: a popup in a window of its own (Google's)
        // is attached and listed there, though not in the extension's list
        // of Gepetel's tabs (the real run: the tab opened, nothing followed).
        const before = this.tabsSeen;
        await this.followNewTab().catch(() => {});
        if (before !== null && this.tabsSeen !== null && this.tabsSeen > before && this.now() - this.lastInput <= 10_000) {
            console.log("takeover: back to the browser connection for the tab that opened");
            this.useTab(null);
            return;
        }
        const tabs = await this.within(this.bridge.tabs(), 3000);
        const ids = new Set(tabs.map(t => t.tabId));
        const seenKey = `${before}/${this.tabsSeen} pw; ext ${[...ids].join(",")}`;
        if (seenKey !== this.liteDebug) { this.liteDebug = seenKey; console.log(`takeover: tabs — ${seenKey}; ${Math.round((this.now() - this.lastInput) / 1000)} s since input`); }
        if (this.liteTabsSeen === null) { this.liteTabsSeen = ids; return; }
        const fresh = tabs.filter(t => !this.liteTabsSeen!.has(t.tabId) && /^https?:/.test(t.url));
        // A window that hasn't loaded its page yet (about:blank for the first
        // moment — Google's, on the real run) isn't seen yet: next time it is new.
        this.liteTabsSeen = new Set(tabs.filter(t => this.liteTabsSeen!.has(t.tabId) || /^https?:/.test(t.url)).map(t => t.tabId));
        if (!fresh.length || this.now() - this.lastInput > 10_000) return;
        const t = fresh[fresh.length - 1];
        const listed = await this.within(this.call("browser_tabs", { action: "list" }), 3000).catch(() => null);
        const match = listed ? [...listed.content.map(c => c.text || "").join("\n").matchAll(/^- (\d+): (?:\(current\) )?\[[^\]]*\]\(([^)]*)\)/gm)].find(m => m[2] === t.url) : undefined;
        if (match) {
            await this.within(this.call("browser_tabs", { action: "select", index: Number(match[1]) }), 3000);
            console.log(`takeover: a new tab opened (${new URL(t.url).host}); showing it through Playwright`);
            this.useTab(null);
        } else {
            console.log(`takeover: a new tab opened (${new URL(t.url).host}); showing it through the extension`);
            this.useTab(t.tabId);
        }
        this.css = null; this.litePage = null;
        this.nudge();
        void this.refreshFields();
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

    /** A line for the phone, sent with the frames for a while. */
    private note: { text: string; until: number } | null = null;
    private noteNow(): { note?: string } { return this.note && this.now() < this.note.until ? { note: this.note.text } : {}; }
    private passkeyAt = 0;
    /** Chrome's passkey windows ("Use a saved passkey for google.com", then
     *  Touch ID) are outside the page: the phone never sees them, and Touch
     *  ID needs a finger on the Mac — the owner was stuck on one (2026-10-14).
     *  The app cancels them; the phone is told, and the page offers another way. */
    private passkeyAsking = false;
    private async passkeyCheck(): Promise<void> {
        if (!this.osInput || this.realInputOff || this.passkeyAsking || this.now() - this.passkeyAt < 2000) return;
        this.passkeyAt = this.now();
        this.passkeyAsking = true;
        const r = await this.osInput({ op: "passkey" }).finally(() => { this.passkeyAsking = false; });
        if (!r.ok || !r.found) return;
        console.log(`takeover: cancelled Chrome's passkey window ("${r.found}") — it needs Touch ID on the Mac`);
        this.note = { text: PASSKEY_NOTE, until: this.now() + 15_000 };
        this.last = "";   // the next picture goes out, with the note
        this.nudge();
    }

    private async tick(): Promise<void> {
        if (this.busy || !this.timer) return;
        this.busy = true;
        try {
            // Alongside, never in the way of the pictures.
            void this.passkeyCheck().catch(() => {});
            if (this.liteTab !== null && this.bridge) {
                // Chrome's capture: at most 2 a second.
                if (this.ticks++ % 2 !== 0) return;
                if (this.ticks % 4 === 1) { if (!(await this.followTakenTab().catch(() => false))) await this.followLiteNewTab().catch(() => {}); }
                if (this.liteTab === null) return;
                const cap = await this.within(this.bridge.capture(this.liteTab), 5000);
                // Kept for real input: the page's size without another picture
                // (Chrome allows two a second, and the frames use them).
                this.litePage = { tab: this.liteTab, w: cap.w, h: cap.h };
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
                this.sendFrame({ b64: small.toString("base64"), w: cap.w, h: cap.h, fields: this.fields, ...this.noteNow() });
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
            this.sendFrame({ b64: small.toString("base64"), w: size.w, h: size.h, fields: this.fields, ...this.noteNow() });
            this.sentFrames++;
            this.sentBytes += small.length;
        } catch (e: any) {
            // Logged, not swallowed: the first takeover on a real Mac failed
            // and left nothing in either log to say why.
            this.failures++;
            if (this.failures === 1 || this.failures % 20 === 0) console.error(`takeover: frame failed (${this.failures}): ${e?.message || e}`);
            // The tab shown is gone — Google's sign-in window closes itself
            // once the person is in: back to the tab it came from (the owner's
            // phone went blank after signing in, 2026-10-14).
            if (this.liteTab !== null && /no tab with id/i.test(String(e?.message || e))) void this.backFromClosed().catch(() => {});
        } finally {
            this.busy = false;
        }
    }

    private realInputOff = "";
    private fieldsSeen = "";
    /** The last picture's page size, for the tab the frames come from. */
    private litePage: { tab: number; w: number; h: number } | null = null;
    /** A tap, text, a key, a scroll or a drag as macOS input, through the
     *  app. False when it can't (no app, no permission, a locked Mac, the
     *  window not found) — then the extension's way. */
    private async realInput(tabId: number, m: any): Promise<boolean> {
        if (!this.osInput || !this.bridge || this.realInputOff) return false;
        const kind = String(m?.kind || "");
        if (!["tap", "text", "key", "scroll", "drag"].includes(kind)) return false;
        // The page's size, from a picture of it — never by setting the
        // window (that refuses a window shared with the person's tabs, and
        // every tap fell back to the extension's way: the owner's sign-in,
        // 2026-10-14). The app finds the window by Gepetel's tab group.
        let page: { w: number; h: number };
        if (this.litePage?.tab === tabId) page = { w: this.litePage.w, h: this.litePage.h };
        else {
            try { const c = await this.within(this.bridge.capture(tabId), 5000); page = { w: c.w, h: c.h }; this.litePage = { tab: tabId, ...page }; }
            catch (e: any) { console.log(`takeover: real input — the page's size isn't known (${e?.message || e})`); return false; }
        }
        if (!(page.w > 0 && page.h > 0)) return false;
        // Its address: the app brings this tab to the front by it, and won't
        // click if it can't.
        const url = (await this.within(this.bridge.tabs(), 5000).catch(() => [] as { tabId: number; url: string }[])).find(t => t.tabId === tabId)?.url;
        if (!url) { console.log("takeover: real input — the tab's address isn't known"); return false; }
        const base = { winW: 0, winH: 0, innerW: page.w, innerH: page.h, url };
        const req: OsInputReq = kind === "tap" ? { op: "tap", ...base, x: Number(m.x), y: Number(m.y) }
            : kind === "text" ? { op: "text", ...base, text: String(m.text ?? "").slice(0, 2000) }
            : kind === "key" ? { op: "key", ...base, key: String(m.key ?? "") }
            : kind === "scroll" ? { op: "scroll", ...base, dy: Number(m.dy) || 0 }
            : { op: "drag", ...base, points: Array.isArray(m.points) ? m.points.slice(0, 200) : [] };
        const r = await this.osInput(req);
        console.log(`takeover (real input): ${kind}${kind === "tap" ? ` ${Math.round(Number(m.x))},${Math.round(Number(m.y))}` : ""} → ${r.ok ? "done" : `no: ${r.why}`}${r.geo ? ` (${r.geo})` : ""}`);
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
