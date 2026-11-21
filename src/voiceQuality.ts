// How a call sounded and what the box was doing while it ran, so a choppy
// call can be pinned on the network, the voice provider, or the Pi
// (2026-11-17: "the audio breaks a bit — could be my Raspberry Pi?").
//
// Two halves:
//  - The browser test page reads WebRTC getStats() (or, for Grok, its own
//    playback counters) and posts a summary at the end. The pure functions it
//    uses are defined here and injected into the page with toString(), so the
//    page and the tests run the same code — keep them self-contained.
//  - The relay samples its own resources every 2 s while any call is live
//    (CPU, memory, event-loop lag, load, IO, pressure) and logs one
//    "[voice] quality" line per call, plus live warnings.
import fs from "fs";
import os from "os";
import { monitorEventLoopDelay } from "perf_hooks";

// ---------------------------------------------------------------- network --

/** Cumulative counters from one getStats() read of the inbound audio. */
export type RtcSample = {
    t: number;                 // ms
    rttMs?: number;            // current candidate-pair RTT
    packetsLost: number; packetsReceived: number;
    jitterMs: number;
    concealedSamples: number; totalSamples: number; concealmentEvents: number;
    inserted: number; removed: number;               // samples stretched/squeezed by the jitter buffer
    jbufDelay: number; jbufEmitted: number;          // seconds total, count
    cand?: string; net?: string;
};
export type NetWindow = { rttMs: number; lossPct: number; concealedPct: number; glitches: number; jbufMs: number; jitterMs: number; stretchPct: number };

/** What happened between two reads (or across the whole call: first, last). */
export function rtcWindow(a: RtcSample | null, b: RtcSample): NetWindow {
    const d = (k: keyof RtcSample) => Math.max(0, Number(b[k] || 0) - Number(a ? a[k] || 0 : 0));
    const lost = d("packetsLost"), got = d("packetsReceived");
    const total = d("totalSamples");
    const emitted = d("jbufEmitted");
    const r1 = (x: number) => Math.round(x * 10) / 10;
    return {
        rttMs: Math.round(Number(b.rttMs || 0)),
        lossPct: lost + got > 0 ? r1((lost / (lost + got)) * 100) : 0,
        concealedPct: total > 0 ? r1((d("concealedSamples") / total) * 100) : 0,
        glitches: d("concealmentEvents"),
        jbufMs: emitted > 0 ? Math.round((d("jbufDelay") / emitted) * 1000) : 0,
        jitterMs: Math.round(Number(b.jitterMs || 0)),
        stretchPct: total > 0 ? r1(((d("inserted") + d("removed")) / total) * 100) : 0,
    };
}

/** ok / warn / bad, by the worst of the signals that make speech break up. */
export function gradeNet(w: NetWindow): "ok" | "warn" | "bad" {
    const bad = w.rttMs > 400 || w.lossPct > 3 || w.concealedPct > 5 || w.jbufMs > 300 || w.jitterMs > 60;
    if (bad) return "bad";
    const warn = w.rttMs > 250 || w.lossPct > 1 || w.concealedPct > 2 || w.jbufMs > 150 || w.jitterMs > 30 || w.glitches > 3;
    return warn ? "warn" : "ok";
}

export function netLine(w: NetWindow): string {
    return `net: ${w.rttMs} ms RTT · loss ${w.lossPct}% · glitches ${w.glitches} (${w.concealedPct}% concealed) · jitter ${w.jitterMs} ms · jitter buffer ${w.jbufMs} ms`;
}

/** Mic level from an analyser's time-domain bytes: rms 0..1 and whether it clips. */
export function micLevel(bytes: ArrayLike<number>): { rms: number; clipping: boolean; silent: boolean } {
    let sum = 0, peak = 0;
    for (let i = 0; i < bytes.length; i++) { const v = (bytes[i] - 128) / 128; sum += v * v; peak = Math.max(peak, Math.abs(v)); }
    const rms = bytes.length ? Math.sqrt(sum / bytes.length) : 0;
    return { rms: Math.round(rms * 1000) / 1000, clipping: peak > 0.98, silent: rms < 0.005 };
}

/** Grok's audio comes through the relay as chunks: a gap mid-answer is an underrun. */
export function grokChunk(st: { lastAt: number; underruns: number; maxGapMs: number }, now: number, behindMs: number): void {
    const gap = st.lastAt ? now - st.lastAt : 0;
    // Gaps over 1.5 s are between answers, not inside one.
    if (gap < 1500) st.maxGapMs = Math.max(st.maxGapMs, Math.round(gap));
    // Playback had already run dry when this chunk arrived, in the middle of an answer.
    if (behindMs > 20 && gap > 0 && gap < 1500) st.underruns++;
    st.lastAt = now;
}

// ------------------------------------------------------------- resources --

export type ResSample = {
    cpuPct: number; rssMb: number; heapMb: number; lagMs: number;
    load1: number; freeMemMb: number;
    ioReadKBs: number; ioWriteKBs: number;
    psiCpu?: number; psiMem?: number; psiIo?: number;
};

