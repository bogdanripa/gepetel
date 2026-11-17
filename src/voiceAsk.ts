// A question asked on a phone call (voice.ts ask_gepetel) is a normal 1:1 turn,
// with someone waiting on the line. What a typed turn can afford, a call can't:
// on 2026-11-17 an Attio lookup took 25.9 s, 3.2 s of it before the model had
// even opened a connector, and it wandered into a scheduled task and a place
// lookup nobody asked for. So for a call, and only a call:
//   - what the turn reads about them (memory, contacts, connectors, computer)
//     is read once and kept for the call, not re-read for every question;
//   - the connectors' tool lists the first answer fetched are handed back to
//     the next one, so OpenAI doesn't reconnect and re-list each time ("as long
//     as the mcp_list_tools item is present in the context of the model, we
//     will not attempt to pull a refreshed list of tools");
//   - no waiting for typing (nobody types on a call), no second look at a
//     draft that announced work, less reasoning, and a rule to do only what
//     was asked.
// A WhatsApp reply is unchanged.

/** How long what a call read about them is reused: a call, with gaps between questions. */
export const VOICE_CTX_TTL_MS = 3 * 60_000;

export type VoiceCtx<T> = { at: number; value: T; listed: any[] };

/** Still the same call? Each use pushes the expiry out. */
export function fresh(at: number, now: number, ttl = VOICE_CTX_TTL_MS): boolean {
    return now >= at && now - at < ttl;
}

/** The connector tool lists a response fetched — the items worth handing back. */
export function listedTools(output: any[] | undefined): any[] {
    return (output || []).filter((i: any) => i?.type === "mcp_list_tools" && !i.error && Array.isArray(i.tools));
}

/** Merge newly fetched lists into the kept ones: one per connector, newest wins. */
export function keepListed(kept: any[], fetched: any[]): any[] {
    const by = new Map<string, any>();
    for (const i of [...kept, ...fetched]) by.set(String(i.server_label || ""), i);
    return [...by.values()];
}

/** Only the lists for connectors this turn still offers, as input items. */
export function listedFor(kept: any[], tools: any[]): any[] {
    const labels = new Set(tools.filter((t: any) => t?.type === "mcp").map((t: any) => String(t.server_label || "")));
    return kept.filter(i => labels.has(String(i.server_label || "")))
        .map(i => ({ type: "mcp_list_tools", id: i.id, server_label: i.server_label, tools: i.tools }));
}

/** What a call's question is told on top of the chat's rules. */
export const ON_A_CALL = "\n\n[On a phone call] Someone is waiting on the line for this answer. Do only what they asked on this call: no side tasks — no scheduled tasks, no place lookups, no remembering things, no follow-ups — unless they asked for it. Go straight to the one lookup or action that answers them, and answer in a few short sentences.";

export default { VOICE_CTX_TTL_MS, fresh, listedTools, keepListed, listedFor, ON_A_CALL };
