// What works, counted across everyone: "to get parcel updates, most people
// connect their email" (the owner, 2026-11-08). Not anyone's steps — counts.
//
// After each private turn a small model files the request under one of a FIXED
// list of kinds (no free text ever reaches the counts), says whether they got
// what they asked for, and which missing connection would have answered it.
// What the turn used (email, calendar, their computer, the web) comes from its
// own steps, not from the model. One row per kind and person, the person only
// as a salted hash: how many times they got it done, with what, and what they
// lacked when they didn't.
//
// Read back two ways: a few lines in a 1:1 reply about connections THIS person
// hasn't got (numbers only once MIN_PEOPLE are behind a kind — before that, how
// Gepetel works, said as such), and the line a capability nudge may use.
import crypto from "node:crypto";
import mongoose from "mongoose";
import type { Tracer } from "./playbooks.js";

export const KINDS = {
    parcel: "where an order or parcel is",
    bill: "bills, invoices, what they owe",
    appointment: "what's on their schedule, meetings, appointments",
    travel: "flights, hotels, trips they booked",
    mail: "finding, sending or answering an email",
    account: "something inside an online account of theirs (bank, utility, subscription, shop)",
    document: "a file, contract or form of theirs",
    shopping: "finding or comparing something to buy",
    info: "general questions, news, weather, sports, facts",
    other: "some other request",
    none: "no request: chat, thanks, small talk",
} as const;
export type Kind = keyof typeof KINDS;
export const CAPS = ["email", "calendar", "computer", "web"] as const;
export type Cap = typeof CAPS[number];
/** What a connection is called in a line they read (the model translates). */
const CAP_WORDS: Record<Cap, string> = { email: "their email", calendar: "their calendar", computer: "their computer (the Gepetel Mac app)", web: "web search" };

/** Kinds whose counts are worth showing (not chat, not "other"). */
const COUNTED: Kind[] = ["parcel", "bill", "appointment", "travel", "mail", "account", "document", "shopping"];
/** How Gepetel works, before there are numbers: what each kind needs. */
export const PRIORS: Partial<Record<Kind, Cap[]>> = {
    parcel: ["email"], bill: ["email", "computer"], appointment: ["calendar"], travel: ["email", "calendar"],
    mail: ["email"], account: ["computer"], document: ["email", "computer"], shopping: ["computer"],
};
export const MIN_PEOPLE = 20, SHARE = 0.5, KEEP_DAYS = 365;

const zero = () => ({ email: 0, calendar: 0, computer: 0, web: 0 });
const worksSchema = new mongoose.Schema({
    kind: { type: String, required: true },
    who: { type: String, required: true },
    got: { type: Number, default: 0 },
    missed: { type: Number, default: 0 },
    with: { type: Object, default: zero },
    lacked: { type: Object, default: zero },
    at: { type: Date, default: Date.now },
});
worksSchema.index({ kind: 1, who: 1 }, { unique: true });
worksSchema.index({ at: 1 }, { expireAfterSeconds: KEEP_DAYS * 24 * 3600 });
export const WhatWorks = mongoose.models.WhatWorks || mongoose.model("WhatWorks", worksSchema);

/** The person as the counts know them: a hash nothing outside can be joined on. */
export function who(chatId: string): string {
    const salt = process.env.STATS_SALT || process.env.CRON_SECRET || "gepetel-what-works";
    return crypto.createHmac("sha256", salt).update(chatId).digest("hex").slice(0, 20);
}

/** What a turn used, from its own steps. */
export function capsUsed(tracer: Tracer): Cap[] {
    const used = new Set<Cap>();
    for (const s of tracer.steps) {
        const t = s.tool.toLowerCase();
        if (/^computer\.|^(browse|job|shell|fetch_url|send_file)$/.test(t)) used.add("computer");
        else if (/calendar|event/.test(t)) used.add("calendar");
        else if (/mail|inbox|thread|message|draft|outlook|proton/.test(t)) used.add("email");
        else if (/^(web_search|read_url)$/.test(t)) used.add("web");
    }
    return [...used];
}

/** What they have connected, from the connections line and their computer. */
export function capsHad(connected: string, hasComputer: boolean): Cap[] {
    const had: Cap[] = ["web"];
    if (/mail|inbox|outlook|proton/i.test(connected)) had.push("email");
    if (/calendar|agenda/i.test(connected)) had.push("calendar");
    if (hasComputer) had.push("computer");
    return had;
}

const KIND_SCHEMA = {
    type: "object", additionalProperties: false, required: ["kind", "got_it", "would_need"],
    properties: {
        kind: { type: "string", enum: Object.keys(KINDS) },
        got_it: { type: "boolean" },
        would_need: { type: "string", enum: ["email", "calendar", "computer", "none"] },
    },
};

const INSTRUCTIONS = [
    "You file one turn of a WhatsApp assistant's private chat. Answer with JSON only.",
    "kind — what they asked for, one of:",
    ...Object.entries(KINDS).map(([k, v]) => `- ${k}: ${v}`),
    "got_it — true only when the reply gave them what they asked (an answer, a done thing). A job started whose result is not in yet, a question back, \"I can't\": false.",
    "would_need — when they did NOT get it, and one of their own connections they don't have would have answered it (their email, their calendar, their computer), name it; otherwise none. A thing nobody's mailbox would hold is none.",
].join("\n");

