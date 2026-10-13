// A direct line from the agent to Gepetel's Chrome extension, for the one
// thing Playwright's connection can't do: keep working on a page another
// extension is active on.
//
// Everything else goes through Playwright, which drives Chrome through the
// extension's debugger. Chrome lets no extension debug a page holding another
// extension's frame — a password manager's suggestion menu on a sign-in page
// (iCloud Passwords, on the owner's Mac, 2026-10-12) — so on exactly the page
// the person must take over, the debugger was taken away, again each time
// they tapped a field, and the phone takeover flickered and stopped. This
// line needs no debugger: the extension screenshots the tab with Chrome's
// plain capture and delivers taps and typing with a page script.
//
// Local only (127.0.0.1, a random port), one job's life long. The extension
// learns the port from its connect page (bin/open-chrome adds it), and both
// sides prove they hold the key the person approved before anything else:
// each answers the other's random challenge with an HMAC of it.
import crypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

export type TabInfo = { tabId: number; url: string };
export type Capture = { b64: string; w: number; h: number };

const hmac = (key: string, msg: string) => crypto.createHmac("sha256", key).update(msg).digest("hex");

export class Bridge {
    private wss: WebSocketServer | null = null;
    private sock: WebSocket | null = null;
    private seq = 0;
    private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    port = 0;

    constructor(private key: string, private log?: (l: string) => void) {}

    get connected(): boolean { return !!this.sock; }

    async start(): Promise<number> {
        this.wss = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 8 * 1024 * 1024 });
        await new Promise<void>((resolve, reject) => { this.wss!.once("listening", () => resolve()); this.wss!.once("error", reject); });
        this.port = (this.wss.address() as { port: number }).port;
        this.wss.on("connection", ws => this.greet(ws));
        return this.port;
    }

    private greet(ws: WebSocket): void {
        const challenge = crypto.randomBytes(16).toString("hex");
        let proven = false;
        const deadline = setTimeout(() => { if (!proven) ws.close(); }, 5000);
        ws.send(JSON.stringify({ t: "hello", challenge }));
        ws.on("message", raw => {
            let msg: any;
            try { msg = JSON.parse(String(raw)); } catch { return; }
            if (!proven) {
                // Theirs first: an HMAC of our challenge, then ours of theirs.
                const expect = hmac(this.key, "extension:" + challenge);
                if (msg?.t !== "auth" || typeof msg.mac !== "string" || msg.mac.length !== expect.length
                    || !crypto.timingSafeEqual(Buffer.from(msg.mac), Buffer.from(expect)) || typeof msg.challenge !== "string") {
                    this.log?.("bridge: a connection without the key, closed");
                    ws.close();
                    return;
                }
                proven = true;
                clearTimeout(deadline);
                ws.send(JSON.stringify({ t: "ok", mac: hmac(this.key, "agent:" + msg.challenge) }));
                this.sock?.close();
                this.sock = ws;
                this.log?.("bridge: the extension is connected");
                ws.on("close", () => { if (this.sock === ws) { this.sock = null; this.log?.("bridge: the extension went"); } });
                return;
            }
            // The extension's own log, into ours.
            if (msg?.t === "log") { this.log?.(`[chrome] ${String(msg.line ?? "").slice(0, 400)}`); return; }
            const w = typeof msg?.id === "number" ? this.waiting.get(msg.id) : undefined;
            if (!w) return;
            clearTimeout(w.timer);
            this.waiting.delete(msg.id);
            if (msg.error) w.reject(new Error(String(msg.error))); else w.resolve(msg.result);
        });
    }

    /** Wait up to `ms` for the extension to connect. */
    async ready(ms = 5000): Promise<boolean> {
        const t0 = Date.now();
        while (!this.sock && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 100));
        return !!this.sock;
    }

    private request(method: string, params: Record<string, unknown> = {}, ms = 10_000): Promise<any> {
        const s = this.sock;
        if (!s) return Promise.reject(new Error("the extension isn't connected"));
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`the extension did not answer ${method} in ${ms / 1000}s`)); }, ms);
            this.waiting.set(id, { resolve, reject, timer });
            s.send(JSON.stringify({ id, method, params }));
        });
    }

    /** Tabs Chrome took from the debugger and are still open. */
    takenAway(): Promise<TabInfo[]> { return this.request("takenAway"); }
    /** Stop guarding and re-attaching a tab: the person is driving it. */
    release(tabId: number): Promise<void> { return this.request("release", { tabId }); }
    /** Guard and attach it again: the person is done. */
    reattach(tabId: number): Promise<void> { return this.request("reattach", { tabId }); }
    /** The tab as a JPEG, and its size in CSS pixels. */
    capture(tabId: number): Promise<Capture> { return this.request("capture", { tabId }); }
    /** Where its text fields are, in CSS pixels. */
    fields(tabId: number): Promise<number[][]> { return this.request("fields", { tabId }); }
    /** A tap, text, a key, a scroll or "back", as the takeover viewer sends them. */
    input(tabId: number, m: Record<string, unknown>): Promise<void> { return this.request("input", { tabId, m }); }

    close(): void {
        for (const [, w] of this.waiting) { clearTimeout(w.timer); w.reject(new Error("the bridge closed")); }
        this.waiting.clear();
        try { this.sock?.close(); } catch { /* gone */ }
        try { this.wss?.close(); } catch { /* gone */ }
        this.sock = null;
        this.wss = null;
    }
}
