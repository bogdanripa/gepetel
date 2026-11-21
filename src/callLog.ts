// One record per phone call, so every day the calls can be read back and
// learnt from (2026-11-21: "write as many logs as needed so every day we can
// look at call logs and what happened with every call and learn and improve").
//
// A call is announced up to three times (a Live announcement and one or two
// realtime ones for the same INVITE); all of them land on ONE record, tied
// together by what the SIP headers share (our own signed mission / call-back
// headers, Twilio's CallSid, the SIP Call-ID), or failing that the caller's
// number within two minutes. The record holds a timeline (ms since the first
// event), the decision, the accept and how long it took, the session, each
// ask, how it ended, the quality numbers and the transcript.
//
// Best-effort by design: nothing here is awaited on a call's hot path. The
// record lives in memory and is written to Mongo with .catch on key events
// (decided, accepted, ended), only while the database is connected; a logging
// failure never touches the call. Transcripts go to Mongo only (the person's
// own call, kept like the chat history: 30 days), never to stdout.
import mongoose from "mongoose";

export type Direction = "inbound" | "callback" | "outbound-mission" | "browser-test";
export type Outcome = "answered" | "rejected" | "failed" | "no-answer" | "dropped" | "in-progress";
export type TimelineEntry = { t: number; event: string; detail?: string };
export type Ask = { request: string; ms: number; steps: string };
export type CallLine = { who: "them" | "gepetel"; text: string };

/** The numbers the "[voice] quality" line computes, as data. */
export type QualitySummary = {
    model: string; secs: number;
    net?: { rttMs: number; lossPct: number; concealedPct: number; glitches: number; jitterMs: number; jbufMs: number; grade?: string };
    grok?: { underruns: number; maxGapMs: number; wsBacklogMax: number };
    errors: string[]; rateLimitEvents: number; events: number;
    pi: { cpuPct?: { avg: number; max: number }; lagMs?: { avg: number; max: number }; rssMb?: { avg: number; max: number } } | null;
};

const RETENTION_S = 60 * 60 * 24 * 30;   // the same as messagearchives
const MAX_TIMELINE = 400;
const MAX_DETAIL = 2000;

// ------------------------------------------------------------------ pure --

/** Anything as one log line: newlines and runs of space collapsed, capped.
 *  A 400 from OpenAI's accept was logged pretty-printed and grep showed only
 *  "400 {" — the reason was on the next lines (2026-11-21). */