/** Count one turn. Never throws, never waited for. */
export async function afterTurn(
    create: (req: any) => Promise<any>,
    chatId: string, asked: string, before: { from: string; text: string }[], tracer: Tracer, answer: string, had: Cap[],
): Promise<string> {
    try {
        if (!answer.trim() || mongoose.connection.readyState !== 1) return "skipped";
        const used = capsUsed(tracer);
        const res = await create({
            model: "gpt-5.6-luna",
            reasoning: { effort: "low" },
            instructions: INSTRUCTIONS,
            input: [{ role: "user", content: [
                "[Before]", ...before.slice(-4).map(h => `${h.from}: ${String(h.text).slice(0, 200)}`),
                "[They asked]", asked.slice(0, 600),
                `[Used] ${used.join(", ") || "nothing"} | [They have] ${had.join(", ")}`,
                "[Reply]", answer.slice(0, 600),
            ].join("\n") }],
            text: { format: { type: "json_schema", name: "kind", schema: KIND_SCHEMA, strict: true } },
            store: false,
        });
        const d = JSON.parse(res.output_text || "{}");
        const kind = String(d.kind) as Kind;
        if (!COUNTED.includes(kind)) return kind;
        const inc: any = {};
        if (d.got_it) { inc.got = 1; for (const c of used) inc[`with.${c}`] = 1; }
        else {
            inc.missed = 1;
            const need = String(d.would_need) as Cap;
            if (CAPS.includes(need) && !had.includes(need)) inc[`lacked.${need}`] = 1;
        }
        await WhatWorks.updateOne({ kind, who: who(chatId) }, { $inc: inc, $set: { at: new Date() } }, { upsert: true });
        return `${kind} ${d.got_it ? "got" : "missed"}`;
    } catch (e: any) {
        console.error("what-works count failed:", e?.message || e);
        return "failed";
    }
}

export type KindStats = { kind: Kind; people: number; gotPeople: number; withCap: Record<Cap, number>; lackedCap: Record<Cap, number> };

/** People per kind: how many, how many got it, with which, lacking which. */
export function tally(rows: any[]): KindStats[] {
    const by = new Map<string, KindStats>();
    for (const r of rows) {
        const s = by.get(r.kind) || { kind: r.kind, people: 0, gotPeople: 0, withCap: zero(), lackedCap: zero() };
        s.people++;
        if (r.got > 0) s.gotPeople++;
        for (const c of CAPS) {
            if ((r.with?.[c] || 0) > 0) s.withCap[c]++;
            if ((r.lacked?.[c] || 0) > 0) s.lackedCap[c]++;
        }
        by.set(r.kind, s);
    }
    return [...by.values()].sort((a, b) => b.people - a.people);
}

let cache: { at: number; stats: KindStats[] } | null = null;
export async function stats(): Promise<KindStats[]> {
    if (cache && Date.now() - cache.at < 3600_000) return cache.stats;
    if (mongoose.connection.readyState !== 1) return [];
    const rows = await WhatWorks.find({}, { kind: 1, got: 1, with: 1, lacked: 1 }).lean().catch(() => []);
    cache = { at: Date.now(), stats: tally(rows as any[]) };
    return cache.stats;
}

/** "8 in 10", from a share. */
const inTen = (share: number) => `${Math.max(1, Math.min(10, Math.round(share * 10)))} in 10`;

/** The lines for one person: per kind, the connections they lack that it
 *  works with — counted when enough people are behind it, else how it works. */
export function lines(all: KindStats[], had: Cap[]): string[] {
    const out: string[] = [];
    for (const kind of COUNTED) {
        const s = all.find(x => x.kind === kind);
        const missing = CAPS.filter(c => c !== "web" && !had.includes(c));
        if (!missing.length) break;
        if (s && s.people >= MIN_PEOPLE && s.gotPeople) {
            const best = missing.map(c => ({ c, share: s.withCap[c] / s.gotPeople })).filter(x => x.share >= SHARE).sort((a, b) => b.share - a.share)[0];
            if (best) { out.push(`- ${KINDS[kind]}: ${inTen(best.share)} people who got this done here had ${CAP_WORDS[best.c]} connected (counted).`); continue; }
        }
        const need = (PRIORS[kind] || []).filter(c => missing.includes(c));
        if (need.length) out.push(`- ${KINDS[kind]}: works best with ${need.map(c => CAP_WORDS[c]).join(" or ")} (how you work — no numbers).`);
    }
    return out;
}

/** The note for a 1:1 reply, or "" when they have everything. */
export async function note(had: Cap[]): Promise<string> {
    const l = lines(await stats().catch(() => []), had);
    if (!l.length) return "";
    return "\n\n[What works for requests like theirs — connections they don't have yet]\n" + l.join("\n")
        + "\nWhen they ask for one of these and you couldn't fully do it, do what you can, then offer that connection ONCE, leading with what they'd get. Say \"most people\" or give a number only for a line marked (counted); never make one up. Already offered it in this conversation, or they said no: leave it.";
}

/** For a capability nudge: the strongest counted line about this connection, or "". */
export async function othersLine(cap: Cap): Promise<string> {
    const all = await stats().catch(() => []);
    const best = all.filter(s => COUNTED.includes(s.kind) && s.people >= MIN_PEOPLE && s.gotPeople)
        .map(s => ({ s, share: s.withCap[cap] / s.gotPeople })).filter(x => x.share >= SHARE).sort((a, b) => b.share - a.share)[0];
    return best ? `${inTen(best.share)} people who ask about ${KINDS[best.s.kind]} and get it done here have ${CAP_WORDS[cap]} connected.` : "";
}

export default { afterTurn, note, othersLine, stats, tally, lines, capsUsed, capsHad, who, KINDS, PRIORS, MIN_PEOPLE, WhatWorks };
