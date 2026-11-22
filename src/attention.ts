// One budget for everything he sends that nobody asked for.
//
// Five things write to people on their own — the "how did it go?" follow-ups,
// the check-ins over their mail and calendar, the "you could connect your
// mail" nudge, the hello to someone he only knows from a group, and the line
// that picks that hello back up. Each had its own limit and none knew about
// the others, so the limits added up: one person got nine follow-ups and
// about thirty check-ins in two weeks and answered one of them; another got
// thirty-five and answered three (2026-11). Each sender was inside its own
// rules. Nobody was counting from the side that matters, which is theirs.
//
// So there is one count per person, and it is of what THEY did with the last
// few: wrote back within a few hours, or didn't. Someone who answers hears
// from him as often as before. Someone who doesn't hears less and less — a
// day apart, then two, then a week — and it recovers the moment they start
// answering again. What they explicitly asked for (a parcel they wanted
// followed, a plan they said they are going to) is never held back and never
// counted against them: not answering "your parcel is out for delivery" is
// not a lack of interest.
import mongoose from "mongoose";

const schema = new mongoose.Schema({
    chat_id: { type: String, required: true, unique: true },
    sent: { type: [{ at: Date, kind: String, asked: Boolean, heard: Boolean, _id: false }], default: [] },
    // When he last offered to carry on by phone (app.ts, callOfferNote).
    call_offer_at: { type: Date, default: null },
}, { timestamps: true });
schema.index({ updatedAt: 1 }, { expireAfterSeconds: 365 * 24 * 3600 });
export const Attention = mongoose.models.Attention || mongoose.model("Attention", schema);

export type Sent = { at: Date; kind: string; asked?: boolean; heard?: boolean };

/** Writing back within this long counts as having been glad to hear it. */
export const HEARD_WITHIN_MS = 3 * 3600_000;
/** How many of the latest ones the judgement rests on, and how many it needs. */
export const LOOKS_AT = 8, NEEDS = 4;
export const KEEP = 30;

const H = 3600_000, D = 24 * H;
/** The pause between two unprompted messages, from how the last ones landed.
 *  Pure: `sent` oldest first, `now` for knowing which are still open. */
export function gapFor(sent: Sent[], now: Date = new Date()): { gapMs: number; why: string; rate: number | null } {
    // Only what they could have answered by now, and never what they asked for.
    const settled = (sent || []).filter(s => !s.asked && (s.heard || now.getTime() - new Date(s.at).getTime() > HEARD_WITHIN_MS)).slice(-LOOKS_AT);
    if (settled.length < NEEDS) return { gapMs: 20 * H, why: "not enough to go on yet: once a day", rate: null };
    const heard = settled.filter(s => s.heard).length;
    const rate = heard / settled.length;
    if (rate >= 0.5) return { gapMs: 2 * H, why: "they answer these", rate };
    if (rate >= 0.25) return { gapMs: 20 * H, why: "they answer some: once a day", rate };
    if (heard > 0) return { gapMs: 2 * D, why: "they rarely answer: every other day", rate };
    return { gapMs: 7 * D, why: `none of the last ${settled.length} answered: once a week`, rate };
}

/** May this go out now? `asked`: they explicitly asked to be told this. */
export function allowed(sent: Sent[], now: Date = new Date(), asked = false): { ok: boolean; why: string; nextAt?: Date } {
    if (asked) return { ok: true, why: "they asked for it" };
    const mine = (sent || []).filter(s => !s.asked);
    const last = mine.length ? new Date(mine[mine.length - 1].at).getTime() : 0;
    const { gapMs, why } = gapFor(sent, now);
    if (last && now.getTime() - last < gapMs) return { ok: false, why, nextAt: new Date(last + gapMs) };
    return { ok: true, why };
}

/** What has gone out to this chat unprompted, oldest first. The first time a
 *  chat is seen, its record is rebuilt from what was actually sent and what
 *  actually came back, so nobody starts over as a stranger. */
async function load(chatId: string): Promise<Sent[]> {
    const row: any = await Attention.findOne({ chat_id: chatId }).lean();
    if (row) return (row.sent || []).map((s: any) => ({ at: new Date(s.at), kind: String(s.kind || ""), asked: !!s.asked, heard: !!s.heard }));
    const seeded = await seed(chatId).catch(() => [] as Sent[]);
    await Attention.updateOne({ chat_id: chatId }, { $setOnInsert: { sent: seeded } }, { upsert: true }).catch(() => {});
    return seeded;
}

