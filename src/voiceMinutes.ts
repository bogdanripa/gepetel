// Call time for everyone who isn't family.
//
// The family (VOICE_CALLERS) calls without limits and is answered directly.
// Everyone else who already talks to Gepetel 1:1 gets VOICE_FREE_MINUTES (5)
// minutes of calls a day, counted on the Bucharest day, and is never answered
// on their caller ID — a caller ID can be spoofed, and a call reads out mail —
// but rung back on their real number instead. When the day's minutes are used
// up they get one WhatsApp note a day with the payment link, the same
// checkout the group limit uses (website/pay.html?calls=1): one extension per
// person, "on the house", like the group one.

import mongoose from "mongoose";

const minutesSchema = new mongoose.Schema({
    chatId: { type: String, required: true, unique: true },
    day: { type: String, default: "" },              // Bucharest "YYYY-MM-DD" usedSeconds belongs to
    usedSeconds: { type: Number, default: 0 },
    extraMinutes: { type: Number, default: 0 },      // per day, from the one paid extension
    freeExtensionUsed: { type: Boolean, default: false },
    extensionEmail: { type: String, default: "" },
    limitNoticeDay: { type: String, default: "" },   // the day the "used up" note last went out
}, { timestamps: true });
export const VoiceMinutes = mongoose.models.VoiceMinutes || mongoose.model("VoiceMinutes", minutesSchema);

export const DAY_TZ = "Europe/Bucharest";
export const EXTENSIONS = [15, 30, 60];
/** Seconds before the end of today's time when the call is told to wrap up. */
export const WRAP_UP_S = 30;

/** "YYYY-MM-DD" of `now` in Bucharest — the day the free minutes belong to. */
export function bucharestDay(now: Date = new Date()): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: DAY_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function freeMinutes(env: Record<string, string | undefined> = process.env): number {
    const n = Number(env.VOICE_FREE_MINUTES);
    return Number.isFinite(n) && n >= 0 && env.VOICE_FREE_MINUTES !== "" && env.VOICE_FREE_MINUTES !== undefined ? n : 5;
}

type Doc = { day?: string; usedSeconds?: number; extraMinutes?: number } | null | undefined;

/** Seconds of call time left today. A stored day that isn't today counts as nothing used. */
export function remainingSeconds(doc: Doc, today: string, free: number): number {
    const allowance = Math.max(0, (free + (doc?.extraMinutes || 0)) * 60);
    const used = doc?.day === today ? Math.max(0, doc?.usedSeconds || 0) : 0;
    return Math.max(0, Math.floor(allowance - used));
}

/** A call's length as it is counted: whole seconds, rounded up. */
export function billedSeconds(startedAt: Date, endedAt: Date): number {
    return Math.max(0, Math.ceil((endedAt.getTime() - startedAt.getTime()) / 1000));
}

/** When a limited call is told to wrap up, and when it ends — ms from its start. */
export function callTimers(limitS: number | undefined, maxMinutes: number): { wrapAtMs: number | null; endAtMs: number } {
    const maxMs = Math.max(1, maxMinutes) * 60_000;
    if (limitS === undefined || limitS === null || !Number.isFinite(limitS)) return { wrapAtMs: null, endAtMs: maxMs };
    const endAtMs = Math.min(maxMs, Math.max(0, limitS) * 1000);
    if (endAtMs >= maxMs) return { wrapAtMs: null, endAtMs: maxMs };
    // Short on time: half of what's left, so there's still a goodbye.
    const wrapAtMs = endAtMs > 2 * WRAP_UP_S * 1000 ? endAtMs - WRAP_UP_S * 1000 : Math.floor(endAtMs / 2);
    return { wrapAtMs, endAtMs };
}

export type CallRoute =
    | { route: "answer"; limited: false }
    | { route: "answer"; limited: true; remainingS: number }
    | { route: "callback"; remainingS: number }
    | { route: "limit-note" }
    | { route: "reject"; why: string };

