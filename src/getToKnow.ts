// Getting to know them, in a private chat (the owner, 2026-11-08, after
// Instinct's onboarding): a personal assistant learns what fills someone's
// days, then offers one concrete thing it could take off their hands — and the
// connection (email, calendar) that makes it work. More connected, more it
// knows, more reasons to talk, more actually useful.
//
// Paths (prompts/dm-get-to-know.txt): kids and school, work, a home project,
// travel, bills, lists, orders, family groups — each from an easy question to a
// concrete thing to do, and the connection it needs (email and calendar first,
// then the tools they live in: Notion, Jira, Todoist, their computer…). On in
// every private chat except one Gepetel opened himself (growth-warmup has its
// own rules); with mail and calendar connected it only builds on what it knows. "Not now" pauses it for
// PAUSE_DAYS (not_now_connecting), so nobody is asked twice in a conversation.
import mongoose from "mongoose";
import p from "./prompts.js";
import type { Cap } from "./whatWorks.js";

const schema = new mongoose.Schema({
    chat_id: { type: String, required: true, unique: true },
    paused_until: { type: Date, default: null },
    pauses: { type: Number, default: 0 },
}, { timestamps: true });
export const GetToKnow = mongoose.models.GetToKnow || mongoose.model("GetToKnow", schema);

export const PAUSE_DAYS = 21;

export const NOT_NOW_TOOL = {
    type: "function",
    name: "not_now_connecting",
    description: "They don't want to connect anything or answer more about themselves right now (\"not now\", \"later\", short or busy). Stops getting-to-know-you questions and connection offers for a few weeks.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: false,
};

export async function paused(chatId: string, now = new Date()): Promise<boolean> {
    if (mongoose.connection.readyState !== 1) return true;   // no state, no pushing
    const row: any = await GetToKnow.findOne({ chat_id: chatId }).lean().catch(() => null);
    return !!row?.paused_until && new Date(row.paused_until) > now;
}

export async function pause(chatId: string, now = new Date()): Promise<void> {
    await GetToKnow.updateOne({ chat_id: chatId },
        { $set: { paused_until: new Date(now.getTime() + PAUSE_DAYS * 24 * 3600_000) }, $inc: { pauses: 1 } }, { upsert: true });
}

/** Where this is: the first hello, early on, or well under way. */
export function stage(history: { from: string; text: string }[], known: number, name: string): string {
    const saidAnything = history.some(h => h.from === "Gepetel");
    if (!saidAnything && !known) {
        const first = name ? ` Their WhatsApp name is "${name}" — greet them by the part they'd be called, or by no name if it isn't clear.` : "";
        return `This is the first time they write to you.${first} Say hi by name, in one line who you are (Gepetel, their assistant here in WhatsApp — and in their groups, if they add you), that you'd like to get to know them a little first, like any new assistant would, then the first easy question: what fills most of their days (kids, work, a home project? a word is enough). Two to four short messages, split with [[next]]. If their first message already asks for something, help with that instead and leave all this for later.`;
    }
    if (known < 3) return "You've only just started: you know very little about them yet. Keep getting to know them, one easy question at a time, towards one concrete thing you could do.";
    return "You know a little about them already (see \"What you know about them\"). Don't interview them: build on it — the next concrete thing you could do, and the connection it needs, when the conversation gives you a reason.";
}

const CAP_NAMES: Record<string, string> = { email: "their email", calendar: "their calendar", computer: "their computer", web: "" };

/** The block for a 1:1 reply, or "" when it doesn't apply. */
export async function block(chatId: string, had: Cap[], opts: { outreach: boolean; history: { from: string; text: string }[]; known: number; name: string }): Promise<string> {
    if (opts.outreach) return "";
    if (await paused(chatId)) return "";
    const named = had.map(c => CAP_NAMES[c]).filter(Boolean);
    return "\n\n" + p.loadPrompt("dm-get-to-know", {
        stage: stage(opts.history, opts.known, opts.name),
        had: named.length ? `${named.join(", ")} (and whatever is listed under "Connected services" — don't offer those again)` : "nothing yet",
    });
}

/** "[[next]]" between short messages: split for a private chat. At most
 *  MAX_BUBBLES; anything beyond joins the last. */
export const MAX_BUBBLES = 4;
export function bubbles(text: string): string[] {
    const parts = text.split(/\s*\[\[next\]\]\s*/i).map(s => s.trim()).filter(Boolean);
    if (parts.length <= MAX_BUBBLES) return parts.length ? parts : [text.trim()].filter(Boolean);
    return [...parts.slice(0, MAX_BUBBLES - 1), parts.slice(MAX_BUBBLES - 1).join("\n\n")];
}


// A connect link nobody used (the owner, 2026-11-08, after Instinct did it):
// once, LINK_UNUSED_MS later, if the login never happened and they haven't
// written since, come back — not about the link, but with what can be done
// for what they wanted without it (the school's public calendar), and one
// question that moves it on. In-process: a restart forgets it, which costs
// one nudge at most.
export const LINK_UNUSED_MS = 12 * 60_000;
type Unused = (chatId: string, label: string) => Promise<unknown>;
let onUnused: Unused | null = null;
const watching = new Set<string>();
/** app.ts says what to do when a link went unused. */
export function whenLinkUnused(fn: Unused): void { onUnused = fn; }
/** A connect link just went out in a private chat. */
export function watchLink(chatId: string, state: string, label: string, deps = {
    used: async (s: string) => !!(await (await import("./mongo.js")).default.mcpOAuthDone(s)),
    wroteSince: async (c: string, t: number) => (await import("./turn.js")).default.heardSince(c, t),
    after: LINK_UNUSED_MS,
}): void {
    if (!state || watching.has(chatId)) return;
    watching.add(chatId);
    const sent = Date.now();
    setTimeout(async () => {
        watching.delete(chatId);
        try {
            if (await deps.used(state) || await deps.wroteSince(chatId, sent) || !onUnused) return;
            console.log(`Connect link for ${label} unused in ${chatId}: coming back with what can be done without it.`);
            await onUnused(chatId, label);
        } catch (e: any) { console.error(`unused link in ${chatId}:`, e?.message || e); }
    }, deps.after).unref?.();
}

export default { block, pause, paused, stage, bubbles, NOT_NOW_TOOL, PAUSE_DAYS, GetToKnow, watchLink, whenLinkUnused, LINK_UNUSED_MS };
