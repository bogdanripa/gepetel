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
export const ON_A_CALL = "\n\n[On a phone call] Someone is waiting on the line for this answer. Do only what they asked on this call: no side tasks — no scheduled tasks, no place lookups, no remembering things, no follow-ups — unless they asked for it. Go straight to the one lookup or action that answers them, and answer in a few short sentences. Quick is not giving up: when the first place has nothing, look in the next one where it would be before you say you can't find it — a flight, a booking, a ticket or a delivery that isn't in their calendar is in their mail. Never ask them to send you something you can look for yourself.";

// ---------------------------------------------------------------------------
// One request at a time on a call.
//
// The voice hands a request off the moment it hears one, and people keep
// talking: they finish the sentence, repeat the question, react to what he
// just said. Each of those used to start an answer of its own, side by side —
// on 2026-11-25 one question about a design deal was answered twice, half a
// minute apart, with two different amounts. So a request that arrives while
// another is being answered waits for it, and is then asked knowing what was
// just said: something new in it gets its own short answer; a reaction or
// the same question again gets none.

/** What an answer says when the request that waited added nothing. */
export const NOTHING_NEW = "NOTHING";
export function isNothingNew(answer: string): boolean {
    return /^\W*nothing\W*$/i.test(String(answer || "").trim());
}
/** What a request that waited behind another is told. */
export function overlapNote(earlier: string, answer: string): string {
    return `[They said the request below while you were still finding the answer to what they asked just before it. Just before, they asked: «${earlier.trim().slice(0, 500)}». You answered: «${answer.trim().slice(0, 1200)}» — that is being said to them right now. If the request below asks for something that answer does not cover, answer ONLY that part, briefly. If it is a reaction, a remark, impatience ("are you there?", "can you hear me?", "this is taking long"), the same question again or in other words, or already covered by that answer, reply with the single word ${NOTHING_NEW} and do nothing else: the answer they are hearing is the reply to it, and saying any of it again would be saying it twice.]`;
}
/** What the voice is told when a request that waited added nothing. */
export const NOTHING_TO_ADD = "(Nothing to add: the answer you have just given already covers this. Say nothing more about it — don't repeat it, don't say you looked again. Carry on listening.)";

/** What the voice is told when the answer comes in after they said goodbye. */
export const SAID_GOODBYE = "(They said goodbye while you were looking. Don't start on the answer now. Say goodbye in a few words; if they still want it, they'll ask you in the chat.)";

export type AskLine = {
    busy(): boolean;
    /** `ask` gets the note about what was just answered ("" when nothing was running). "" comes back when there was nothing new. */
    run(request: string, ask: (also: string) => Promise<string>): Promise<string>;
};
export function askLine(): AskLine {
    let tail: Promise<unknown> = Promise.resolve();
    let running = 0;
    let last: { request: string; answer: string } | null = null;
    return {
        busy: () => running > 0,
        async run(request, ask) {
            const waited = running > 0;
            running++;
            const mine = tail.then(async () => {
                const also = waited && last ? overlapNote(last.request, last.answer) : "";
                const answer = await ask(also);
                if (also && isNothingNew(answer)) return "";
                last = { request, answer };
                return answer;
            });
            tail = mine.catch(() => {});
            try { return await mine; } finally { running--; }
        },
    };
}

export default { VOICE_CTX_TTL_MS, fresh, listedTools, keepListed, listedFor, ON_A_CALL, NOTHING_NEW, isNothingNew, overlapNote, NOTHING_TO_ADD, SAID_GOODBYE, askLine };
