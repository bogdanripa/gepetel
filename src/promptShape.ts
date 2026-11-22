// How a reply's prompt is laid out when it is sent, and why.
//
// 1. What every chat shares goes in `instructions`, alone. The prompt cache
//    matches that block whole or not at all: measured on the live API
//    (2026-11-22), two people's requests whose 12k-token instructions differed
//    only in their LAST line shared nothing, while the same instructions with
//    different messages under them shared 12,272 of 12,361 tokens. The private
//    prompt used to name the person in its first line; 12% of input was cached.
//
// 2. What is this chat's own — who they are, the hour, what is kept about
//    them, their language, the rules a group set — goes in the conversation
//    as a developer message, just before the message being answered. Placed
//    first it is folded back into the instructions and the cache is lost
//    again; placed there it kept its authority in every test.
//
// 3. The instructions are sent again on every later round of the same reply.
//    They are NOT carried over with previous_response_id — so until now the
//    line written after any tool call was written with no prompt at all: no
//    voice, no rules, no language. The small model half-remembered; the large
//    one answered a Romanian question in English. A new person's first message
//    was once answered "You're right, I didn't actually perform any action…
//    WhatsApp, Telegram, Slack?" from exactly such a round.
export const CHAT_MARKS = ["\n[This chat]\n", "\n[This group]\n"];

/** The instructions split in two: what all chats share, and this chat's own. */
export function splitInstructions(instructions: string): { shared: string; own: string } {
    const text = String(instructions || "");
    const cuts = CHAT_MARKS.map(m => text.indexOf(m)).filter(i => i >= 0);
    if (!cuts.length) return { shared: text, own: "" };
    const at = Math.min(...cuts);
    return { shared: text.slice(0, at), own: text.slice(at + 1) };
}

/** The part to send as `instructions` — on the first round and every later one. */
export function sharedInstructions(instructions: string): string {
    return splitInstructions(instructions).shared;
}

/** A request as it should go out. Requests without a per-chat part, or
 *  already shaped, pass through untouched. */
export function shaped<T extends { instructions?: any; input?: any }>(req: T): T {
    if (!req || typeof req.instructions !== "string") return req;
    if (!Array.isArray(req.input) && typeof req.input !== "string") return req;
    const { shared, own } = splitInstructions(req.instructions);
    if (!own) return req;
    const input: any[] = typeof req.input === "string" ? [{ role: "user", content: req.input }] : [...req.input];
    // Before the last thing they said. With nothing before that it would lead
    // the conversation and be folded into the instructions, so the cache is
    // lost for that one call — a first message, where there is nothing to
    // share yet anyway.
    let at = -1;
    for (let i = input.length - 1; i >= 0; i--) if (input[i]?.role === "user") { at = i; break; }
    input.splice(Math.max(0, at), 0, { role: "developer", content: own });
    return { ...req, instructions: shared, input };
}

export default { shaped, splitInstructions, sharedInstructions, CHAT_MARKS };