/**
 * What to do with a call — every input already looked up.
 * `family`: on VOICE_CALLERS. `signedLeg`: the call is our own call-back,
 * proven by the signed x- headers, so the number is really theirs.
 */
export function routeCall(x: { digits: string; family: boolean; knownUser: boolean; signedLeg: boolean; free: number; remainingS: number }): CallRoute {
    if (!x.digits) return { route: "reject", why: "no caller number" };
    if (x.family) return { route: "answer", limited: false };
    if (!x.knownUser) return { route: "reject", why: "no 1:1 chat with this number" };
    if (x.free <= 0 && x.remainingS <= 0) return { route: "reject", why: "calls are family-only (VOICE_FREE_MINUTES=0)" };
    if (x.remainingS <= 0) return { route: "limit-note" };
    // A caller ID isn't proof: they are rung back on their real number.
    return x.signedLeg ? { route: "answer", limited: true, remainingS: x.remainingS } : { route: "callback", remainingS: x.remainingS };
}

/** The checkout for more call minutes. */
export function payLink(base: string, chatId: string): string {
    return `${base}/pay.html?calls=1&userId=${encodeURIComponent(chatId)}`;
}

// --- Mongo ----------------------------------------------------------------

export async function remaining(chatId: string, env: Record<string, string | undefined> = process.env, now: Date = new Date()): Promise<number> {
    const doc: any = await VoiceMinutes.findOne({ chatId }).lean();
    return remainingSeconds(doc, bucharestDay(now), freeMinutes(env));
}

/** Add a finished call's seconds to today's count; what is left after it. */
export async function addUsage(chatId: string, seconds: number, env: Record<string, string | undefined> = process.env, now: Date = new Date()): Promise<number> {
    const today = bucharestDay(now);
    const s = Math.max(0, Math.ceil(seconds));
    // New day: start the count over (only one writer matches the stale-day filter).
    await VoiceMinutes.updateOne({ chatId, day: { $ne: today } }, { $set: { day: today, usedSeconds: 0 } }, { upsert: false });
    await VoiceMinutes.updateOne({ chatId }, { $setOnInsert: { day: today }, $inc: { usedSeconds: s } }, { upsert: true });
    return remaining(chatId, env, now);
}

/** True once per Bucharest day: whether the "used up" note may go out now. */
export async function claimLimitNotice(chatId: string, now: Date = new Date()): Promise<boolean> {
    const today = bucharestDay(now);
    const r = await VoiceMinutes.updateOne({ chatId, limitNoticeDay: { $ne: today } }, { $set: { limitNoticeDay: today } }, { upsert: false });
    if (r.modifiedCount) return true;
    // No row yet (they never called): create it with today's notice.
    try {
        await VoiceMinutes.create({ chatId, day: today, limitNoticeDay: today });
        return true;
    } catch { return false; }
}

/** The one extension: +N minutes a day, once per person (like a group's). */
export async function extendOnce(chatId: string, add: number, email: string = ""): Promise<{ alreadyUsed?: boolean; perDay?: number }> {
    const doc: any = await VoiceMinutes.findOne({ chatId }).lean();
    if (doc?.freeExtensionUsed) return { alreadyUsed: true };
    if (!doc) {
        try { await VoiceMinutes.create({ chatId, day: bucharestDay() }); } catch { /* raced */ }
    }
    const r = await VoiceMinutes.updateOne(
        { chatId, freeExtensionUsed: { $ne: true } },
        { $inc: { extraMinutes: add }, $set: { freeExtensionUsed: true, extensionEmail: email } },
    );
    if (!r.modifiedCount) return { alreadyUsed: true };
    const after: any = await VoiceMinutes.findOne({ chatId }).lean();
    return { perDay: freeMinutes() + (after?.extraMinutes || 0) };
}

export default { VoiceMinutes, DAY_TZ, EXTENSIONS, WRAP_UP_S, bucharestDay, freeMinutes, remainingSeconds, billedSeconds, callTimers, routeCall, payLink, remaining, addUsage, claimLimitNotice, extendOnce };
