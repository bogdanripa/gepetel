// GEP-114: the list form of DM set_reminder. "Remind me an hour before each"
// over a two-week schedule (2026-11-19) set 6 reminders of ~22, and the reply
// said they were all set. One call now carries the whole schedule; the plan is
// pure (util.planReminders), and this is the I/O around it, injected so the
// handler path can be exercised against a real database without a model.
//
// What the model is told comes from the numbers here, never from its own
// account: how many are pending now, the first and last, and every skip.
import u from "./util.js";
import type { ReminderAsk, ReminderSkipReason } from "./util.js";

export type ReminderListDeps = {
    /** This chat's future reminders, uncapped (m.pendingReminders). */
    pending: (chatId: string) => Promise<{ reminder_id: string; title: string; due_date: Date | string }[]>;
    /** m.toolFunctions.create_reminder. */
    create: (r: { chat_id: string; title: string; due_date: Date; is_individual: boolean; phone_number: string | null; by_call?: boolean }) => Promise<any>;
    /** voice.canCallThem, already bound to the minutes lookup. Called at most once. */
    canCall: (chatId: string) => Promise<{ called: boolean; why?: string }>;
    now?: () => Date;
};
export type SetNowItem = { at: Date; what: string; already?: true };
export type SkippedNowItem = { what: string; at: string; reason: ReminderSkipReason };

/** "2026-11-20 15:00" on their clock. */
export function localStamp(d: Date, timezone: string): string {
    try { return new Intl.DateTimeFormat("sv-SE", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d); }
    catch { return localStamp(d, "UTC"); }
}

const CALL_YES = "At that time you will phone them on this number and say it; the reminder is also written here. Say so in a few words (\"te sun mâine la 9\").";
const callNo = (why: string) => `You can NOT phone them (${why}). The reminder is set as a written one in this chat: tell them that plainly, do not promise a call.`;

/** The items of a list-form call: `items`, with a top-level what/at added as the first. */
export function listAsks(args: any): ReminderAsk[] | null {
    const items = Array.isArray(args?.items) ? args.items : null;
    if (!items || !items.length) return null;
    const head = args.what != null || args.at != null ? [{ what: args.what, at: args.at, by_call: args.by_call }] : [];
    return [...head, ...items];
}

export async function setReminderList(asks: ReminderAsk[], o: { chatId: string; timezone: string; setNow: SetNowItem[]; skippedNow: SkippedNowItem[] }, deps: ReminderListDeps) {
    const now = deps.now ? deps.now() : new Date();
    const pending = await deps.pending(o.chatId);
    const plan = u.planReminders(asks, { timezone: o.timezone, now, pending });
    // One verdict for the whole call: the same chat, the same moment.
    const wantsCall = plan.create.some(c => c.by_call);
    const callable = wantsCall ? await deps.canCall(o.chatId) : null;
    const canRing = !!callable?.called || callable?.called === false && callable.why === "already on a call with them";

    const results: any[] = [];
    const skipped: { i: number; what: string; at: string; reason: ReminderSkipReason }[] = [...plan.skipped];
    const createdIds = new Map<number, string>();
    const pendingAt: Date[] = [];
    let created = 0;
    for (const c of plan.create) {
        const byCall = c.by_call && canRing;
        try {
            const row: any = await deps.create({ chat_id: o.chatId, title: c.what, due_date: c.at, is_individual: false, phone_number: null, by_call: byCall });
            created++;
            createdIds.set(c.i, String(row?.reminder_id || ""));
            pendingAt.push(c.at);
            o.setNow.push({ at: c.at, what: `${byCall ? "📞 " : ""}${String(row?.title || c.what)}` });
            results.push({ i: c.i, status: "created", reminder_id: row?.reminder_id, at: localStamp(c.at, o.timezone), at_iso: c.at.toISOString(), what: row?.title || c.what,
                ...(c.by_call ? (byCall ? { by_call: true, call: CALL_YES } : { by_call: false, call: callNo(callable && !callable.called ? String(callable.why || "unavailable") : "unavailable") }) : {}) });
        } catch (e: any) {
            console.error(`set_reminder list: item ${c.i} could not be saved:`, e?.message || e);
            skipped.push({ i: c.i, what: c.what, at: localStamp(c.at, o.timezone), reason: "not_saved" });
        }
    }
    let already = 0;
    for (const a of plan.already) {
        // An in-call duplicate points at the item that created it; if that one
        // failed to save, this copy is not pending either.
        const ref = a.reminder_id.startsWith("item:") ? createdIds.get(Number(a.reminder_id.slice(5))) : a.reminder_id;
        if (!ref) { skipped.push({ i: a.i, what: a.what, at: localStamp(a.at, o.timezone), reason: "not_saved" }); continue; }
        already++;
        pendingAt.push(a.at);
        o.setNow.push({ at: a.at, what: a.what, already: true });
        results.push({ i: a.i, status: "already_set", reminder_id: ref, at: localStamp(a.at, o.timezone), what: a.what });
    }
    for (const s of skipped) {
        o.skippedNow.push({ what: s.what, at: s.at, reason: s.reason });
        results.push({ i: s.i, status: "skipped", reason: s.reason, what: s.what, at: s.at });
    }
    results.sort((a, b) => a.i - b.i);
    const times = pendingAt.map(d => d.getTime()).sort((a, b) => a - b);
    const set = created + already;
    const first = times.length ? localStamp(new Date(times[0]), o.timezone) : null;
    const last = times.length ? localStamp(new Date(times[times.length - 1]), o.timezone) : null;
    const tell = [
        `State the count (${set}) and the range (${first ?? "none"} → ${last ?? "none"}) from these numbers.`,
        "Name every skipped item and why, and ask about the ones without a clear time by name.",
        "The exact list is added under your message by the system — don't write it.",
        ...(skipped.length ? [`Do NOT say all/toate/every one — ${skipped.length} were not set.`] : []),
    ].join(" ");
    return { set, created, already_set: already, skipped_count: skipped.length, first, last, results, tell_the_user: tell };
}

export default { setReminderList, listAsks, localStamp };
