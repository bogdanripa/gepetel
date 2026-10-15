// The tool loop one reply goes through: run what the model asked for, hand
// the outputs back, fold in what was said meanwhile, and stop with plain text.
//
// The 1:1 reply and the group reply each had their own copy of this, and the
// copies had drifted (the capped 1:1 path stored a thread id the cap check
// never saw; one closed its turn only on success). One loop now; what differs
// between them — which tools exist, what a call does, how the cap is worded —
// is passed in (2026-10-15).
import turns, { type Turn } from "./turn.js";
import u from "./util.js";

// How many extra model rounds a turn will spend folding in messages that landed
// while it was writing. Bounded: in a busy group the messages never stop, and a
// turn that keeps absorbing them never answers anybody.
export const MAX_LATE_ROUNDS = 2;

// How many rounds of tool calls one reply may take. Tools stay available on every
// round (a request often needs "look it up, then act on it"), so this is what
// stops a model that keeps calling them from looping forever.
export const MAX_TOOL_ROUNDS = 6;

// When a threaded conversation gets this big, drop the thread and start fresh.
//
// previous_response_id chains forever, and every turn re-bills the WHOLE history
// as input. Unbounded, that ends where it did: a two-word "mai multe" costing
// 454,000 input tokens, and 8.6M tokens billed uncached across two days — because
// prompts that large mostly miss the cache too.
//
// Resetting loses the older conversation, which is the honest trade: at this size
// the thread holds weeks of history the model barely uses, and a stale thread is
// itself a bug source — it is what kept old refusals alive after the rules changed.
export const MAX_THREAD_INPUT_TOKENS = 100_000;

// The id to store for next time: the real one, or "" to start a new thread.
export function threadIdFor(out: any, label: string): string {
    const used = out?.usage?.input_tokens ?? 0;
    if (used > MAX_THREAD_INPUT_TOKENS) {
        console.log(`[thread] ${label}: ${used} input tokens exceeds ${MAX_THREAD_INPUT_TOKENS} — starting a fresh thread next turn.`);
        return "";
    }
    return out?.id || "";
}

// Newly arrived lines, as input items the model reads as part of this exchange.
// Marked as new so it treats them as "this just came in", not as history it
// already answered.
//
// `draftPending` is the difference between the two moments this is used. Mid-loop
// — riding along with tool results — the model has not written an answer yet, so
// the lines are simply more of the question. After it HAS written one, that draft
// is sitting in the thread as its own last turn, and a model that assumes the
// draft was sent will reply with only an increment ("a, și Ana vine atunci") —
// and the group never sees the actual answer, because only the final output is
// sent. So in that case say plainly that nothing has gone out yet, and ask for
// the one message it wants to send.
export function lateInput(lines: string[], draftPending = false): any[] {
    if (!lines.length) return [];
    const items: any[] = lines.map(line => ({
        role: "user" as const,
        content: `[just arrived, while you were replying] ${line}`,
    }));
    if (draftPending) {
        items.push({
            role: "user" as const,
            content: "[note] Your previous message has NOT been sent — nobody has seen it. Write the single message you want to send now, covering the original point AND what just came in. Do not reply as though the earlier draft had already gone out, and do not refer to it.",
        });
    }
    return items;
}

export type ToolCall = { name: string; args: any; callId: string; item: any };

export type ToolLoopOpts = {
    /** The model call (client.responses.create; a stub in tests). */
    create: (req: any) => Promise<any>;
    /** The response the loop starts from. */
    first: any;
    model: string;
    /** The tools for every later round — read each round, so a refreshed
     *  connector list is the one used. */
    tools: () => any[];
    turn: Turn | null;
    /** Whose reply this is, for the logs: "dm <id>", "group <id>". */
    label: string;
    /** Who the cap message says to tell: "the user", "the group". */
    audience: string;
    /** Run one call. A throw becomes `{ error }` for the model. */
    dispatch: (call: ToolCall) => Promise<any>;
    /** Every response, before its calls are run (logging hosted MCP items). */
    onResponse?: (out: any) => void;
    /** What an empty answer becomes ("no answer" lets a group stay quiet). */
    emptyAnswer?: string;
};

/**
 * Run the loop to a final answer. The turn is closed however this ends — a
 * thrown model call included, or the chat would swallow every later message
 * into a reply that is never coming.
 */
