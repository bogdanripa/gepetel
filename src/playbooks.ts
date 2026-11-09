// Ways that worked: after a turn that took real work, keep HOW it got done,
// so the next request of the same kind goes straight there (the owner,
// 2026-11-08, after looking at Hermes Agent's self-written skills).
//
// The Mac already keeps recipes and site notes — one site, one browser. This
// is the level above: "where's my Amazon order" = the shipping email in Gmail,
// then the courier's page, a computer job only if there's no email. Learned by
// a small model looking back at the turn's steps; read back into every 1:1
// reply as a few lines.
//
// Per person, never shared: the way someone's mail is set up is theirs. A way
// is a method, never a result — no numbers, amounts, addresses or names
// (unfit() checks before saving). Bounded: MAX_KEPT a person, the least
// recently used goes first, and one unused for UNUSED_DAYS expires.
import mongoose from "mongoose";

const playbookSchema = new mongoose.Schema({
    chat_id: { type: String, required: true, index: true },
    when: { type: String, required: true },
    how: { type: String, required: true },
    uses: { type: Number, default: 0 },
    used_at: { type: Date, default: Date.now },
}, { timestamps: true });
export const UNUSED_DAYS = 180;
playbookSchema.index({ used_at: 1 }, { expireAfterSeconds: UNUSED_DAYS * 24 * 3600 });
export const Playbook = mongoose.models.Playbook || mongoose.model("Playbook", playbookSchema);

export const MAX_KEPT = 30, SHOWN = 12, WHEN_CHARS = 140, HOW_CHARS = 500;
/** Steps a turn must take before it's worth looking back at. */
export const MIN_STEPS = 3;

/** Tools that are bookkeeping, not finding things out: a turn of these
 *  alone teaches no way. */
const CHORES = new Set([
    "remember_about_them", "forget_about_them", "set_reminder", "list_reminders", "cancel_reminder",
    "check_back_later", "track_plan", "follow_for_them", "set_check_ins", "stop_writing_to_them",
    "contact_creator", "connect_computer", "computer_status",
    // a group's bookkeeping
    "remember_fact", "list_memories", "search_memory", "delete_memory", "set_member_name", "only_reply_when_asked",
]);
/** In a group, one real step is enough: how the group splits a bill, runs a
 *  poll or keeps its ledger is learned from a single tool call. */
export const MIN_STEPS_GROUP = 1;
const isGroup = (chatId: string) => /@g\.us$/.test(chatId);

export type Step = { tool: string; args: string; result: string };

const clip = (s: unknown, n: number) => {
    const t = typeof s === "string" ? s : JSON.stringify(s ?? "");
    return (t || "").replace(/\s+/g, " ").slice(0, n);
};

/** Collects a turn's steps: the model's own calls (mcp, web search) from each
 *  response, the relay's function calls from dispatch. */
export class Tracer {
    steps: Step[] = [];
    onResponse(out: any): void {
        for (const i of out?.output || []) {
            if (i?.type === "mcp_call") this.steps.push({ tool: `${i.server_label || "mcp"}.${i.name}`, args: clip(i.arguments, 300), result: clip(i.error || i.output, 400) });
            else if (i?.type === "web_search_call") this.steps.push({ tool: "web_search", args: clip(i.action?.query || i.action?.url || "", 200), result: "" });
        }
    }
    onDispatch(name: string, args: any, result: any): void {
        this.steps.push({ tool: name, args: clip(args, 300), result: clip(result, 400) });
    }
    /** Enough real work to be worth a look. */
    worth(min = MIN_STEPS): boolean {
        return this.steps.filter(s => !CHORES.has(s.tool.replace(/^.*\./, ""))).length >= min;
    }
}

/** Why a way can't be kept, or "" when it can: it says how, never what. */
export function unfit(when: string, how: string): string {
    const t = `${when} ${how}`;
    if (!when.trim() || !how.trim()) return "empty";
    if (when.length > WHEN_CHARS || how.length > HOW_CHARS) return "too long";
    if (/\d{5,}|\d[\d .-]{7,}\d/.test(t)) return "a long number (an order, tracking, account or phone number?)";
    if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(t)) return "an email address";
    if (/[$€£]\s?\d|\d\s?(lei|ron|eur|usd|chf|gbp)\b/i.test(t)) return "an amount";
    if (/(password|parol|passwort|\bpin\b|cvv|otp|one-time code)\s*[:=]/i.test(t)) return "a secret";
    return "";
}

/** The note for a 1:1 reply: the ways kept, most recently used first. */
export async function note(chatId: string): Promise<string> {
    if (mongoose.connection.readyState !== 1) return "";
    const rows: any[] = await Playbook.find({ chat_id: chatId }).sort({ used_at: -1 }).limit(SHOWN).lean().catch(() => []);
    if (!rows.length) return "";
    if (isGroup(chatId)) return "\n\n[How things are done in this group — learned here; when a request is one of these, do it this way unless they say otherwise]\n"
        + rows.map(r => `- ${r.when} → ${r.how}`).join("\n");
    return "\n\n[Ways that worked for them before — when a request is one of these, go that way first; if it fails, find another]\n"
        + rows.map(r => `- ${r.when} → ${r.how}`).join("\n");
}

