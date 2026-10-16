// One file per browse job, kept on this Mac for a daily look back (the
// owner, 2026-10-14: "for each desktop job we should log extensively locally
// and then, once a day, look at what happened, how we handled things and
// implement improvement opportunities").
//
// ~/Library/Logs/Gepetel/jobs/<YYYY-MM-DD>/<job>.log: every line the job
// writes to the Mac's log (its browser calls, steps, notes, timings — already
// without typed text or addresses' query strings), then a summary at the end:
// the goal, how it ended, the answer, steps, model calls, tokens, seconds.
// What a page said can be in an answer: these files stay on the Mac, readable
// by the person only, and go after 30 days.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const KEEP_DAYS = 30;

export function jobsDir(): string {
    return process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Logs", "Gepetel", "jobs")
        : path.join(os.homedir(), ".config", "gepetel", "jobs");
}

export class JobLog {
    readonly file: string;
    private t0 = Date.now();

    constructor(jobId: string, dir = jobsDir(), now = new Date()) {
        const day = path.join(dir, now.toISOString().slice(0, 10));
        try { fs.mkdirSync(day, { recursive: true, mode: 0o700 }); } catch { /* the line still goes to the Mac's log */ }
        this.file = path.join(day, `${(jobId || `job-${now.getTime()}`).replace(/[^\w.-]/g, "_")}.log`);
        JobLog.prune(dir, now);
    }

    line(text: string): void {
        try { fs.appendFileSync(this.file, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 }); } catch { /* best effort */ }
    }

    /** The end of the job, in one block a reader can find. */
    summary(s: { goal: string; startUrl?: string; ok: boolean; answer: string; steps?: number; calls?: number; tokens?: number; cached?: number; recipe?: string }): void {
        this.line(`=== summary ${JSON.stringify({ ...s, seconds: Math.round((Date.now() - this.t0) / 1000) })}`);
    }

    /** Days older than KEEP_DAYS go. */
    static prune(dir: string, now = new Date()): void {
        try {
            const cutoff = new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
            for (const d of fs.readdirSync(dir)) if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
        } catch { /* nothing yet */ }
    }
}
