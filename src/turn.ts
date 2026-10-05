// A reply that is still being written can still change its mind.
//
// Generating an answer is not instant: the model thinks, calls a tool, reads the
// result, thinks again. People do not wait for that. Someone adds "and Ana is
// coming too" two seconds after the question, and the old behaviour was to treat
// it as a separate event — a second parallel run, blind to the first, racing it
// to the group. Two answers, sometimes contradictory, sometimes in the wrong
// order.
//
// So a chat has at most one live turn, and a message arriving while that turn is
// open is handed to it rather than answered on its own. The turn folds it into
// its next model round, which is exactly what a person does when you add
// something while they are halfway through replying.
//
// Everything here is synchronous on purpose. Node runs one thing at a time, so a
// synchronous check-and-push cannot interleave with the loop closing the turn:
// `offerToTurn` either lands before `closeTurn` or returns false. No locks, and
// no window where a message is accepted by a turn that has already finished and
// would therefore never be answered at all.

export type Turn = {
    chatId: string;
    /** Folded in at the next round. */
    pending: string[];
    /** Everything this turn absorbed, for the caller to report on. */
    merged: string[];
    /** True once something addressed at Gepetel was folded in. */
    sawMention: boolean;
    closed: boolean;
};

const live = new Map<string, Turn>();

export function beginTurn(chatId: string): Turn {
    // A previous turn left open by a crash would swallow messages for ever.
    // Starting a new one always wins; the stale entry is simply replaced.
    const turn: Turn = { chatId, pending: [], merged: [], sawMention: false, closed: false };
    live.set(chatId, turn);
    return turn;
}

/**
 * Offer a newly arrived line to whatever is being written for this chat.
 *
 * Returns true when the open turn took it — the caller must then NOT generate a
 * reply of its own, because this message is already part of the answer being
 * composed. False means there is nothing in flight (or it just finished), and
 * the caller should handle the message normally.
 */
export function offerToTurn(chatId: string, line: string, isMention = false): boolean {
    const turn = live.get(chatId);
    if (!turn || turn.closed || !String(line || "").trim()) return false;
    turn.pending.push(line);
    turn.merged.push(line);
    if (isMention) turn.sawMention = true;
    return true;
}

/** Whatever has arrived since the last round. Empties the queue. */
export function pullPending(turn: Turn | null | undefined): string[] {
    if (!turn || !turn.pending.length) return [];
    return turn.pending.splice(0, turn.pending.length);
}

/**
 * The turn is over: stop accepting, and say what it absorbed. Anything still
 * unpulled was taken too late to reach the model — the caller decides what to do
 * with that rather than it vanishing quietly.
 */
export function closeTurn(turn: Turn | null | undefined): { merged: string[]; unused: string[]; sawMention: boolean } {
    if (!turn) return { merged: [], unused: [], sawMention: false };
    turn.closed = true;
    if (live.get(turn.chatId) === turn) live.delete(turn.chatId);
    return { merged: turn.merged.slice(), unused: turn.pending.splice(0, turn.pending.length), sawMention: turn.sawMention };
}

export function hasLiveTurn(chatId: string): boolean {
    const turn = live.get(chatId);
    return !!turn && !turn.closed;
}

export default { beginTurn, offerToTurn, pullPending, closeTurn, hasLiveTurn };
