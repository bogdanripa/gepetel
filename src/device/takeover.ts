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
        // Text-field boxes, so the phone can open its keyboard during a tap
        // on one: at most 40, four finite numbers each, nothing else.
        const fields = Array.isArray(msg.fields)
            ? msg.fields.slice(0, 40).filter((f: any) => Array.isArray(f) && f.length === 4 && f.every((n: any) => Number.isFinite(n))).map((f: number[]) => f.map(Math.round))
            : [];
        // A line for the person (a passkey window cancelled on the Mac): text only, short.
        const note = typeof msg.note === "string" ? msg.note.slice(0, 300) : "";
        try { l.viewer.send(JSON.stringify({ t: "frame", b64: String(msg.b64 || ""), w: Number(msg.w) || 0, h: Number(msg.h) || 0, fields, ...(note ? { note } : {}) })); } catch { /* the viewer went */ }
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
        case "drag": {
            // A finger's path: [x, y, ms since it started], at most 200 points, 15 s.
            if (!Array.isArray(m.points) || m.points.length < 2 || m.points.length > 200) return null;
            const pts: number[][] = [];
            for (const q of m.points) {
                if (!Array.isArray(q)) return null;
                const x = num(q[0], 0, 10000), y = num(q[1], 0, 10000), t = num(q[2], 0, 15000);
                if (x === null || y === null || t === null) return null;
                pts.push([x, y, t]);
            }
            return { kind: "drag", points: pts };
        }
        case "viewport": { const w = num(m.w, 200, 2000), h = num(m.h, 200, 2000); return w === null || h === null ? null : { kind: "viewport", w, h }; }
        default: return null;
    }
}