export async function runToolLoop(o: ToolLoopOpts): Promise<{ answer: string; responseId: string; out: any }> {
    let out = o.first;
    let lateRounds = 0;
    const answerOf = (x: any) => u.cleanUpAnswer(o.emptyAnswer !== undefined ? (x.output_text?.trim() || o.emptyAnswer) : (x.output_text || ""));
    try {
        for (let round = 0; ; round++) {
            o.onResponse?.(out);
            // Run the tools whenever the model asked for them — NOT only when it
            // stayed silent. Guarding on "no text yet" meant that a reply like
            // "sure, sending it now!" plus a tool call would return the text and
            // quietly drop the call: Gepetel announced things he then never did.
            const calls = (out.output || []).filter((i: any) => i?.type === "function_call");
            if (calls.length) {
                // Past the round cap we stop running tools, but we do NOT stop
                // here: every pending call still needs an output. Returning
                // out.output_text directly would describe work that never ran,
                // and would store a response id whose thread ends in
                // function_calls with no matching output — which the next
                // message has to continue from.
                const capped = round >= MAX_TOOL_ROUNDS;
                const toolResults: { call_id: string; output: string }[] = [];
                for (const item of calls) {
                    const callId = (item as any)?.call_id;
                    if (capped) {
                        toolResults.push({
                            call_id: callId,
                            output: JSON.stringify({ error: `Tool round limit reached — this call was NOT executed. Tell ${o.audience} plainly that you could not finish it; do not claim it is done.` }),
                        });
                        continue;
                    }
                    const name = (item as any)?.name ?? (item as any)?.tool_name;
                    const args = u.parseToolArgs((item as any)?.arguments);
                    let result: any;
                    try {
                        result = await o.dispatch({ name, args, callId, item });
                    } catch (err: any) {
                        result = { error: String(err?.message || err || "tool error") };
                    }
                    toolResults.push({ call_id: callId, output: JSON.stringify(result ?? null) });
                }
                out = await o.create({
                    model: o.model,
                    previous_response_id: out.id,
                    // Keep the tools available: most real requests need more than
                    // one round ("send it now" = look it up, THEN run it). Without
                    // this the model can only describe the second step.
                    tools: o.tools(),
                    // At the cap, deny further calls so this turn has to end in plain text.
                    tool_choice: capped ? "none" : "auto",
                    input: [
                        ...toolResults.map(r => ({ type: "function_call_output" as const, call_id: r.call_id, output: r.output })),
                        // Whatever they said while that tool ran. Folding it in
                        // here is free — the round was happening anyway.
                        ...lateInput(turns.pullPending(o.turn)),
                    ],
                });
                if (capped) {
                    turns.closeTurn(o.turn);
                    return { answer: answerOf(out), responseId: threadIdFor(out, o.label), out };
                }
                continue;
            }
            // About to answer — but something may have landed while the model
            // was writing this very sentence. Rather than send an answer that
            // ignores it and let a second run reply to it separately, spend one
            // more round and say both things at once. Bounded, or a busy group
            // would keep the turn open for ever.
            const late = lateRounds < MAX_LATE_ROUNDS ? turns.pullPending(o.turn) : [];
            if (late.length) {
                lateRounds++;
                console.log(`Folding ${late.length} new message(s) into the reply being written for ${o.label}.`);
                out = await o.create({
                    model: o.model,
                    previous_response_id: out.id,
                    tools: o.tools(),
                    tool_choice: "auto",
                    input: lateInput(late, true),
                });
                continue;
            }
            // Nothing left to fold in: this answer is final, so stop accepting.
            // Closing here rather than at the call site leaves no gap in which a
            // message could be taken by a turn that can no longer use it — there
            // is no await between the pull above and this line.
            const { unused } = turns.closeTurn(o.turn);
            if (unused.length) console.warn(`${unused.length} message(s) reached the fold-in cap in ${o.label} and are answered only by the next turn.`);
            return { answer: answerOf(out), responseId: threadIdFor(out, o.label), out };
        }
    } finally {
        // Already closed on every normal way out; this is for a throw.
        turns.closeTurn(o.turn);
    }
}

export default { runToolLoop, lateInput, threadIdFor, MAX_TOOL_ROUNDS, MAX_LATE_ROUNDS, MAX_THREAD_INPUT_TOKENS };
