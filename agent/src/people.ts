// People's details, for jobs (Phase 9, asked for by the owner on 2026-10-14:
// "my wife's passport info, my son's ID details"). The Gepetel app keeps them,
// encrypted, the key in the Keychain; the agent asks it for one value at the
// moment of typing it, and never keeps it. The model sees placeholders only —
// ‹Ana: passport number› — and types those; the Mac puts the value in.
//
// Asked in one `@people {json}` line on stdout, answered with one
// `{"t":"people-done", …}` line on stdin (as osInput.ts). Only under the app.

import { appChannel } from "./appChannel.js";

export type PersonInfo = { name: string; relation: string; labels: string[] };
type Req = { op: "list" } | { op: "value"; person: string; label: string } | { op: "set"; person: string; relation?: string; label: string; value: string } | { op: "forget"; person: string; label?: string };
type Res = { ok: boolean; why: string; people?: PersonInfo[]; value?: string };

const channel = appChannel<Req, Res>({ tag: "people", done: "people-done", idPrefix: "p", timeoutMs: 10_000,
    read: msg => {
        const people = Array.isArray(msg.people) ? msg.people.slice(0, 50).map((p: any) => ({ name: String(p?.name || "").slice(0, 60), relation: String(p?.relation || "").slice(0, 40), labels: Array.isArray(p?.labels) ? p.labels.slice(0, 40).map((l: any) => String(l).slice(0, 60)) : [] })) : undefined;
        return { ok: msg.ok === true, why: String(msg.why || ""), ...(people ? { people } : {}), ...(typeof msg.value === "string" ? { value: msg.value } : {}) };
    } });

export const enablePeople = channel.enable;
export const peopleAvailable = channel.available;
/** One request; the app logs the op only, never a value. */
export const askPeople = channel.ask;
/** A line from the app on stdin: true when it was an answer to us. */
export const peopleAnswer = channel.answer;

/** The placeholder the model sees and types for one value. */
export function placeholder(person: string, label: string): string { return `‹${person}: ${label}›`; }

/** Placeholders in a text: [whole, person, label]. */
export function placeholdersIn(text: string): { whole: string; person: string; label: string }[] {
    return [...text.matchAll(/‹([^:‹›]{1,60}):\s*([^‹›]{1,60})›/g)].map(m => ({ whole: m[0], person: m[1].trim(), label: m[2].trim() }));
}

/** What the model is told: whose details exist and which — never a value. */
export function peopleLine(people: PersonInfo[]): string {
    if (!people.length) return "";
    return people.map(p => `- ${p.name}${p.relation ? ` (${p.relation})` : ""}: ${p.labels.map(l => placeholder(p.name, l)).join(", ")}`).join("\n");
}

/** A text with its placeholders filled in, by asking the app for each value.
 *  Unknown ones stay as they are (and the caller refuses to type them). */
export async function fill(text: string, get: (person: string, label: string) => Promise<string | null>): Promise<{ text: string; missing: string[]; filled: string[] }> {
    let out = text;
    const missing: string[] = [], filled: string[] = [];
    for (const p of placeholdersIn(text)) {
        const v = await get(p.person, p.label);
        if (v == null) { missing.push(p.whole); continue; }
        out = out.split(p.whole).join(v);
        filled.push(p.whole);
    }
    return { text: out, missing, filled };
}
