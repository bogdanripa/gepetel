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

// After the answer is final it still has to go out — typing, short messages
// one after another. A person who reads a new message then finishes what they
// were saying first, and answers it knowing what they said. So a message that
// arrives in that gap waits for the delivery (settled) before its own reply
// reads the conversation; and the short messages still queued stop as soon as
// they write (heardSince), the way someone stops talking when interrupted.
type Deferred = { promise: Promise<void>; resolve: () => void };
const delivering = new Map<string, Deferred>();
const lastHeard = new Map<string, number>();
export const SETTLE_MAX_MS = 60_000;

/** Their message just came in. */
export function heard(chatId: string, at = Date.now()): void {
    lastHeard.set(chatId, at);
    // Sending ends typing — WhatsApp sends no "paused" after a message, so a
    // reply would otherwise wait for a typing that's already over.
    typingNow.delete(chatId);
}
// "typing…" on their side (wa-gateway presence events, 1:1 only). Typing is
// repeated while it lasts; one not heard of for TYPING_STALE_MS has ended.
const typingNow = new Map<string, { state: string; at: number }>();
export const TYPING_STALE_MS = 20_000, TYPING_WAIT_MS = 30_000, RECORDING_WAIT_MS = 90_000;
export function typing(chatId: string, state: string, at = Date.now()): void {
    if (state === "paused") typingNow.delete(chatId); else typingNow.set(chatId, { state, at });
}
/** "typing", "recording", or "" when they aren't. */
export function typingState(chatId: string, now = Date.now()): string {
    const t = typingNow.get(chatId);
    return t && now - t.at < TYPING_STALE_MS ? t.state : "";
}

/**
 * About to send, and they are typing: wait for what they're writing, as a
 * person would — until it arrives (the turn has it pending), they stop, or a
 * cap (longer for a voice note). True when something arrived.
 */
export async function waitWhileTyping(turn: Turn | null | undefined, pollMs = 400): Promise<boolean> {
    if (!turn) return false;
    const first = typingState(turn.chatId);
    if (!first) return false;
    const until = Date.now() + (first === "recording" ? RECORDING_WAIT_MS : TYPING_WAIT_MS);
    console.log(`They're ${first} in ${turn.chatId}: holding the reply for it.`);
    while (Date.now() < until) {
        if (turn.pending.length) return true;
        if (!typingState(turn.chatId)) {
            // Stopped: a message is often a beat behind the stop.
            await new Promise(r => setTimeout(r, 1500));
            return turn.pending.length > 0;
        }
        await new Promise(r => setTimeout(r, pollMs));
    }
    return turn.pending.length > 0;
}

/** Did they write since then? */
export function heardSince(chatId: string, since: number): boolean { return (lastHeard.get(chatId) || 0) > since; }

/** The reply for this chat is out (or never will be). */
export function delivered(chatId: string): void {
    const d = delivering.get(chatId);
    if (d) { delivering.delete(chatId); d.resolve(); }
}

/** Wait until a reply being delivered for this chat is out — never longer than maxMs. */
export async function settled(chatId: string, maxMs = SETTLE_MAX_MS): Promise<void> {
    const d = delivering.get(chatId);
    if (!d) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([d.promise, new Promise<void>(r => { timer = setTimeout(r, maxMs); })]);
    if (timer) clearTimeout(timer);
}

export function beginTurn(chatId: string): Turn {
    // A previous turn left open by a crash would swallow messages for ever.
    // Starting a new one always wins; the stale entry is simply replaced.
    const turn: Turn = { chatId, pending: [], merged: [], sawMention: false, closed: false };
    live.set(chatId, turn);
    admitted(chatId);    // the next message for this chat may come in now: it joins this turn
    delivered(chatId);   // an older delivery left hanging never blocks this one
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    delivering.set(chatId, { promise, resolve });
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

/**
 * Run `fn` inside a fresh turn for this chat, and close that turn however `fn`
 * ends. A generator that throws never reaches its own closeTurn, and a turn
 * left open swallows every later message of the chat into a reply that is
 * never coming (the after-job turn did exactly that, 2026-10-15).
 */
export async function withTurn<T>(chatId: string, fn: (turn: Turn) => Promise<T>): Promise<T> {
    const turn = beginTurn(chatId);
    try { return await fn(turn); }
    finally {
        const { unused } = closeTurn(turn);
        if (unused.length) console.warn(`${unused.length} folded-in message(s) left unanswered in ${chatId}.`);
    }
}

export function hasLiveTurn(chatId: string): boolean {
    const turn = live.get(chatId);
    return !!turn && !turn.closed;
}

// One message at a time through the door, per chat (2026-11-08): the webhook
// is answered as soon as a message is taken, so the next one can arrive while
// a reply is being written and join it — the gateway sends one delivery at a
// time, and holding each open until its reply was out meant nothing ever
// arrived mid-turn. A message waits at the door only until the one before it
// has started its turn, joined one, or finished; never longer than
// ADMIT_MAX_MS.
export const ADMIT_MAX_MS = 60_000;
const door = new Map<string, Promise<void>>();
const letIn = new Map<string, () => void>();
/** Wait for this chat's previous message to be in; returns the release. */
export async function admit(chatId: string, max = ADMIT_MAX_MS): Promise<() => void> {
    const before = door.get(chatId) || Promise.resolve();
    let open!: () => void;
    const mine = new Promise<void>(r => { open = r; });
    const chained = before.then(() => mine);
    door.set(chatId, chained);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([before, new Promise<void>(r => { timer = setTimeout(r, max); timer.unref?.(); })]);
    clearTimeout(timer);
    let done = false;
    const release = () => {
        if (done) return;
        done = true;
        open();
        if (letIn.get(chatId) === release) letIn.delete(chatId);
        if (door.get(chatId) === chained) door.delete(chatId);
    };
    letIn.set(chatId, release);
    return release;
}
/** The message being let in for this chat has started its turn. */
export function admitted(chatId: string): void { letIn.get(chatId)?.(); }

export default { admit, admitted, ADMIT_MAX_MS, beginTurn, offerToTurn, pullPending, closeTurn, hasLiveTurn, withTurn, heard, heardSince, delivered, settled, typing, typingState, waitWhileTyping };
