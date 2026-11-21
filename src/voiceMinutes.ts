// Call time, per person — no list of numbers in config.
//
// Everyone who already talks to Gepetel 1:1 gets VOICE_FREE_MINUTES (5)
// minutes of calls a day, counted on the Bucharest day; a person's plan can
// set their own daily minutes instead (higher for the family). Nobody is
// unlimited. A plan marked `direct` is answered on their caller ID and may
// send Gepetel to phone businesses; anyone else is never answered on their
// caller ID — it can be spoofed, and a call reads out mail — but rung back
// on their real number instead. When the day's minutes are used up they get
// one WhatsApp note a day with the payment link, the same checkout the group
// limit uses (website/pay.html?calls=1): one extension per person, "on the
// house", like the group one.

import mongoose from "mongoose";

const minutesSchema = new mongoose.Schema({
    chatId: { type: String, required: true, unique: true },
    day: { type: String, default: "" },              // Bucharest "YYYY-MM-DD" usedSeconds belongs to
    usedSeconds: { type: Number, default: 0 },
    extraMinutes: { type: Number, default: 0 },      // per day, from the one paid extension
    freeExtensionUsed: { type: Boolean, default: false },
    extensionEmail: { type: String, default: "" },
    limitNoticeDay: { type: String, default: "" },   // the day the "used up" note last went out
    dailyMinutes: { type: Number, default: null },   // their own daily allowance; null = VOICE_FREE_MINUTES
    direct: { type: Boolean, default: false },       // trusted: answered on their caller ID, may phone businesses
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

type Doc = { day?: string; usedSeconds?: number; extraMinutes?: number; dailyMinutes?: number | null; direct?: boolean } | null | undefined;

/** Their own daily minutes, or the default when their plan doesn't set any. */
export function dailyOf(doc: Doc, free: number): number {
    const d = doc?.dailyMinutes;
    return typeof d === "number" && Number.isFinite(d) && d >= 0 ? d : free;
}

/** Minutes a day in all: their daily minutes plus the paid extension. */
export function perDayOf(doc: Doc, free: number): number {
    return dailyOf(doc, free) + (doc?.extraMinutes || 0);
}

/** Seconds of call time left today. A stored day that isn't today counts as nothing used.
 *  `free` is the default daily minutes, used when their plan sets none. */
export function remainingSeconds(doc: Doc, today: string, free: number): number {
    const allowance = Math.max(0, perDayOf(doc, free) * 60);
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
    | { route: "answer"; limited: true; remainingS: number }
    | { route: "callback"; remainingS: number }
    | { route: "limit-note" }
    | { route: "reject"; why: string };

/**
 * What to do with a call — every input already looked up.
 * `direct`: their plan trusts their caller ID. `signedLeg`: the call is our
 * own call-back, proven by the signed x- headers, so the number is really
 * theirs. `free`: this person's daily minutes (0 = calls are off for them).
 */
export function routeCall(x: { digits: string; direct: boolean; knownUser: boolean; signedLeg: boolean; free: number; remainingS: number }): CallRoute {
    if (!x.digits) return { route: "reject", why: "no caller number" };
    if (!x.knownUser) return { route: "reject", why: "no 1:1 chat with this number" };
    if (x.remainingS <= 0) return x.free > 0 || x.direct ? { route: "limit-note" } : { route: "reject", why: "calls are off" };
    // A caller ID isn't proof unless their plan says so: otherwise they are rung back on their real number.
    return x.direct || x.signedLeg ? { route: "answer", limited: true, remainingS: x.remainingS } : { route: "callback", remainingS: x.remainingS };
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
    return { perDay: perDayOf(after, freeMinutes()) };
}

export type Plan = { direct: boolean; dailyMinutes: number; extraMinutes: number; remainingS: number };

/** Someone's call plan as it applies today. */
export async function plan(chatId: string, env: Record<string, string | undefined> = process.env, now: Date = new Date()): Promise<Plan> {
    const doc: any = await VoiceMinutes.findOne({ chatId }).lean();
    const free = freeMinutes(env);
    return { direct: !!doc?.direct, dailyMinutes: dailyOf(doc, free), extraMinutes: doc?.extraMinutes || 0, remainingS: remainingSeconds(doc, bucharestDay(now), free) };
}

/** A valid daily allowance: null (the default) or whole minutes, at most a day. */
export function validDailyMinutes(v: unknown): boolean {
    return v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1440);
}

/** Set someone's plan (only the fields given). */
export async function setPlan(chatId: string, p: { dailyMinutes?: number | null; direct?: boolean }, env: Record<string, string | undefined> = process.env): Promise<Plan> {
    if (!/^\d{8,15}@s\.whatsapp\.net$/.test(chatId)) throw new Error("bad chatId");
    const set: Record<string, any> = {};
    if (p.dailyMinutes !== undefined) {
        if (!validDailyMinutes(p.dailyMinutes)) throw new Error("dailyMinutes must be null or a whole number 0..1440");
        set.dailyMinutes = p.dailyMinutes;
    }
    if (p.direct !== undefined) {
        if (typeof p.direct !== "boolean") throw new Error("direct must be true or false");
        set.direct = p.direct;
    }
    if (Object.keys(set).length) await VoiceMinutes.updateOne({ chatId }, { $set: set, $setOnInsert: { day: bucharestDay() } }, { upsert: true });
    return plan(chatId, env);
}

export default { VoiceMinutes, DAY_TZ, EXTENSIONS, WRAP_UP_S, bucharestDay, freeMinutes, dailyOf, perDayOf, remainingSeconds, billedSeconds, callTimers, routeCall, payLink, remaining, addUsage, claimLimitNotice, extendOnce, plan, validDailyMinutes, setPlan };
