// A request the chat can't answer in one reply — it needs a service connected,
// a job on their computer, or their answer first — kept as a goal, so the chat
// carries on until it's answered (the owner, 2026-10-16: "you should have had a
// clear goal and a 1st task to go and connect my calendar. then continue until
// the goal is met or you get stuck or you run in a loop").
//
// One open goal per 1:1, its own words: what they asked. A reply that ends
// waiting (a login link, a job, a question to them) keeps it open; whatever it
// waited for arriving gives the chat a turn with the goal in view (app.ts,
// followUpTurn); a reply that seems final is checked against it, and a turn
// more is spent if it isn't met. Bounded: MAX_CONTINUES turns, then it stops.
import mongoose from "mongoose";

export const MAX_CONTINUES = 3;
/** A goal not touched for this long is over (they moved on). */
export const GOAL_TTL_MS = 3 * 3600_000;

const goalSchema = new mongoose.Schema({
    chat_id: { type: String, required: true, unique: true },
    asked: { type: String, default: "" },
    waiting_for: { type: String, default: "" },
    continues: { type: Number, default: 0 },
    last_missing: { type: String, default: "" },
    updated_at: { type: Date, default: Date.now, expires: 24 * 3600 },
});
const ChatGoal = mongoose.models.ChatGoal || mongoose.model("ChatGoal", goalSchema);

export type Goal = { chatId: string; asked: string; waitingFor: string; continues: number; lastMissing: string; updatedAt: Date };

const asGoal = (d: any): Goal | null => d ? { chatId: d.chat_id, asked: d.asked || "", waitingFor: d.waiting_for || "", continues: d.continues || 0, lastMissing: d.last_missing || "", updatedAt: new Date(d.updated_at) } : null;

/** The chat's open goal, or null (none, or gone stale). */
export async function getGoal(chatId: string, now = Date.now()): Promise<Goal | null> {
    const g = asGoal(await ChatGoal.findOne({ chat_id: chatId }).lean());
    if (g && now - g.updatedAt.getTime() > GOAL_TTL_MS) { await closeGoal(chatId); return null; }
    return g;
}

/** Open (or keep) the goal: what they asked, and what the reply now waits for.
 *  A new request replaces an old one; the same one keeps its count. */
export async function keepGoal(chatId: string, asked: string, waitingFor: string): Promise<void> {
    const old = await getGoal(chatId);
    // A short reply ("da", "3", "done") is an answer within the goal, not a
    // new request: the goal keeps their original words.
    const same = !!old && (!asked || old.asked === asked || asked.trim().length < 25);
    await ChatGoal.updateOne({ chat_id: chatId }, {
        $set: { asked: same ? old!.asked : asked.slice(0, 1500), waiting_for: waitingFor.slice(0, 200), updated_at: new Date(), ...(same ? {} : { continues: 0, last_missing: "" }) },
    }, { upsert: true });
}

/** One more turn spent on it; false when that's past the bound. */
export async function spendContinue(chatId: string, missing: string): Promise<boolean> {
    const g = await getGoal(chatId);
    if (!g) return false;
    // The same thing missing twice in a row is a loop: stop rather than spin.
    if (g.continues >= MAX_CONTINUES || (missing && g.lastMissing && missing.toLowerCase() === g.lastMissing.toLowerCase())) return false;
    await ChatGoal.updateOne({ chat_id: chatId }, { $set: { continues: g.continues + 1, last_missing: missing.slice(0, 300), waiting_for: "", updated_at: new Date() } });
    return true;
}

export async function closeGoal(chatId: string): Promise<void> {
    await ChatGoal.deleteOne({ chat_id: chatId }).catch(() => {});
}

/** The note a turn gets about it — their words, so the turn serves them. */
export function goalNote(g: Goal): string {
    return `[Open goal — what they asked: "${g.asked}". Carry it to the end with your tools: do the next step yourself; stop only when it's answered, when you need them for something (then ask one clear question), or when you're truly stuck (then say so plainly).]`;
}

/** The check: is what they asked answered by what was said since? */
export function goalCheckRequest(asked: string, replies: string[]): any {
    return {
        model: "gpt-5.6-luna",
        instructions: [
            "A chat assistant is helping a person. Decide whether their request is now answered.",
            "achieved: true when the replies give what they asked, say plainly it can't be done, or end with a question only the person can answer. false when the assistant only promised, set something up (a connection, a login) or reported a step on the way, and could carry on now.",
            "missing: in a few words, what's still to do (empty when achieved).",
        ].join("\n"),
        input: [{ role: "user", content: [{ type: "input_text", text: `They asked: "${asked}"\n\nThe assistant's replies since:\n${replies.map(r => `- ${r}`).join("\n")}` }] }],
        tools: [{ type: "function", name: "goal_check", description: "Whether the request is answered.", parameters: { type: "object", properties: { achieved: { type: "boolean" }, missing: { type: "string" } }, required: ["achieved", "missing"], additionalProperties: false }, strict: true }],
        tool_choice: { type: "function", name: "goal_check" },
        reasoning: { effort: "low" },
        max_output_tokens: 300,
        store: false,
    };
}

export function readGoalCheck(out: any): { achieved: boolean; missing: string } | null {
    const fc = (out?.output || []).find((o: any) => o?.type === "function_call" && o?.name === "goal_check");
    if (!fc) return null;
    try { const a = JSON.parse(fc.arguments || "{}"); return { achieved: a.achieved === true, missing: String(a.missing || "") }; } catch { return null; }
}

/** What a reply ended waiting for, from its tool calls: a login link, a job
 *  on their computer. "" when nothing. */
export function waitsIn(items: { kind: "mcp"; name: string; output: string }[] | { kind: "tool"; name: string; result: any }[]): string {
    for (const it of items as any[]) {
        if (it.kind === "mcp" && (it.name === "browse" || it.name === "job") && /"status"\s*:\s*"(running|waiting)"/.test(String(it.output || ""))) return "their computer";
        if (it.kind === "tool" && it.name === "add_mcp_connector") {
            const r = it.result || {};
            if (!r.connected && /https:\/\/\S*(auth|oauth|login|authorize)/i.test(JSON.stringify(r))) return `a login (${String(r.label || "a service")})`;
        }
    }
    return "";
}

export default { getGoal, keepGoal, spendContinue, closeGoal, goalNote, goalCheckRequest, readGoalCheck, waitsIn, MAX_CONTINUES, GOAL_TTL_MS };
