// The live takeover link: the person drives their own Chrome tab from their
// phone for a moment — a captcha, a 2FA prompt — then taps Done and the job
// carries on.
//
// Shape: the agent hands over (Phase 5) and marks the question `takeover`;
// we mint https://gepetel.com/t/<token>, one-time and fifteen minutes long,
// bound to that job and that chat, and add it to the message. Opening it
// serves a small page that holds a WebSocket here; we bridge it to the Mac:
// frames up (JPEG, only when the screen changes, under a bandwidth budget set
// by the agent), taps and text down. Done burns the token and the job resumes.
//
// What makes it safe to put a remote control for someone's logged-in browser
// behind a URL:
//  - the token is 32 random bytes, stored as a hash, compared in constant time;
//  - it works for one job on one device, and dies on Done, when the job ends,
//    or after fifteen minutes, whichever comes first;
//  - one viewer at a time — a second open while the first is live is refused;
//  - inputs are checked for shape here (numbers in range, short text, a fixed
//    list of keys) before anything reaches the Mac; they are never code;
//  - the page is fully inline, no third-party anything, no referrer, no cache.
import type { Express, Request, Response } from "express";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { WebSocketServer, WebSocket } from "ws";
import u from "../util.js";

export const TTL_MS = 15 * 60_000;
export const KEYS = ["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

const takeoverSchema = new mongoose.Schema({
    token_hash: { type: String, required: true, unique: true },
    job_id: { type: String, required: true },
    device_id: { type: String, required: true },
    chat_id: { type: String, required: true },
    status: { type: String, default: "issued" },   // issued | done | expired | revoked
    expires_at: { type: Date, required: true, expires: 24 * 3600 },
    created_at: { type: Date, default: Date.now },
});
const DeviceTakeover = mongoose.model("DeviceTakeover", takeoverSchema);

export type TakeoverRow = { token_hash: string; job_id: string; device_id: string; chat_id: string; status: string; expires_at: Date };

const hash = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

/** Swappable for tests (the e2e stubs Mongo). */
export const rows = {
    async create(r: TakeoverRow): Promise<void> { await DeviceTakeover.create(r); },
    async byHash(h: string): Promise<TakeoverRow | null> { return (await DeviceTakeover.findOne({ token_hash: h }).lean()) as any; },
    async setStatus(h: string, status: string): Promise<void> { await DeviceTakeover.updateOne({ token_hash: h }, { $set: { status } }); },
    async revokeJob(jobId: string): Promise<string[]> {
        const open: any[] = await DeviceTakeover.find({ job_id: jobId, status: "issued" }).lean();
        await DeviceTakeover.updateMany({ job_id: jobId, status: "issued" }, { $set: { status: "revoked" } });
        return open.map(o => o.token_hash);
    },
};

/** How to reach the Mac — wired by hub.ts, which owns the sockets. */
export const bridge = {
    toDevice: (_deviceId: string, _msg: unknown): boolean => false,
};

type Live = { viewer: WebSocket; row: TakeoverRow; timer: NodeJS.Timeout };
const live = new Map<string, Live>();   // token hash → the open viewer
const expiryTimers = new Map<string, NodeJS.Timeout>();

/** A fresh link for a job. Any earlier link for the same job stops working. */
export async function mint(job: { job_id: string; device_id: string; chat_id: string }, now = Date.now()): Promise<string> {
    for (const h of await rows.revokeJob(job.job_id)) close(h, "replaced by a newer link");
    const token = crypto.randomBytes(32).toString("base64url");
    const h = hash(token);
    await rows.create({ token_hash: h, ...job, status: "issued", expires_at: new Date(now + TTL_MS) });
    // Expiry is enforced on every use as well; the timer only makes it
    // visible — the viewer closes and the Mac is told.
    const t = setTimeout(() => void expire(h), TTL_MS);
    t.unref?.();
    expiryTimers.set(h, t);
    return `${u.publicBaseUrl()}/t/${token}`;
}

/** The row for a token, if it may be used right now. */
async function usable(token: string): Promise<TakeoverRow | null> {
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
    const row = await rows.byHash(hash(token)).catch(() => null);
    if (!row || row.status !== "issued") return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    // The lookup is by hash; this compare is the one that decides.
    if (!crypto.timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash(token)))) return null;
    return row;
}