export function oneLine(s: any, max = MAX_DETAIL): string {
    const t = String(s ?? "").replace(/\s*[\r\n]+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** An error as one line, with the API's own body when it has one. */
export function errLine(e: any, max = MAX_DETAIL): string {
    if (e === null || e === undefined) return "?";
    if (typeof e !== "object") return oneLine(e, max);
    const msg = oneLine(e.message || String(e), max);
    const body = e.error ? oneLine(typeof e.error === "string" ? e.error : JSON.stringify(e.error), max) : "";
    const status = e.status && !msg.startsWith(String(e.status)) ? `${e.status} ` : "";
    return oneLine(`${status}${msg}${body && !msg.includes(body.slice(0, 40)) ? ` ${body}` : ""}`, max);
}

/** What ties a call's announcements together: our own signed headers, then
 *  Twilio's CallSid, then the SIP Call-ID; else the caller's number (windowed
 *  by the registry), else only this announcement's id. */
export function legKey(headers: { name: string; value: string }[], x: { id: string; missionId?: string; callbackDigits?: string; digits?: string }): { key: string; windowed: boolean } {
    const get = (n: string) => (headers || []).find(h => String(h?.name || "").toLowerCase() === n)?.value?.trim() || "";
    if (x.missionId) return { key: `mission:${x.missionId}`, windowed: false };
    if (x.callbackDigits) {
        const ts = get("x-gepetel-ts");
        if (/^\d+$/.test(ts)) return { key: `cb:${x.callbackDigits}:${ts}`, windowed: false };
    }
    const sid = get("x-twilio-callsid") || get("x-twilio-call-sid");
    if (sid) return { key: `twilio:${sid}`, windowed: false };
    const cid = get("call-id");
    if (cid) return { key: `sip:${cid}`, windowed: false };
    if (x.digits) return { key: `num:${x.digits}`, windowed: true };
    return { key: `id:${x.id}`, windowed: false };
}

/** The names of the SIP headers (never their values): what OpenAI sends us. */
export function headerNames(headers: { name: string; value: string }[]): string {
    return [...new Set((headers || []).map(h => String(h?.name || "").toLowerCase()).filter(Boolean))].sort().join(",");
}

export type ClassifyInput = {
    direction: Direction; ended: boolean; accepted: boolean;
    rejected?: string; acceptFailed?: string; rungFailed?: string; rung?: boolean;
    heardThem: boolean; hangup?: string; missionReached?: boolean;
};

/** How a call went, from what was recorded. */
export function classify(x: ClassifyInput): { outcome: Outcome; why: string } {
    if (x.rejected) return { outcome: "rejected", why: x.rejected };
    if (x.rungFailed) return { outcome: "failed", why: x.rungFailed };
    if (!x.accepted) {
        if (x.acceptFailed) return { outcome: "failed", why: `accept failed: ${x.acceptFailed}` };
        if (!x.ended) return { outcome: "in-progress", why: "" };
        if (x.rung) return { outcome: "no-answer", why: "never picked up" };
        return { outcome: "failed", why: "never decided (no announcement taken)" };
    }
    if (!x.ended) return { outcome: "in-progress", why: "" };
    if (x.hangup === "voicemail") return { outcome: "no-answer", why: "voicemail" };
    if (x.missionReached === false) return { outcome: "no-answer", why: "nobody reached (outcome)" };
    if (!x.heardThem) {
        return x.direction === "callback" || x.direction === "outbound-mission"
            ? { outcome: "no-answer", why: "nothing heard from them" }
            : { outcome: "dropped", why: `nothing heard from them${x.hangup ? ` (${x.hangup})` : ""}` };
    }
    if (x.hangup && /^socket error/.test(x.hangup)) return { outcome: "dropped", why: x.hangup };
    return { outcome: "answered", why: x.hangup || "" };
}

/** ok / warn / bad: the network grade when the caller's side reported one,
 *  else the relay's own errors and resources. */
export function qualityGrade(q: QualitySummary | null | undefined): "ok" | "warn" | "bad" | "" {
    if (!q) return "";
    if (q.net?.grade === "bad" || q.net?.grade === "warn") return q.net.grade;
    if ((q.pi?.lagMs?.max || 0) > 500 || q.errors.length > 2) return "bad";
    if (q.errors.length || (q.pi?.cpuPct?.max || 0) > 80 || (q.pi?.lagMs?.max || 0) > 100) return "warn";
    return "ok";
}

/** Offset of `tz` from UTC at `at`, in ms (Bucharest: +2 h, +3 h in summer). */
function tzOffsetMs(at: Date, tz: string): number {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
        .formatToParts(at).map(x => [x.type, x.value]));
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
    return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** A local day "YYYY-MM-DD" as [from, to) instants: a Bucharest day is 23 or 25 hours at the clock changes. */
export function dayBounds(day: string, tz = "Europe/Bucharest"): { from: Date; to: Date } | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
    if (!m) return null;
    const midnight = (y: number, mo: number, d: number) => {
        const guess = Date.UTC(y, mo - 1, d);
        let t = guess - tzOffsetMs(new Date(guess), tz);
        t = guess - tzOffsetMs(new Date(t), tz);
        return new Date(t);
    };
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const from = midnight(y, mo, d);
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    const to = midnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
    return isNaN(from.getTime()) ? null : { from, to };
}

/** The local day of an instant, "YYYY-MM-DD". */
export function localDay(at: Date, tz = "Europe/Bucharest"): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The day before a "YYYY-MM-DD". */
export function dayBefore(day: string): string {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** The day whose summary is due at `now`: yesterday, from 08:00 Bucharest
 *  (the hourly tick sends it once); "" before then. */
export function digestDay(now: Date, tz = "Europe/Bucharest", fromHour = 8): string {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(now));
    return hour >= fromHour ? dayBefore(localDay(now, tz)) : "";
}

/** The report's row for a stored call: what the page and the JSON show. */
export type ReportRow = {
    key: string; ids: string[]; at: string; time: string; direction: Direction; who: string; model: string; route: string;
    outcome: Outcome; why: string; durationS: number; billedS: number; acceptMs: number | null; asks: { request: string; s: number }[];
    grade: string; quality: QualitySummary | null; mission: any; timeline: TimelineEntry[]; lines: CallLine[]; test: boolean;
};

export function toRow(d: any, tz = "Europe/Bucharest"): ReportRow {
    const at = new Date(d.startedAt || Date.now());
    return {
        key: String(d.key || ""), ids: d.ids || [], at: at.toISOString(),
        time: new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at),
        direction: d.direction || "inbound",
        who: d.direction === "outbound-mission" ? `${d.business || "?"}${d.name ? ` (for ${d.name})` : ""}` : [d.name, d.tail].filter(Boolean).join(" ") || "(unknown)",
        model: d.model || "", route: d.route || "", outcome: d.outcome || "in-progress", why: d.why || "",
        durationS: d.durationS || 0, billedS: d.billedS || 0, acceptMs: typeof d.acceptMs === "number" ? d.acceptMs : null,
        asks: (d.asks || []).map((a: Ask) => ({ request: a.request, s: Math.round(a.ms / 100) / 10 })),
        grade: qualityGrade(d.quality), quality: d.quality || null, mission: d.missionOutcome || null,
        timeline: d.timeline || [], lines: d.lines || [], test: !!d.test,
    };
}