async function seed(chatId: string): Promise<Sent[]> {
    const db = mongoose.connection.db;
    if (!db) return [];
    const since = new Date(Date.now() - 30 * D);
    const out: Sent[] = [];
    for (const t of await db.collection("pulsetopics").find({ chat_id: chatId, raised_at: { $gte: since } }).toArray()) {
        if (t.raised_at) out.push({ at: new Date(t.raised_at), kind: "check-in", asked: t.track === "yes" || String(t.key || "").startsWith("follow:") });
    }
    for (const i of await db.collection("interactions").find({ chatId, action: { $in: ["follow-up", "growth-followup", "capability-nudge", "growth-opener"] } }).toArray()) {
        const at = i.createdAt || i.timestamp; if (at) out.push({ at: new Date(at), kind: String(i.action) });
    }
    out.sort((a, b) => a.at.getTime() - b.at.getTime());
    const theirs: any[] = await db.collection("messagearchives").find({ chatId, from: { $ne: "Gepetel" }, createdAt: { $gte: since } }).project({ createdAt: 1 }).toArray();
    const times = theirs.map(x => new Date(x.createdAt).getTime());
    for (const s of out) s.heard = times.some(t => t > s.at.getTime() && t - s.at.getTime() <= HEARD_WITHIN_MS);
    return out.slice(-KEEP);
}

/** May an unprompted message of this kind go to this chat now? */
export async function mayReach(chatId: string, kind: string, opts: { asked?: boolean } = {}, now: Date = new Date()): Promise<{ ok: boolean; why: string; nextAt?: Date }> {
    try {
        const verdict = allowed(await load(chatId), now, !!opts.asked);
        if (!verdict.ok) console.log(`[attention] ${chatId.slice(0, 6)}… ${kind} held — ${verdict.why}; next ${verdict.nextAt?.toISOString().slice(0, 16)}`);
        return verdict;
    } catch (e: any) {
        // A failed count must not turn into silence or into a flood: let the
        // sender's own limits decide, as they did before this existed.
        console.error("attention.mayReach failed:", e?.message || e);
        return { ok: true, why: "count unavailable" };
    }
}

/** It went out. */
export async function noteSent(chatId: string, kind: string, opts: { asked?: boolean } = {}, now: Date = new Date()): Promise<void> {
    try {
        await load(chatId);
        await Attention.updateOne({ chat_id: chatId }, { $push: { sent: { $each: [{ at: now, kind, asked: !!opts.asked, heard: false }], $slice: -KEEP } } }, { upsert: true });
    } catch (e: any) { console.error("attention.noteSent failed:", e?.message || e); }
}

/** They wrote: whatever went out in the last few hours was heard. */
export async function noteHeard(chatId: string, now: Date = new Date()): Promise<void> {
    try {
        await Attention.updateOne(
            { chat_id: chatId },
            { $set: { "sent.$[s].heard": true } },
            { arrayFilters: [{ "s.at": { $gte: new Date(now.getTime() - HEARD_WITHIN_MS) }, "s.heard": { $ne: true } }] },
        );
    } catch (e: any) { console.error("attention.noteHeard failed:", e?.message || e); }
}

/** May he offer a call now — has enough time passed since the last offer? */
export async function callOfferDue(chatId: string, everyMs: number, now: Date = new Date()): Promise<boolean> {
    const row: any = await Attention.findOne({ chat_id: chatId }, { call_offer_at: 1 }).lean();
    return !row?.call_offer_at || now.getTime() - new Date(row.call_offer_at).getTime() >= everyMs;
}
/** He offered. */
export async function noteCallOffer(chatId: string, now: Date = new Date()): Promise<void> {
    await Attention.updateOne({ chat_id: chatId }, { $set: { call_offer_at: now } }, { upsert: true });
}

/** For a look from outside: how this chat stands. */
export async function standing(chatId: string, now: Date = new Date()) {
    const sent = await load(chatId);
    return { ...gapFor(sent, now), ...allowed(sent, now), sent: sent.length, last: sent.filter(s => !s.asked).slice(-1)[0]?.at || null };
}

export default { mayReach, noteSent, noteHeard, standing, gapFor, allowed, callOfferDue, noteCallOffer, HEARD_WITHIN_MS };
