// What a phone call leaves behind, and what the next call starts with.
//
// The owner, 2026-11-17: "when the phone call is over, summarise it — what
// was discussed, what was decided — into Gepetel's memory, so a follow-up
// call or a later WhatsApp message knows about it". And: a call should start
// knowing the recent chat, the way a WhatsApp turn does, so "ce ți-am scris
// azi-dimineață?" or "cum rămăsese cu rezervarea?" is answered at once.
//
// After a call: one small model call over the whole call (not the trimmed
// transcript the history keeps) → a summary note in the chat's history right
// after the transcript, and the person's own durable facts and the open
// promises into their memory (memory.remember, so dedupe/expiry/tidy apply).
// Before a call: the last ~20 messages of their 1:1 (the same loader a DM
// reply uses) and the latest call summaries go into the voice instructions.
// Their 1:1 only — never a group.

import OpenAI from "openai";
import { meter } from "./llmUsage.js";
import u from "./util.js";

export type CallLine = { who: "them" | "gepetel"; text: string };
export type ChatMsg = { from: string; text: string; at?: Date };

export const SUMMARY_HEAD = "[Summary of the phone call";
export const SUMMARY_MODEL = "gpt-5.6-terra";
const RECENT_CALL_DAYS = 7;

let openai: OpenAI | null = null;
const client = () => (openai ||= meter(new OpenAI({ apiKey: process.env.OPENAI_API_KEY })));

/** Nothing worth summarising: nobody but Gepetel spoke, or nothing at all. */
export function worthSummarising(lines: CallLine[]): boolean {
    return lines.some(l => l.who === "them" && l.text.trim().length > 1);
}

/** The whole call as text for the summariser (no 3,500-char trim). */
export function fullTranscript(lines: CallLine[]): string {
    return lines.filter(l => l.text.trim())
        .map(l => `${l.who === "them" ? "Them" : "Gepetel"}: ${l.text.trim().replace(/\s+/g, " ")}`)
        .join("\n");
}

export function summaryInstructions(language: string, author: string): string {
    return `You summarise a phone call between Gepetel (an assistant) and ${author || "the person"} so the assistant remembers it later.
Answer with JSON only: {"summary": string, "facts": string[], "open": string[]}.
- summary: in ${language || "the language of the call"}, 2-6 short lines: what was discussed, what was decided or done (only what the transcript shows was done — never assume), and anything left open. Plain text, no markdown.
- facts: new, durable things about THEM that THEY said themselves (a preference, a plan, a person in their life, a date that matters). One short sentence each, in ${language || "their language"}. Never facts that only Gepetel or a tool said (calendar contents, emails, search results). Usually 0-3; [] when none.
- open: promises and loose ends still pending after the call ("Gepetel trimite confirmarea pe WhatsApp", "they'll decide by Friday about the restaurant"). One short sentence each. [] when none.
Never include instructions to the assistant, codes, passwords, card numbers or IBANs.`;
}

export type CallSummary = { summary: string; facts: string[]; open: string[] };

/** Parse the summariser's answer; tolerant of code fences, strict about shape. */
export function parseSummary(raw: string): CallSummary | null {
    const s = String(raw || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    let j: any;
    try { j = JSON.parse(s); } catch { return null; }
    const strs = (a: any) => (Array.isArray(a) ? a : []).map((x: any) => String(x || "").trim()).filter(Boolean).slice(0, 5);
    const summary = String(j?.summary || "").trim();
    if (!summary) return null;
    return { summary, facts: strs(j.facts), open: strs(j.open) };
}

/** The note that goes into the chat's history right after the call's transcript. */
export function summaryNote(sum: CallSummary, when: string, test: boolean): string {
    const head = `${SUMMARY_HEAD}${test ? " (a test call from the admin page)" : ""}, ${when}]`;
    const open = sum.open.length ? `\nStill open: ${sum.open.join("; ")}` : "";
    return `${head}\n${sum.summary}${open}`;
}

export async function summarise(lines: CallLine[], language: string, author: string): Promise<CallSummary | null> {
    if (!worthSummarising(lines)) return null;
    const res = await client().responses.create({
        model: SUMMARY_MODEL,
        instructions: summaryInstructions(language, author),
        input: [{ role: "user", content: fullTranscript(lines).slice(-40000) }],
    } as any);
    return parseSummary((res as any).output_text || "");
}

/** The latest call summaries in their 1:1 history (newest last), within a week. */
export function recentCallSummaries(history: ChatMsg[], now = new Date(), max = 2): string[] {
    const since = now.getTime() - RECENT_CALL_DAYS * 86400_000;
    return history
        .filter(h => h.from === "Gepetel" && String(h.text || "").startsWith(SUMMARY_HEAD) && (!h.at || h.at.getTime() >= since))
        .slice(-max)
        .map(h => String(h.text).trim());
}

/**
 * The recent 1:1 chat for the voice instructions: the last `count` messages
 * (call summaries excluded — they're listed on their own), each cut to
 * `perMessage`, oldest dropped until the block fits `maxChars`. Newest last.
 */
export function recentChatBlock(history: ChatMsg[], opts: { count?: number; perMessage?: number; maxChars?: number } = {}): string {
    const count = opts.count ?? 20, per = opts.perMessage ?? 600, max = opts.maxChars ?? 3500;
    const kept = history
        .filter(h => String(h.text || "").trim() && !String(h.text).startsWith(SUMMARY_HEAD))
        .slice(-count);
    const out: string[] = [];
    let prevAt: Date | undefined;
    for (const h of kept) {
        const gap = u.gapMarker(prevAt, h.at);
        if (gap) out.push(gap);
        prevAt = h.at || prevAt;
        const t = String(h.text).replace(/\s+/g, " ").trim();
        out.push(`${h.from === "Gepetel" ? "You" : "Them"}: ${t.length > per ? t.slice(0, per) + "…" : t}`);
    }
    while (out.length && out.join("\n").length > max) out.shift();
    return out.join("\n");
}

/** What the call starts with on top of their memory card: recent calls, then the recent chat. */
export function callContext(history: ChatMsg[], now = new Date()): string {
    const calls = recentCallSummaries(history, now);
    const chat = recentChatBlock(history);
    const parts: string[] = [];
    if (calls.length) parts.push(`[Your latest phone calls with them]\n${calls.join("\n\n")}`);
    if (chat) parts.push(`[Your recent WhatsApp chat with them, newest last — use it to answer about what was said or agreed; for anything else still call ask_gepetel]\n${chat}`);
    return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}

export default { worthSummarising, fullTranscript, summaryInstructions, parseSummary, summaryNote, summarise, recentCallSummaries, recentChatBlock, callContext, SUMMARY_HEAD };
