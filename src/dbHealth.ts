// The database's health, as pure decisions (GEP-69). mongo.ts owns the socket
// and the timers; everything here takes the clock as an argument so the rules
// can be tested without a database or a wait.
//
// Why this exists: mongoose does not retry a failed *initial* connect. On
// 2026-11-02 Atlas SRV DNS answered ESERVFAIL at boot, the one attempt failed,
// and for ~11h every query buffered and timed out while /api/health said 200 —
// so nothing restarted a process that a retry would have healed in seconds.

/** How long the process may run without a database before it gives up and
 *  exits, so the container's restart policy starts a fresh one. Also the point
 *  at which /api/health turns 503. Long enough that a deploy is never rolled
 *  back because Atlas was slow for a few seconds. */
export const DB_GRACE_MS = 120_000;

const BACKOFF_FIRST_MS = 2_000;
const BACKOFF_CAP_MS = 30_000;

/** Delay before retry number `failures` (1 = after the first failure):
 *  2s, 4s, 8s, 16s, then 30s for good. */
export function backoffDelay(failures: number): number {
    const n = Math.max(1, Math.floor(failures));
    return Math.min(BACKOFF_CAP_MS, BACKOFF_FIRST_MS * 2 ** Math.min(n - 1, 20));
}

/** mongoose's readyState: 1 is the only "connected". */
const CONNECTED = 1;

/** When the database went away, given what it was and what it is now: null
 *  while connected, otherwise the first moment it was seen not connected. */
export function nextDownSince(prev: number | null, readyState: number, now: number): number | null {
    if (readyState === CONNECTED) return null;
    return prev ?? now;
}

export interface DbAssessment {
    /** /api/health answers 200 when true, 503 when false. */
    healthy: boolean;
    /** The process should exit now. */
    exit: boolean;
    /** How long it has been without a database, 0 while connected. */
    downForMs: number;
}

/** The health/exit decision. Connected, or disconnected for no more than the
 *  grace period: healthy. Past it: unhealthy, and time to exit. */
export function assessDb(downSince: number | null, now: number, graceMs: number = DB_GRACE_MS): DbAssessment {
    if (downSince == null) return { healthy: true, exit: false, downForMs: 0 };
    const downForMs = Math.max(0, now - downSince);
    const over = downForMs > graceMs;
    return { healthy: !over, exit: over, downForMs };
}

/** An error message safe to log or send: any connection string in it (which
 *  carries the password) is replaced. The driver's messages normally name only
 *  the host, but a parse error can echo the URL it was given. */
export function redactDbError(message: unknown): string {
    return String(message ?? "")
        .replace(/mongodb(\+srv)?:\/\/\S+/gi, "<database url>")
        .slice(0, 500);
}

export default { DB_GRACE_MS, backoffDelay, nextDownSince, assessDb, redactDbError };