export const RES_LIMITS = { cpuPct: 80, lagMs: 100, psiIo: 10 };

export function resourceWarnings(s: ResSample): string[] {
    const w: string[] = [];
    if (s.cpuPct > RES_LIMITS.cpuPct) w.push(`cpu ${s.cpuPct}%`);
    if (s.lagMs > RES_LIMITS.lagMs) w.push(`event-loop lag ${s.lagMs} ms`);
    if ((s.psiIo ?? 0) > RES_LIMITS.psiIo) w.push(`io pressure ${s.psiIo}`);
    return w;
}

type Agg = { avg: number; max: number };
export function summarizeResources(samples: ResSample[]): Record<keyof ResSample, Agg> | null {
    if (!samples.length) return null;
    const keys: (keyof ResSample)[] = ["cpuPct", "rssMb", "heapMb", "lagMs", "load1", "freeMemMb", "ioReadKBs", "ioWriteKBs", "psiCpu", "psiMem", "psiIo"];
    const out: any = {};
    for (const k of keys) {
        const vals = samples.map(s => s[k]).filter((v): v is number => typeof v === "number" && isFinite(v));
        if (!vals.length) continue;
        const r1 = (x: number) => Math.round(x * 10) / 10;
        out[k] = { avg: r1(vals.reduce((a, b) => a + b, 0) / vals.length), max: r1(Math.max(...vals)) };
    }
    return out;
}

export function resourceLine(r: ReturnType<typeof summarizeResources>): string {
    if (!r) return "pi=(no samples)";
    const f = (k: keyof ResSample, label: string, unit = "") => r[k] ? `${label}=${r[k].avg}/${r[k].max}${unit}` : "";
    return ["pi:", f("cpuPct", "cpu", "%"), f("lagMs", "lag", "ms"), f("load1", "load"), f("rssMb", "rss", "MB"), f("freeMemMb", "free", "MB"),
        f("ioReadKBs", "ioR", "KB/s"), f("ioWriteKBs", "ioW", "KB/s"), f("psiCpu", "psiCpu"), f("psiMem", "psiMem"), f("psiIo", "psiIo")].filter(Boolean).join(" ") + " (avg/max)";
}

/** "some avg10=1.23 ..." → 1.23 */
export function psiAvg10(text: string): number | undefined {
    const m = /^some\s+avg10=([\d.]+)/m.exec(text || "");
    return m ? Number(m[1]) : undefined;
}

/** /proc/self/io → storage bytes read/written. */
export function procIo(text: string): { read: number; write: number } | undefined {
    const r = /^read_bytes:\s*(\d+)/m.exec(text || ""), w = /^write_bytes:\s*(\d+)/m.exec(text || "");
    return r && w ? { read: Number(r[1]), write: Number(w[1]) } : undefined;
}

const readOr = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };

// One sampler for the whole process, running only while a call is live.
type Active = { id: string; model: string; startedAt: number; samples: ResSample[]; errors: string[]; rateLimits: number; events: number };
const active = new Map<string, Active>();
let timer: NodeJS.Timeout | null = null;
let lagHist: ReturnType<typeof monitorEventLoopDelay> | null = null;
let prev: { at: number; cpu: NodeJS.CpuUsage; io?: { read: number; write: number } } | null = null;
let latest: (ResSample & { at: number }) | null = null;
const SAMPLE_MS = 2000;

function sample(): void {
    const now = Date.now();
    const cpu = process.cpuUsage();
    const io = procIo(readOr("/proc/self/io"));
    const mem = process.memoryUsage();
    const secs = prev ? (now - prev.at) / 1000 : 0;
    const cpuPct = prev && secs > 0 ? Math.round(((cpu.user - prev.cpu.user + cpu.system - prev.cpu.system) / 1e6 / secs) * 1000) / 10 : 0;
    const lagMs = lagHist ? Math.round(lagHist.max / 1e6) : 0;
    lagHist?.reset();
    const s: ResSample = {
        cpuPct, lagMs,
        rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576),
        load1: Math.round(os.loadavg()[0] * 100) / 100, freeMemMb: Math.round(os.freemem() / 1048576),
        ioReadKBs: prev?.io && io && secs > 0 ? Math.round((io.read - prev.io.read) / 1024 / secs) : 0,
        ioWriteKBs: prev?.io && io && secs > 0 ? Math.round((io.write - prev.io.write) / 1024 / secs) : 0,
        psiCpu: psiAvg10(readOr("/proc/pressure/cpu")), psiMem: psiAvg10(readOr("/proc/pressure/memory")), psiIo: psiAvg10(readOr("/proc/pressure/io")),
    };
    const first = !prev;
    prev = { at: now, cpu, io };
    if (first) return;            // the first read is only a baseline
    latest = { ...s, at: now };
    for (const a of active.values()) a.samples.push(s);
    const warn = resourceWarnings(s);
    if (warn.length) console.warn(`[voice] resource warning (${[...active.keys()].join(",")}): ${warn.join(", ")}`);
}