export function page(): string {
    // Everything inline, so the CSP can forbid everything else.
    //
    // Built to feel like an app, not a web page (asked for by the first person
    // to use it): the live tab fills the screen; a thin strip at the top holds
    // Back, the status and Done; nothing at the bottom. Tap = click. Swipe =
    // scroll the page. Pinch = zoom. Tap a text field on the picture and the
    // phone's own keyboard opens — iOS only allows that during the tap itself,
    // so the frames carry where the page's fields are and a hidden input is
    // focused right there. What is typed goes straight to the page, keys and
    // backspace included, batched briefly so a fast typist isn't a call per
    // letter.
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
<meta name="referrer" content="no-referrer"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#2A2620"><title>Gepetel — your browser</title>
<style>
:root{--ink:#2A2620;--paper:#F1E7D6;--accent:#CC6B4E}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;overflow:hidden;overscroll-behavior:none;background:#111}
body{font-family:system-ui,-apple-system,sans-serif;height:100dvh;color:#fff}
/* Holding a pill to move it selected its text: nothing here is text to select. */
body{user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
/* Every pixel is the page: the controls float over it. */
#view{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:pinch-zoom}
#screen.dragging{outline:3px solid var(--accent);outline-offset:-3px}
#screen{display:block;width:100%;height:100%;object-fit:contain;background:#fff;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
.float{position:fixed;z-index:2;touch-action:none;border:0;font-weight:600;font-size:16px;min-height:40px;border-radius:999px;
  box-shadow:0 2px 10px rgba(0,0,0,.35);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
#back{left:calc(10px + env(safe-area-inset-left));top:calc(10px + env(safe-area-inset-top));
  width:40px;padding:0;background:rgba(42,38,32,.7);color:#fff;font-size:24px;line-height:40px}
/* Paste: an iPhone keyboard has no paste key, and the hidden field no menu. */
#paste{right:calc(96px + env(safe-area-inset-right));top:calc(10px + env(safe-area-inset-top));padding:0 14px;background:rgba(42,38,32,.7);color:#fff}
#done{right:calc(10px + env(safe-area-inset-right));top:calc(10px + env(safe-area-inset-top));padding:0 18px;background:var(--accent);color:#fff}
/* Under the two buttons, never between them: a long message ran under Done. */
#status{position:fixed;z-index:2;left:50%;top:calc(60px + env(safe-area-inset-top));transform:translateX(-50%);max-width:calc(100% - 40px);
  background:rgba(42,38,32,.8);font-size:13px;padding:7px 12px;border-radius:999px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  pointer-events:none;transition:opacity .5s}
#kbd{user-select:text;-webkit-user-select:text;position:absolute;opacity:0;left:0;top:0;width:1px;height:1px;font-size:16px;border:0;padding:0;caret-color:transparent}
/* Hold a pill to move it: it pulses, then follows the finger. */
.float,#status,#hint{touch-action:none}
.moving{animation:pulse .8s ease-in-out infinite;z-index:3}
@keyframes pulse{0%,100%{transform:scale(1);box-shadow:0 0 0 0 rgba(204,107,78,.6)}50%{transform:scale(1.12);box-shadow:0 0 0 10px rgba(204,107,78,0)}}
#hint{position:absolute;left:50%;bottom:calc(14px + env(safe-area-inset-bottom));transform:translateX(-50%);background:rgba(42,38,32,.85);
  color:#fff;font-size:13px;padding:7px 12px;border-radius:999px;pointer-events:none;transition:opacity .4s}
</style></head><body>
<button id="back" class="float" aria-label="Back">‹</button><span id="status">Connecting…</span><button id="paste" class="float">Paste</button><button id="done" class="float">Done</button>
<div id="view"><img id="screen" alt="Your Chrome tab" draggable="false"><input id="kbd" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go"><div id="hint">Tap to click · swipe to scroll · pinch to zoom</div></div>
<script>
(function(){
  var token = location.pathname.split('/')[2];
  var ws = null, tries = 0, pending = [];
  var img = document.getElementById('screen'), status = document.getElementById('status'), kbd = document.getElementById('kbd'), hint = document.getElementById('hint');
  var css = {w:0,h:0}, fields = [], finished = false;
  // Kept open: a phone drops the socket when the person switches apps (to
  // the chat, and back); the buttons then did nothing (the owner, 2026-10-13:
  // "when I click back or done, nothing happens"). Back on screen, or on a
  // press while it's down, it connects again; Back and Done wait for it.
  function send(m){
    if (ws && ws.readyState===1) { ws.send(JSON.stringify(m)); return true; }
    if (m.kind==='back' || m.kind==='done') { pending.push(m); connect(); }
    return false;
  }
  // The tab renders at this screen's size, so the site shows its phone
  // layout and fills the screen — again on every rotation.
  var view = document.getElementById('view'), sizeTimer = null;
  function sendSize(){ send({kind:'viewport', w:view.clientWidth, h:view.clientHeight}); }
  window.addEventListener('resize', function(){ clearTimeout(sizeTimer); sizeTimer = setTimeout(function(){ if(document.activeElement!==kbd) sendSize(); }, 400); });
  var lastNote = '';
  function say(t, keep, ms){ status.textContent = t; status.style.opacity = 1; if(!keep) setTimeout(function(){ if (status.textContent === t) status.style.opacity = 0; }, ms || 3000); }
  function connect(){
    if (finished || (ws && ws.readyState<=1)) return;
    if (tries) say('Reconnecting…', true);
    ws = new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/t/'+token+'/ws');
    ws.onopen = function(){
      tries = 0; say('Live — your Mac’s Chrome'); sendSize(); setTimeout(function(){ hint.style.opacity = 0; }, 5000);
      var q = pending; pending = []; q.forEach(function(m){ ws.send(JSON.stringify(m)); });
    };
    ws.onmessage = function(e){
      var m = JSON.parse(e.data);
      if (m.t==='frame'){ img.src = 'data:image/jpeg;base64,'+m.b64; css = {w:m.w,h:m.h}; fields = m.fields || []; if (m.note && m.note !== lastNote) { lastNote = m.note; say(m.note, false, 10000); } }
      if (m.t==='closed'){ finished = true; kbd.blur(); say(m.why==='done' ? 'Done — Gepetel carries on' : 'Link ended ('+m.why+')', true); }
    };
    ws.onclose = function(){
      if (finished) return;
      // Retried a few times while on screen; then a tap or coming back retries.
      if (document.visibilityState==='visible' && tries++ < 5) { say('Reconnecting…', true); setTimeout(connect, 800*tries); }
      else say('Disconnected — tap to reconnect', true);
    };
  }
  connect();
  document.addEventListener('visibilitychange', function(){ if (document.visibilityState==='visible') { tries = 0; connect(); } });
  img.addEventListener('touchstart', function(){ if (!ws || ws.readyState>1) { tries = 0; connect(); } }, {passive:true});

  // Picture coordinates → the page's CSS pixels.
  // Where the picture is actually drawn: object-fit: contain leaves bands
  // above and below (or beside) it when its shape isn't the screen's, and
  // taps measured over the whole element were off — vertically, more towards
  // the top and bottom (the owner, 2026-10-14: "clicks are off on the y axis").
  function drawn(){
    var r = img.getBoundingClientRect();
    if (!css.w || !css.h) return { left:r.left, top:r.top, width:r.width, height:r.height };
    var s = Math.min(r.width/css.w, r.height/css.h), w = css.w*s, h = css.h*s;
    return { left:r.left+(r.width-w)/2, top:r.top+(r.height-h)/2, width:w, height:h };
  }
  function toPage(x, y){ var r = drawn(); return { x:(x-r.left)*css.w/r.width, y:(y-r.top)*css.h/r.height, r:r }; }
  function onField(p){ for (var i=0;i<fields.length;i++){ var f=fields[i]; if(p.x>=f[0]&&p.x<=f[0]+f[2]&&p.y>=f[1]&&p.y<=f[1]+f[3]) return f; } return null; }

  // One finger: a tap clicks, a vertical swipe scrolls the page. Two: pinch.
  // Hold, then move: a drag — a slider check ("slide to the right", asked for
  // by the owner after OLX showed one). The finger's path and its timing go
  // to the Mac in one piece, where a real mouse follows them.
  var start = null, moved = false, dragging = false, path = [], holdTimer = null;
  function dragPoint(t){ var p = toPage(t.clientX, t.clientY); path.push([Math.round(p.x), Math.round(p.y), Date.now() - start.t0]); }
  img.addEventListener('touchstart', function(e){
    if(e.touches.length!==1){ start=null; clearTimeout(holdTimer); return; }
    var t=e.touches[0]; start={x:t.clientX,y:t.clientY,lastY:t.clientY,t0:Date.now()}; moved=false; dragging=false; path=[];
    clearTimeout(holdTimer);
    holdTimer = setTimeout(function(){ if(start && !moved){ dragging = true; dragPoint(t); img.classList.add('dragging'); if(navigator.vibrate) navigator.vibrate(15); } }, 300);
  }, {passive:true});
  img.addEventListener('touchmove', function(e){
    if(!start || e.touches.length!==1) return;
    var t=e.touches[0];
    if(dragging){ e.preventDefault(); if(path.length < 200) dragPoint(t); return; }
    var dy=start.lastY-t.clientY;
    if(Math.abs(t.clientY-start.y)>10 || Math.abs(t.clientX-start.x)>10) { moved=true; clearTimeout(holdTimer); }
    if(moved && Math.abs(dy)>24){ var r=drawn(); send({kind:'scroll', dy:Math.round(dy*css.h/r.height)}); start.lastY=t.clientY; }
    if(moved) e.preventDefault();
  }, {passive:false});
  img.addEventListener('touchend', function(e){
    clearTimeout(holdTimer);
    if(dragging){
      dragging=false; img.classList.remove('dragging'); var t=e.changedTouches[0]; if(t) dragPoint(t);
      // Held a moment without moving: a tap after all (a slow tap was sent as
      // an empty drag, and nothing happened).
      var far = path.some(function(q){ return Math.abs(q[0]-path[0][0]) > 6 || Math.abs(q[1]-path[0][1]) > 6; });
      if (far && path.length>=2) { send({kind:'drag', points:path.slice(0,200)}); start=null; e.preventDefault(); return; }
      // Not far: falls through to the tap below.
      moved = false;
    }
  }, {passive:false});
  // A mouse drags too: press, move, let go.
  var mstart = null, mpath = [];
  img.addEventListener('mousedown', function(e){ if('ontouchstart' in window || !css.w) return; mstart = {t0:Date.now(), x:e.clientX, y:e.clientY}; var p=toPage(e.clientX,e.clientY); mpath=[[Math.round(p.x),Math.round(p.y),0]]; });
  img.addEventListener('mousemove', function(e){ if(!mstart) return; var p=toPage(e.clientX,e.clientY); if(mpath.length<200) mpath.push([Math.round(p.x),Math.round(p.y),Date.now()-mstart.t0]); });
  window.addEventListener('mouseup', function(e){ if(!mstart) return; var far = Math.abs(e.clientX-mstart.x)>6 || Math.abs(e.clientY-mstart.y)>6; mstart=null; if(far && mpath.length>=2){ suppressClick = true; send({kind:'drag', points:mpath}); } });
  var suppressClick = false;
  img.addEventListener('touchend', function(e){
    if(!start || moved || !css.w){ start=null; return; }
    var p = toPage(start.x, start.y); start = null;
    send({kind:'tap', x:p.x, y:p.y});
    var f = onField(p);
    if (f) {
      // Inside the tap, or iOS won't show the keyboard.
      // Over the field, so the phone doesn't scroll to find its input.
      var v = view.getBoundingClientRect();
      kbd.style.left = Math.round(p.r.left - v.left + f[0]*p.r.width/css.w) + 'px';
      kbd.style.top = Math.round(p.r.top - v.top + f[1]*p.r.height/css.h) + 'px';
      kbd.focus({preventScroll:true});
    } else kbd.blur();
    e.preventDefault();
  }, {passive:false});
  // A mouse (or a desktop) works too.
  img.addEventListener('click', function(e){
    if(suppressClick){ suppressClick = false; return; }
    if(!css.w || 'ontouchstart' in window) return;
    var p = toPage(e.clientX, e.clientY); send({kind:'tap', x:p.x, y:p.y});
    if (onField(p)) kbd.focus({preventScroll:true});
  });
  img.addEventListener('wheel', function(e){ e.preventDefault(); send({kind:'scroll', dy:Math.round(e.deltaY)}); }, {passive:false});

  // Typing: letters batched for a moment, keys sent as keys, in order.
  var buf = '', timer = null;
  function flush(){ if(buf){ send({kind:'text', text:buf}); buf=''; } timer=null; }
  kbd.addEventListener('beforeinput', function(e){
    // A paste (or AutoFill) brings its text in dataTransfer, not data, on
    // an iPhone: read from either, or a pasted password went nowhere.
    var got = e.data || (e.dataTransfer && e.dataTransfer.getData('text/plain')) || '';
    if (e.inputType==='insertText' || e.inputType==='insertReplacementText' || e.inputType==='insertFromPaste' || e.inputType==='insertFromDrop') { if(got){ buf+=got; if(!timer) timer=setTimeout(flush,250); } }
    else if (e.inputType==='deleteContentBackward') { flush(); send({kind:'key', key:'Backspace'}); }
    else if (e.inputType==='insertLineBreak' || e.inputType==='insertParagraph') { flush(); send({kind:'key', key:'Enter'}); }
    e.preventDefault(); kbd.value='';
  });
  // Where beforeinput has no text for a paste, the paste event has it.
  kbd.addEventListener('paste', function(e){
    var t = e.clipboardData && e.clipboardData.getData('text/plain');
    if (t) { e.preventDefault(); buf+=t; if(!timer) timer=setTimeout(flush,250); kbd.value=''; }
  });
  kbd.addEventListener('keydown', function(e){
    if (e.key==='Enter'){ e.preventDefault(); flush(); send({kind:'key', key:'Enter'}); }
    else if (e.key==='Tab'){ e.preventDefault(); flush(); send({kind:'key', key:'Tab'}); }
    else if (e.key==='Backspace' && !kbd.value){ e.preventDefault(); flush(); send({kind:'key', key:'Backspace'}); }
  });

  // ---- movable pills ----------------------------------------------------
  // Hold one for half a second and it pulses; drag it; let go and it stays
  // there — remembered on this phone, as a share of the screen so it lands
  // sensibly after rotating, and always kept fully on screen. A quick tap is
  // still the button; a drag never presses it.
  function store(k, v){ try { if (v) localStorage.setItem('gepetel.pill.'+k, JSON.stringify(v)); return JSON.parse(localStorage.getItem('gepetel.pill.'+k) || 'null'); } catch(_) { return null; } }
  function place(el, pos){
    if (!pos) return;
    var w = el.offsetWidth || 40, h = el.offsetHeight || 40;
    var x = Math.min(Math.max(0, pos.x * innerWidth), innerWidth - w), y = Math.min(Math.max(0, pos.y * innerHeight), innerHeight - h);
    el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.transform = 'none';
  }
  var dragged = {};
  function movable(el){
    var key = el.id, timer = null, live = false, dx = 0, dy = 0, sx = 0, sy = 0;
    el.style.touchAction = 'none'; el.style.webkitUserSelect = 'none'; el.style.userSelect = 'none';
    place(el, store(key));
    window.addEventListener('resize', function(){ place(el, store(key)); });
    el.addEventListener('pointerdown', function(e){
      sx = e.clientX; sy = e.clientY; dragged[key] = false;
      timer = setTimeout(function(){
        live = true; dragged[key] = true;
        var r = el.getBoundingClientRect(); dx = sx - r.left; dy = sy - r.top;
        el.classList.add('moving'); el.style.pointerEvents = 'auto';
        if (navigator.vibrate) navigator.vibrate(15);
        el.setPointerCapture(e.pointerId);
      }, 500);
    });
    el.addEventListener('pointermove', function(e){
      if (!live) { if (timer && (Math.abs(e.clientX-sx) > 8 || Math.abs(e.clientY-sy) > 8)) { clearTimeout(timer); timer = null; } return; }
      e.preventDefault();
      var x = Math.min(Math.max(0, e.clientX - dx), innerWidth - el.offsetWidth), y = Math.min(Math.max(0, e.clientY - dy), innerHeight - el.offsetHeight);
      el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.transform = 'none';
    });
    function end(){
      clearTimeout(timer); timer = null;
      if (!live) return;
      live = false; el.classList.remove('moving');
      var r = el.getBoundingClientRect();
      store(key, { x: r.left / innerWidth, y: r.top / innerHeight });
    }
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('contextmenu', function(e){ e.preventDefault(); });
    el.addEventListener('selectstart', function(e){ e.preventDefault(); });
  }
  [document.getElementById('back'), document.getElementById('paste'), document.getElementById('done'), status, hint].forEach(movable);
  // The two messages can be held while they show; otherwise taps go through them.
  [status, hint].forEach(function(el){ new MutationObserver(function(){ el.style.pointerEvents = (el.style.opacity === '0') ? 'none' : 'auto'; }).observe(el, { attributes: true, attributeFilter: ['style'] }); });

  // A press shows: the button dims for a moment, and the status says what's
  // happening — a press that seemed to do nothing was the complaint.
  function pressed(el, text){ el.style.opacity = .55; setTimeout(function(){ el.style.opacity = ''; }, 250); say(text); }
  document.getElementById('back').onclick = function(){ if (dragged.back) { dragged.back = false; return; } pressed(this, 'Back…'); send({kind:'back'}); };
  // What's on the phone's clipboard (a password from its manager) goes to
  // the Mac as typed text. The phone asks once ("Paste") — it's a tap's.
  document.getElementById('paste').onclick = function(){
    if (dragged.paste) { dragged.paste = false; return; }
    var el = this, typing = document.activeElement === kbd;
    if (!navigator.clipboard || !navigator.clipboard.readText) { say('This phone doesn’t let a page read its clipboard'); return; }
    navigator.clipboard.readText().then(function(t){
      if (!t) { say('Nothing to paste'); return; }
      flush(); send({kind:'text', text:t}); pressed(el, 'Pasted');
      if (typing) kbd.focus();
    }).catch(function(){ say('Paste wasn’t allowed'); });
  };
  document.getElementById('done').onclick = function(){ if (dragged.done) { dragged.done = false; return; } flush(); kbd.blur(); pressed(this, 'Telling Gepetel you’re done…'); send({kind:'done'}); };
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
                // What the phone sent, by kind only — never what was typed.
                if (input && input.kind !== "scroll" && input.kind !== "viewport") console.log(`takeover for ${row.job_id}: ${input.kind}${input.kind === "tap" ? ` at ${Math.round(Number((input as any).x))},${Math.round(Number((input as any).y))}` : ""}`);
                if (input) bridge.toDevice(row.device_id, { t: "input", job: row.job_id, ...input });
            });
            viewer.on("close", () => {
                if (live.get(h)?.viewer !== viewer) return;
                live.delete(h);
                clearTimeout(timer);
                // Paused, not over: the link stays valid until Done or expiry.
                console.log(`takeover for ${row.job_id}: viewer gone (paused)`);
                bridge.toDevice(row.device_id, { t: "takeover", job: row.job_id, action: "pause" });
            });
        });
    });
}

export default { mint, endJob, frame, cleanInput, registerTakeoverRoutes, attachTakeover, bridge, rows, TTL_MS };