async function expire(h: string): Promise<void> {
    expiryTimers.delete(h);
    const row = await rows.byHash(h).catch(() => null);
    if (!row || row.status !== "issued") return;
    await rows.setStatus(h, "expired").catch(() => {});
    close(h, "expired");
    bridge.toDevice(row.device_id, { t: "takeover", job: row.job_id, action: "expired" });
}

function close(h: string, why: string): void {
    const l = live.get(h);
    if (!l) return;
    live.delete(h);
    clearTimeout(l.timer);
    try { l.viewer.send(JSON.stringify({ t: "closed", why })); l.viewer.close(); } catch { /* gone */ }
}

/** The job finished or was cancelled: its link goes with it. */
export async function endJob(jobId: string): Promise<void> {
    for (const h of await rows.revokeJob(jobId).catch(() => [] as string[])) close(h, "the job has finished");
}

/** A frame from the Mac, for whoever is watching that job. */
export function frame(deviceId: string, msg: any): void {
    for (const [, l] of live) {
        if (l.row.device_id !== deviceId || l.row.job_id !== String(msg?.job || "")) continue;
        try { l.viewer.send(JSON.stringify({ t: "frame", b64: String(msg.b64 || ""), w: Number(msg.w) || 0, h: Number(msg.h) || 0 })); } catch { /* the viewer went */ }
    }
}

/** One input from the viewer, in the shape the Mac accepts — or null. */
export function cleanInput(m: any): Record<string, unknown> | null {
    const num = (v: unknown, lo: number, hi: number) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : null; };
    switch (m?.kind) {
        case "tap": { const x = num(m.x, 0, 10000), y = num(m.y, 0, 10000); return x === null || y === null ? null : { kind: "tap", x, y }; }
        case "text": { const t = String(m.text ?? ""); return t && t.length <= 500 ? { kind: "text", text: t } : null; }
        case "key": return KEYS.includes(String(m.key)) ? { kind: "key", key: String(m.key) } : null;
        case "scroll": { const dy = num(m.dy, -3000, 3000); return dy === null ? null : { kind: "scroll", dy }; }
        case "back": return { kind: "back" };
        default: return null;
    }
}