function startSampler(): void {
    if (timer) return;
    lagHist = monitorEventLoopDelay({ resolution: 10 });
    lagHist.enable();
    prev = null;
    sample();
    timer = setInterval(sample, SAMPLE_MS);
    timer.unref?.();
}
function stopSampler(): void {
    if (timer) clearInterval(timer);
    timer = null;
    lagHist?.disable();
    lagHist = null;
    prev = null;
    latest = null;
}

/** The latest resource sample, for the test page while a call runs. */
export function current(): (ResSample & { at: number }) | null { return active.size ? latest : null; }

export type ClientReport = { model?: string; net?: NetWindow & { cand?: string; netType?: string }; grok?: { underruns: number; maxGapMs: number; wsBacklogMax: number }; mic?: { clippingPct: number; silentPct: number } };

export function clientLine(c: ClientReport | undefined): string {
    if (!c) return "client=(none)";
    const parts: string[] = [];
    if (c.net) parts.push(`rtt=${c.net.rttMs}ms loss=${c.net.lossPct}% concealed=${c.net.concealedPct}% glitches=${c.net.glitches} jitter=${c.net.jitterMs}ms jbuf=${c.net.jbufMs}ms stretch=${c.net.stretchPct}% cand=${c.net.cand || "?"}${c.net.netType ? "/" + c.net.netType : ""} grade=${gradeNet(c.net)}`);
    if (c.grok) parts.push(`underruns=${c.grok.underruns} maxGap=${c.grok.maxGapMs}ms wsBacklog=${c.grok.wsBacklogMax}B`);
    if (c.mic) parts.push(`micClip=${c.mic.clippingPct}% micSilent=${c.mic.silentPct}%`);
    return parts.join(" ") || "client=(empty)";
}

/** A call starts: sample while it runs; the returned handle logs its line at the end. */
export function begin(id: string, model: string) {
    const a: Active = { id, model, startedAt: Date.now(), samples: [], errors: [], rateLimits: 0, events: 0 };
    active.set(id, a);
    startSampler();
    let ended = false;
    return {
        event(ev: any) {
            a.events++;
            if (ev?.type === "error") a.errors.push(String(ev.error?.code || ev.error?.type || ev.error?.message || "error").slice(0, 60));
            else if (ev?.type === "rate_limits.updated") a.rateLimits++;
        },
        /** The call is over: stop sampling it; `report` (test page) may be merged in later. */
        end(sink?: (q: { model: string; secs: number; net?: any; grok?: ClientReport["grok"]; errors: string[]; rateLimitEvents: number; events: number; pi: ReturnType<typeof summarizeResources> }) => void): (client?: ClientReport) => void {
            if (ended) return () => {};
            ended = true;
            active.delete(id);
            if (!active.size) stopSampler();
            const res = summarizeResources(a.samples);
            const secs = Math.round((Date.now() - a.startedAt) / 1000);
            const server = `errors=${a.errors.length}${a.errors.length ? "(" + [...new Set(a.errors)].join(",") + ")" : ""} rateLimitEvents=${a.rateLimits} events=${a.events}`;
            let logged = false;
            return (client?: ClientReport) => {
                if (logged) return;
                logged = true;
                console.log(`[voice] quality ${id} model=${client?.model || a.model} ${secs}s ${clientLine(client)} ${server} ${resourceLine(res)}`);
                // The same numbers as data, for the call's record (callLog.ts).
                try { sink?.({ model: client?.model || a.model, secs, net: client?.net ? { ...client.net, grade: gradeNet(client.net) } : undefined, grok: client?.grok, errors: [...a.errors], rateLimitEvents: a.rateLimits, events: a.events, pi: res }); } catch { /* never the call's problem */ }
            };
        },
    };
}

// Test calls: the page posts its half after hanging up; wait a little for it.
const pending = new Map<string, { log: (c?: ClientReport) => void; timer: NodeJS.Timeout }>();
export function awaitClient(key: string, log: (c?: ClientReport) => void, ms = 15_000): void {
    const old = pending.get(key);
    if (old) { clearTimeout(old.timer); old.log(); }
    const t = setTimeout(() => { pending.delete(key); log(); }, ms);
    t.unref?.();
    pending.set(key, { log, timer: t });
}
/** The page's report arrived: merge into the waiting line, or log it alone. */
export function clientReport(key: string, c: ClientReport): void {
    const p = pending.get(key);
    if (p) { clearTimeout(p.timer); pending.delete(key); p.log(c); return; }
    // The page can beat the relay's own end (e.g. it hung up first): hold it briefly.
    early.set(key, { c, at: Date.now() });
}
const early = new Map<string, { c: ClientReport; at: number }>();
/** At the end of a test call: use a report that came first, or wait for it. */
export function finishTest(key: string, log: (c?: ClientReport) => void): void {
    const e = early.get(key);
    early.delete(key);
    if (e && Date.now() - e.at < 30_000) { log(e.c); return; }
    awaitClient(key, log);
}

export default { rtcWindow, gradeNet, netLine, micLevel, grokChunk, resourceWarnings, summarizeResources, resourceLine, psiAvg10, procIo, clientLine, begin, current, awaitClient, clientReport, finishTest, RES_LIMITS };