const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const secs = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;

/** The one-line daily summary for the creator (Telegram). "" with no calls. */
export function summaryLine(day: string, rows: ReportRow[], link = ""): string {
    if (!rows.length) return "";
    const by = (o: Outcome) => rows.filter(r => r.outcome === o).length;
    const outcomes = (["answered", "no-answer", "rejected", "failed", "dropped", "in-progress"] as Outcome[]).map(o => [o, by(o)] as const).filter(([, n]) => n).map(([o, n]) => `${n} ${o}`).join(", ");
    const tests = rows.filter(r => r.test).length;
    const accepts = rows.map(r => r.acceptMs).filter((x): x is number => typeof x === "number");
    const asks = rows.flatMap(r => r.asks.map(a => a.s));
    const grades = ["ok", "warn", "bad"].map(g => [g, rows.filter(r => r.grade === g).length] as const).filter(([, n]) => n).map(([g, n]) => `${n} ${g}`).join(", ");
    const bad = rows.find(r => r.outcome === "failed" || r.outcome === "dropped");
    const mins = Math.round(rows.reduce((a, r) => a + r.durationS, 0) / 60);
    return [
        `Calls ${day}: ${rows.length}${tests ? ` (${tests} test)` : ""}, ${mins} min — ${outcomes}`,
        accepts.length ? `accept p50 ${secs(pct(accepts, 0.5))}, max ${secs(Math.max(...accepts))}` : "",
        asks.length ? `${asks.length} ask(s), avg ${(asks.reduce((a, b) => a + b, 0) / asks.length).toFixed(1)} s, max ${Math.max(...asks).toFixed(1)} s` : "",
        grades ? `quality ${grades}` : "",
        bad ? `e.g. ${bad.time} ${bad.outcome}: ${oneLine(bad.why, 160)}` : "",
        link,
    ].filter(Boolean).join("; ");
}