function page(): string {
    // Everything inline, so the CSP can forbid everything else.
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5">
<meta name="referrer" content="no-referrer"><title>Gepetel — your browser</title>
<style>
:root{--ink:#2A2620;--paper:#F1E7D6;--accent:#CC6B4E}
body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:var(--paper);color:var(--ink)}
header{padding:10px 14px;display:flex;align-items:center;gap:10px;justify-content:space-between}
#status{font-size:14px;opacity:.75}
#done{background:var(--accent);color:#fff;border:0;border-radius:12px;font-size:17px;font-weight:700;padding:10px 22px}
#wrap{position:relative;touch-action:pan-y pinch-zoom}
#screen{width:100%;display:block;background:#fff;border-top:2px solid var(--ink);border-bottom:2px solid var(--ink)}
#bar{display:flex;gap:6px;padding:10px 14px;flex-wrap:wrap}
#bar input{flex:1;min-width:140px;font-size:16px;padding:9px;border:2px solid var(--ink);border-radius:10px}
#bar button{font-size:15px;padding:9px 12px;border:2px solid var(--ink);border-radius:10px;background:#FBF6EC}
p.note{font-size:13px;opacity:.65;padding:0 14px}
</style></head><body>
<header><span id="status">Connecting to your Mac…</span><button id="done">Done</button></header>
<div id="wrap"><img id="screen" alt="Your Chrome tab"></div>
<div id="bar">
<input id="text" placeholder="Type here, then Send" autocomplete="off" autocapitalize="off">
<button data-send>Send</button><button data-key="Backspace">⌫</button><button data-key="Enter">↵</button><button data-key="Tab">Tab</button>
<button data-scroll="-500">▲</button><button data-scroll="500">▼</button><button data-back>Back</button>
</div>
<p class="note">Tap the picture to click there. What you type goes into whatever is selected on the page. Tap Done when you've finished, and Gepetel carries on.</p>
<script>
(function(){
  var token = location.pathname.split('/')[2];
  var ws = new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/t/'+token+'/ws');
  var img = document.getElementById('screen'), status = document.getElementById('status');
  var css = {w:0,h:0}, finished = false;
  function send(m){ if(ws.readyState===1) ws.send(JSON.stringify(m)); }
  ws.onopen = function(){ status.textContent = 'Live — your Mac\\'s Chrome'; };
  ws.onmessage = function(e){
    var m = JSON.parse(e.data);
    if (m.t==='frame'){ img.src = 'data:image/jpeg;base64,'+m.b64; css = {w:m.w,h:m.h}; }
    if (m.t==='closed'){ finished = true; status.textContent = m.why==='done' ? 'Done — Gepetel is carrying on.' : 'This link has ended ('+m.why+').'; }
  };
  ws.onclose = function(){ if(!finished) status.textContent = 'Disconnected. Reload to reconnect, if the link is still valid.'; };
  img.addEventListener('click', function(e){
    var r = img.getBoundingClientRect(); if(!css.w) return;
    send({kind:'tap', x:(e.clientX-r.left)*css.w/r.width, y:(e.clientY-r.top)*css.h/r.height});
  });
  document.querySelector('[data-send]').onclick = function(){ var t=document.getElementById('text'); if(t.value){ send({kind:'text', text:t.value}); t.value=''; } };
  [].forEach.call(document.querySelectorAll('[data-key]'), function(b){ b.onclick=function(){ send({kind:'key', key:b.getAttribute('data-key')}); }; });
  [].forEach.call(document.querySelectorAll('[data-scroll]'), function(b){ b.onclick=function(){ send({kind:'scroll', dy:+b.getAttribute('data-scroll')}); }; });
  document.querySelector('[data-back]').onclick = function(){ send({kind:'back'}); };
  document.getElementById('done').onclick = function(){ send({kind:'done'}); };
})();
</script></body></html>`;
}

const ended = (why: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gepetel</title>
<style>body{font-family:system-ui,sans-serif;background:#F1E7D6;color:#2A2620;padding:40px 20px;text-align:center}</style></head>
<body><h2>This link has ended</h2><p>${why} Go back to the chat — Gepetel will tell you what's next.</p></body></html>`;

function headers(res: Response): void {
    res.set({
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
}

export function registerTakeoverRoutes(app: Express): void {
    app.get("/t/:token", async (req: Request, res: Response) => {
        headers(res);
        const row = await usable(String(req.params.token || ""));
        if (!row) { res.status(410).type("html").send(ended("It was already used, or it expired.")); return; }
        res.type("html").send(page());
    });
}

/** The viewer's socket. Same server as the device hub; a different path. */
export function attachTakeover(server: Server): void {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
    server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        let p = "";
        try { p = new URL(req.url || "", "http://localhost").pathname; } catch { p = ""; }
        const m = p.match(/^\/t\/([A-Za-z0-9_-]+)\/ws$/);
        if (!m) return;
        const row = await usable(m[1]);
        const h = hash(m[1]);
        if (!row || live.has(h)) {
            // Expired, used, never issued — or someone is already on it.
            socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, viewer => {
            const timer = setTimeout(() => close(h, "expired"), Math.max(0, new Date(row.expires_at).getTime() - Date.now()));
            live.set(h, { viewer, row, timer });
            console.log(`takeover for ${row.job_id}: viewer connected`);
            if (!bridge.toDevice(row.device_id, { t: "takeover", job: row.job_id, action: "start" })) {
                try { viewer.send(JSON.stringify({ t: "closed", why: "your Mac is offline" })); } catch { /* gone */ }
            }
            viewer.on("message", async raw => {
                let msg: any;
                try { msg = JSON.parse(String(raw)); } catch { return; }
                if (msg?.kind === "done") {
                    live.delete(h);
                    clearTimeout(timer);
                    const t = expiryTimers.get(h); if (t) { clearTimeout(t); expiryTimers.delete(h); }
                    await rows.setStatus(h, "done").catch(() => {});
                    bridge.toDevice(row.device_id, { t: "takeover", job: row.job_id, action: "done" });
                    try { viewer.send(JSON.stringify({ t: "closed", why: "done" })); viewer.close(); } catch { /* gone */ }
                    console.log(`takeover for ${row.job_id}: done`);
                    return;
                }
                const input = cleanInput(msg);
                if (input) bridge.toDevice(row.device_id, { t: "input", job: row.job_id, ...input });
            });
            viewer.on("close", () => {
                if (live.get(h)?.viewer !== viewer) return;
                live.delete(h);
                clearTimeout(timer);
                // Paused, not over: the link stays valid until Done or expiry.
                bridge.toDevice(row.device_id, { t: "takeover", job: row.job_id, action: "pause" });
            });
        });
    });
}

export default { mint, endJob, frame, cleanInput, registerTakeoverRoutes, attachTakeover, bridge, rows, TTL_MS };