const LEARN_SCHEMA = {
    type: "object", additionalProperties: false,
    required: ["action", "id", "when", "how", "followed"],
    properties: {
        action: { type: "string", enum: ["new", "update", "none"] },
        id: { type: "string" },
        when: { type: "string" },
        how: { type: "string" },
        followed: { type: "array", items: { type: "string" } },
    },
};

export type Decision = { action: "new" | "update" | "none"; id: string; when: string; how: string; followed: string[] };

/** What the look back sees: the ask, the steps, the reply, the kept ways. */
export function lookBackInput(asked: string, before: { from: string; text: string }[], steps: Step[], answer: string, kept: any[]): string {
    return [
        "[The messages before]", before.length ? before.map(h => `${h.from}: ${clip(h.text, 300)}`).join("\n") : "(none)",
        "\n[What they asked]", clip(asked, 800),
        "\n[Steps taken, in order]", steps.map((s, i) => `${i + 1}. ${s.tool}(${s.args})${s.result ? ` → ${s.result}` : ""}`).join("\n"),
        "\n[Reply sent]", clip(answer, 800),
        "\n[Ways already kept]", kept.length ? kept.map(k => `- [${k._id}] ${k.when} → ${k.how}`).join("\n") : "(none)",
    ].join("\n");
}

/** Apply a decision. Returns what happened, for the log (never the text). */
export async function apply(chatId: string, d: Decision, kept: any[]): Promise<string> {
    const ids = new Set(kept.map(k => String(k._id)));
    const followed = (d.followed || []).filter(id => ids.has(id));
    if (followed.length) await Playbook.updateMany({ _id: { $in: followed }, chat_id: chatId }, { $inc: { uses: 1 }, $set: { used_at: new Date() } });
    if (d.action === "none") return followed.length ? `followed ${followed.length}` : "none";
    const when = d.when.trim(), how = d.how.trim();
    const why = unfit(when, how);
    if (why) return `dropped (${why})`;
    if (d.action === "update" && ids.has(d.id)) {
        await Playbook.updateOne({ _id: d.id, chat_id: chatId }, { $set: { when, how, used_at: new Date() } });
        return "updated";
    }
    await Playbook.create({ chat_id: chatId, when, how });
    const extra = await Playbook.find({ chat_id: chatId }).sort({ used_at: -1 }).skip(MAX_KEPT).select("_id").lean();
    if (extra.length) await Playbook.deleteMany({ _id: { $in: extra.map((x: any) => x._id) } });
    return "new";
}

/** After a 1:1 turn: look back, keep the way if there's one. Never throws,
 *  never holds up the reply (called without await). */
export async function afterTurn(
    create: (req: any) => Promise<any>,
    chatId: string, asked: string, before: { from: string; text: string }[], tracer: Tracer, answer: string,
): Promise<string> {
    try {
        const group = isGroup(chatId);
        if (!tracer.worth(group ? MIN_STEPS_GROUP : MIN_STEPS) || !answer.trim() || mongoose.connection.readyState !== 1) return "skipped";
        const kept: any[] = await Playbook.find({ chat_id: chatId }).sort({ used_at: -1 }).limit(MAX_KEPT).lean();
        const p = (await import("./prompts.js")).default;
        const res = await create({
            model: "gpt-5.6-luna",
            reasoning: { effort: "low" },
            instructions: p.loadPrompt("learn-how") + (group ? `\n\n${p.loadPrompt("learn-how-group")}` : ""),
            input: [{ role: "user", content: lookBackInput(asked, before.slice(-6), tracer.steps.slice(0, 30), answer, kept) }],
            text: { format: { type: "json_schema", name: "way", schema: LEARN_SCHEMA, strict: true } },
            store: false,
        });
        const outcome = await apply(chatId, JSON.parse(res.output_text || "{}"), kept);
        console.log(`[ways] …${chatId.replace(/\D/g, "").slice(-4)}: ${tracer.steps.length} steps → ${outcome}`);
        return outcome;
    } catch (e: any) {
        console.error("ways look-back failed:", e?.message || e);
        return "failed";
    }
}

/** "Forget how you…": every kept way whose text has this in it. */
export async function forget(chatId: string, text: string): Promise<number> {
    const t = text.toLowerCase().trim();
    if (!t || mongoose.connection.readyState !== 1) return 0;
    const rows: any[] = await Playbook.find({ chat_id: chatId }).lean();
    const gone = rows.filter(r => `${r.when} ${r.how}`.toLowerCase().includes(t)).map(r => r._id);
    if (gone.length) await Playbook.deleteMany({ _id: { $in: gone }, chat_id: chatId });
    return gone.length;
}

export default { Tracer, note, afterTurn, apply, unfit, forget, lookBackInput, Playbook, MAX_KEPT, MIN_STEPS, MIN_STEPS_GROUP };