const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The admin page for a day's calls: plain server-rendered HTML like admin.ts. */
export function renderReport(day: string, rows: ReportRow[]): string {
    const color: Record<string, string> = { answered: "#0a7d28", "no-answer": "#888", rejected: "#a60", failed: "#b00", dropped: "#b00", "in-progress": "#0a58ca" };
    const gcolor: Record<string, string> = { ok: "#0a7d28", warn: "#a60", bad: "#b00" };
    const body = rows.map(r => `<tr style="border-top:1px solid #eee;vertical-align:top">
        <td style="white-space:nowrap;color:#888">${esc(r.time)}</td>
        <td>${esc(r.direction)}${r.test ? ' <span style="color:#888;font-size:.8em">test</span>' : ""}</td>
        <td>${esc(r.who)}</td>
        <td style="font-size:.85em">${esc(r.model)}<br><span style="color:#888">${esc(r.route)}</span></td>
        <td><span style="color:${color[r.outcome] || "#333"}">${esc(r.outcome)}</span>${r.why ? `<br><span style="color:#888;font-size:.8em">${esc(r.why.slice(0, 200))}</span>` : ""}</td>
        <td style="white-space:nowrap">${r.durationS ? `${r.durationS} s` : "—"}</td>
        <td style="white-space:nowrap">${r.acceptMs === null ? "—" : `${r.acceptMs} ms`}</td>
        <td style="font-size:.85em">${r.asks.length ? `${r.asks.length}: ${r.asks.map(a => `${a.s}s`).join(", ")}` : "—"}</td>
        <td style="color:${gcolor[r.grade] || "#888"}">${esc(r.grade || "—")}</td>
    </tr>
    <tr><td></td><td colspan="8" style="padding-bottom:.6rem"><details><summary style="cursor:pointer;color:#0a58ca;font-size:.85em">timeline, transcript</summary>
        <p style="color:#888;font-size:.8em;margin:.3rem 0">${esc(r.key)} · ${esc(r.ids.join(", "))}${r.billedS ? ` · billed ${r.billedS} s` : ""}</p>
        <table style="font-size:.85em;margin:.3rem 0">${r.timeline.map(e => `<tr style="vertical-align:top"><td style="white-space:nowrap;color:#888;padding-right:.6rem">+${(e.t / 1000).toFixed(2)}s</td><td style="white-space:nowrap;padding-right:.6rem">${esc(e.event)}</td><td style="color:#555;word-break:break-word">${esc(e.detail || "")}</td></tr>`).join("")}</table>
        ${r.asks.length ? `<p style="font-size:.85em;margin:.4rem 0 .2rem"><b>Asks</b></p><ul style="font-size:.85em;margin:0">${r.asks.map(a => `<li>${a.s}s — ${esc(a.request)}</li>`).join("")}</ul>` : ""}
        ${r.mission ? `<p style="font-size:.85em;margin:.4rem 0"><b>Outcome</b>: reached=${r.mission.reached ? "yes" : "no"} done=${r.mission.done ? "yes" : "no"} — ${esc(r.mission.summary || "")}</p>` : ""}
        ${r.quality ? `<p style="font-size:.8em;color:#555;margin:.4rem 0">${esc(JSON.stringify(r.quality))}</p>` : ""}
        ${r.lines.length ? `<div style="font-size:.85em;margin:.4rem 0;padding:.4rem .6rem;background:#f7f7f7">${r.lines.map(l => `<div><b>${l.who === "them" ? "Them" : "Gepetel"}:</b> ${esc(l.text)}</div>`).join("")}</div>` : ""}
    </details></td></tr>`).join("");
    const nav = (d: string, label: string) => `<a href="?day=${d}" style="margin-right:.8rem">${label}</a>`;
    const next = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + 1)).toISOString().slice(0, 10);
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Calls ${esc(day)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem}a{color:#0a58ca;text-decoration:none}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.4rem .6rem .4rem 0;vertical-align:top}</style>
</head><body>
<h1>Calls on ${esc(day)} (${rows.length})</h1>
<p style="margin:.2rem 0 1rem">${nav(dayBefore(day), "← previous day")}${nav(next, "next day →")}<a href="calls.json?day=${esc(day)}">json</a></p>
<p style="color:#555;font-size:.9em">${esc(summaryLine(day, rows)) || "No calls."}</p>
<table>
<tr style="border-bottom:1px solid #ddd"><th>Time</th><th>Direction</th><th>Who</th><th>Model / route</th><th>Outcome</th><th>Duration</th><th>To accept</th><th>Asks</th><th>Quality</th></tr>
${body || '<tr><td colspan="9" style="color:#888;padding:1rem 0">No calls that day.</td></tr>'}
</table>
<p style="color:#888;font-size:.85em">Kept for 30 days, like the chat history. Times are Bucharest time.</p>
</body></html>`;
}

// ---------------------------------------------------------------- record --

const lineSchema = new mongoose.Schema({ who: String, text: String }, { _id: false });
const callLogSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    ids: { type: [String], default: [] },
    direction: { type: String, default: "inbound" },
    model: { type: String, default: "" },
    route: { type: String, default: "" },
    chatId: { type: String, default: "", index: true },
    name: { type: String, default: "" },
    tail: { type: String, default: "" },
    business: { type: String, default: "" },
    missionId: { type: String, default: "" },
    test: { type: Boolean, default: false },
    startedAt: { type: Date, default: Date.now, index: true, expires: RETENTION_S },
    acceptedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    acceptMs: { type: Number, default: null },
    durationS: { type: Number, default: 0 },
    billedS: { type: Number, default: 0 },
    outcome: { type: String, default: "in-progress" },
    why: { type: String, default: "" },
    hangup: { type: String, default: "" },
    timeline: { type: [mongoose.Schema.Types.Mixed], default: [] },
    asks: { type: [mongoose.Schema.Types.Mixed], default: [] },
    quality: { type: mongoose.Schema.Types.Mixed, default: null },
    missionOutcome: { type: mongoose.Schema.Types.Mixed, default: null },
    lines: { type: [lineSchema], default: [] },
});
export const CallLog = mongoose.models.CallLog || mongoose.model("CallLog", callLogSchema);

/** The day's summary went to the creator: one per Bucharest day, across restarts. */
const digestSchema = new mongoose.Schema({ day: { type: String, required: true, unique: true }, createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 60 } });
export const CallDigest = mongoose.models.CallDigest || mongoose.model("CallDigest", digestSchema);

export class CallRecord {
    readonly firstAt: number;
    ids: string[] = [];
    direction: Direction = "inbound";
    model = ""; route = ""; chatId = ""; name = ""; tail = ""; business = ""; missionId = ""; test = false;
    acceptedAt = 0; endedAt = 0; acceptMs: number | null = null; durationS = 0; billedS = 0;
    rejected = ""; acceptFailed = ""; rungFailed = ""; rung = false; hangup = "";
    heardThem = false; heardUs = false;
    timeline: TimelineEntry[] = [];
    asks: Ask[] = [];
    quality: QualitySummary | null = null;
    missionOutcome: any = null;
    lines: CallLine[] = [];
    private saving: Promise<unknown> = Promise.resolve();
    constructor(readonly key: string, private now: () => number = Date.now) { this.firstAt = now(); }

    ev(event: string, detail?: any): this {
        if (this.timeline.length >= MAX_TIMELINE) return this;
        const e: TimelineEntry = { t: this.now() - this.firstAt, event };
        if (detail !== undefined && detail !== "") e.detail = oneLine(detail);
        this.timeline.push(e);
        return this;
    }
    set(f: Partial<Pick<CallRecord, "direction" | "model" | "route" | "chatId" | "name" | "tail" | "business" | "missionId" | "test">>): this {
        for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "") (this as any)[k] = v;
        return this;
    }
    addId(id: string): this { if (id && !this.ids.includes(id)) this.ids.push(id); return this; }
    /** The accept went through: how long since the first announcement. */
    accepted(): number {
        this.acceptedAt = this.now();
        this.acceptMs = this.acceptedAt - this.firstAt;
        this.acceptFailed = "";
        this.ev("accept ok", `${this.acceptMs} ms`);
        return this.acceptMs;
    }
    /** The session's socket is open (a browser test has no accept: this is it). */
    connected(): void { if (!this.acceptedAt) this.acceptedAt = this.now(); this.ev("session connected"); }
    /** Them speaking for the first time, and Gepetel. */
    them(): void { if (!this.heardThem) { this.heardThem = true; this.ev("first words from them"); } }
    us(): void { if (!this.heardUs) { this.heardUs = true; this.ev("first words from Gepetel"); } }
    hungUp(reason: string): void { if (!this.hangup) { this.hangup = reason; this.ev("hangup", reason); } }
    ask(request: string, ms: number, steps: string): void {
        this.asks.push({ request: oneLine(request, 300), ms, steps: oneLine(steps, 1500) });
        this.ev("ask done", `${(ms / 1000).toFixed(1)}s ${oneLine(steps, 1500)}`);
    }
    end(lines: CallLine[], billedS: number): void {
        if (this.endedAt) return;
        this.endedAt = this.now();
        const from = this.acceptedAt || this.firstAt;
        this.durationS = Math.round((this.endedAt - from) / 1000);
        this.billedS = billedS;
        this.lines = lines.map(l => ({ who: l.who, text: String(l.text || "").trim() })).filter(l => l.text);
        this.ev("ended", `${this.durationS}s, ${this.lines.length} lines`);
    }
    classify() {
        return classify({
            direction: this.direction, ended: !!this.endedAt, accepted: !!this.acceptedAt,
            rejected: this.rejected, acceptFailed: this.acceptFailed, rungFailed: this.rungFailed, rung: this.rung,
            heardThem: this.heardThem, hangup: this.hangup, missionReached: this.missionOutcome ? !!this.missionOutcome.reached : undefined,
        });
    }
    doc() {
        const c = this.classify();
        return {
            key: this.key, ids: this.ids, direction: this.direction, model: this.model, route: this.route,
            chatId: this.chatId, name: this.name, tail: this.tail, business: this.business, missionId: this.missionId, test: this.test,
            startedAt: new Date(this.firstAt), acceptedAt: this.acceptedAt ? new Date(this.acceptedAt) : null, endedAt: this.endedAt ? new Date(this.endedAt) : null,
            acceptMs: this.acceptMs, durationS: this.durationS, billedS: this.billedS,
            outcome: c.outcome, why: c.why, hangup: this.hangup,
            timeline: this.timeline, asks: this.asks, quality: this.quality, missionOutcome: this.missionOutcome, lines: this.lines,
        };
    }
    /** Write it out, in order, never throwing and never awaited by a call. */
    flush(): void {
        if (mongoose.connection.readyState !== 1) return;
        this.saving = this.saving.then(() => CallLog.updateOne({ key: this.key }, { $set: this.doc() }, { upsert: true }))
            .catch((e: any) => console.error(`[voice] call log ${this.key} not saved: ${errLine(e, 300)}`));
    }
}

// --------------------------------------------------------------- registry --

const WINDOW_MS = 2 * 60_000;      // a number-keyed call's announcements arrive within this
const KEEP_MS = 10 * 60_000;       // an ended record stays for late events (quality, outcome)
const STALE_MS = 15 * 60_000;      // never accepted, never ended: closed off as it stands
const recs = new Map<string, CallRecord>();   // record key → record
const byIdMap = new Map<string, CallRecord>(); // announcement / session id → record

let sweeper: ReturnType<typeof setInterval> | null = null;
function sweep(now = Date.now()): void {
    for (const [k, r] of recs) {
        const age = now - r.firstAt;
        if (!r.endedAt && age > STALE_MS && !r.acceptedAt) { r.ev("closed off", "no accept and no end within 15 minutes"); r.end([], 0); r.flush(); }
        if ((r.endedAt && now - r.endedAt > KEEP_MS) || age > 6 * 60 * 60_000) {
            recs.delete(k);
            for (const id of r.ids) if (byIdMap.get(id) === r) byIdMap.delete(id);
        }
    }
    if (!recs.size && sweeper) { clearInterval(sweeper); sweeper = null; }
}
function keep(r: CallRecord): CallRecord {
    recs.set(r.key, r);
    if (!sweeper) { sweeper = setInterval(() => sweep(), 60_000); sweeper.unref?.(); }
    return r;
}

/** The record for a key: an existing one (number keys only within two minutes), or a new one. */
export function forKey(key: string, windowed = false, now: () => number = Date.now): CallRecord {
    if (windowed) {
        for (const r of recs.values()) if (r.key.startsWith(`${key}@`) && now() - r.firstAt < WINDOW_MS) return r;
        return keep(new CallRecord(`${key}@${now()}`, now));
    }
    return recs.get(key) || keep(new CallRecord(key, now));
}

/** An incoming-call announcement: the record it belongs to, with the event on it. */
export function announcement(type: string, id: string, headers: { name: string; value: string }[], x: { missionId?: string; callbackDigits?: string; digits?: string }): CallRecord {
    const k = legKey(headers, { id, ...x });
    const r = byIdMap.get(id) || forKey(k.key, k.windowed);
    const first = !r.ids.length;
    r.addId(id);
    byIdMap.set(id, r);
    if (x.missionId) r.set({ direction: "outbound-mission", missionId: x.missionId });
    else if (x.callbackDigits) r.set({ direction: "callback" });
    const tail = x.callbackDigits || x.digits;
    if (tail) r.set({ tail: `…${tail.slice(-4)}` });
    r.ev("webhook", `${type} ${id}`);
    if (first) r.ev("sip headers", headerNames(headers));
    return r;
}

/** The record for a call by any of its ids; one is started for a call that
 *  had no announcement (a browser test, Grok). */
export function ensure(id: string, init: Partial<Pick<CallRecord, "direction" | "model" | "chatId" | "name" | "business" | "missionId" | "test">> = {}): CallRecord {
    let r = byIdMap.get(id);
    if (!r) { r = forKey(`id:${id}`); r.addId(id); byIdMap.set(id, r); r.ev("started", init.direction || ""); }
    return r.set(init as any);
}
export function byId(id: string): CallRecord | undefined { return byIdMap.get(id); }

/** Gepetel rang a business (voiceOutbound.ts): the record starts here. */
export function missionPlaced(m: { id: string; chatId: string; author?: string; business_name: string; test?: boolean }, ok: boolean, detail: string): void {
    try {
        const r = forKey(`mission:${m.id}`).set({ direction: "outbound-mission", missionId: m.id, chatId: m.chatId, name: m.author || "", business: m.business_name, test: !!m.test });
        r.rung = ok;
        if (ok) r.ev("mission rung", detail);
        else { r.rungFailed = `Twilio: ${oneLine(detail, 500)}`; r.ev("mission ring failed", detail); r.end([], 0); }
        r.flush();
    } catch (e: any) { console.error(`[voice] call log for mission ${m.id}: ${errLine(e, 300)}`); }
}

/** Gepetel rang someone back (voice.ts callBack): the record the leg will join. */
export function callbackRung(digits: string, ts: number, chatId: string, ok: boolean, detail: string): void {
    try {
        const r = forKey(`cb:${digits}:${ts}`).set({ direction: "callback", chatId, tail: `…${digits.slice(-4)}` });
        r.rung = ok;
        if (ok) r.ev("callback rung", detail);
        else { r.rungFailed = `Twilio: ${oneLine(detail, 500)}`; r.ev("callback ring failed", detail); r.end([], 0); }
        r.flush();
    } catch (e: any) { console.error(`[voice] call log for a call-back: ${errLine(e, 300)}`); }
}

/** How a call to a business went (app.ts missionDone), onto its record. */
export function missionOutcome(id: string, o: { reached: boolean; done: boolean; summary: string; [k: string]: any }): void {
    const r = recs.get(`mission:${id}`);
    if (r) { r.missionOutcome = o; r.ev("mission outcome", `reached=${o.reached} done=${o.done}`); r.flush(); return; }
    if (mongoose.connection.readyState !== 1) return;
    CallLog.updateOne({ key: `mission:${id}` }, { $set: { missionOutcome: o } }).catch((e: any) => console.error(`[voice] call log outcome ${id}: ${errLine(e, 300)}`));
}

/** A day's calls, oldest first, as report rows. */
export async function dayRows(day: string, tz = "Europe/Bucharest"): Promise<ReportRow[]> {
    const b = dayBounds(day, tz);
    if (!b) return [];
    const docs: any[] = await CallLog.find({ startedAt: { $gte: b.from, $lt: b.to } }).sort({ startedAt: 1 }).lean();
    // Records still in memory are fresher than what was last written.
    const mem = new Map([...recs.values()].filter(r => r.firstAt >= b.from.getTime() && r.firstAt < b.to.getTime()).map(r => [r.key, r.doc()]));
    const out = docs.map(d => mem.get(d.key) || d);
    for (const [k, d] of mem) if (!docs.some(x => x.key === k)) out.push(d);
    return out.sort((a, z) => new Date(a.startedAt).getTime() - new Date(z.startedAt).getTime()).map(d => toRow(d, tz));
}

/** The day's summary, once a day: true if this caller should send it. */
export async function claimDigest(day: string): Promise<boolean> {
    if (mongoose.connection.readyState !== 1) return false;
    try { await CallDigest.create({ day }); return true; }
    catch (e: any) { if (e?.code === 11000) return false; throw e; }
}

/** For the tests: forget every record. */
export function _reset(): void { recs.clear(); byIdMap.clear(); if (sweeper) clearInterval(sweeper); sweeper = null; }
export function _sweep(now: number): void { sweep(now); }

export default { oneLine, errLine, legKey, headerNames, classify, qualityGrade, dayBounds, localDay, dayBefore, digestDay, toRow, summaryLine, renderReport, CallRecord, forKey, announcement, ensure, byId, missionPlaced, callbackRung, missionOutcome, dayRows, claimDigest, CallLog, CallDigest, _reset, _sweep };
