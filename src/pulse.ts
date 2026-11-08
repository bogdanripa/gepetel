// Pulse: Gepetel noticing things for a person before they ask.
//
// What started it (2026-11-08): Filip was going to a contest, the organisers
// moved it a day earlier by email, and the email went unread. A friend who had
// seen his inbox would have texted him. That is the whole job.
//
// The shape follows what the proactive agents of 2026 converged on (OpenClaw's
// heartbeat, Hermes' cheap-check-first cron, PIN-AI's propose/judge loop, Muse's
// "the agent proposes, something else grants"):
//
//   look   — every tick, inside their waking hours, a small model reads their
//            OWN connected services through read-only tools only, and lists
//            what is new or coming. Any MCP server they connect is a source;
//            nothing here knows about Gmail or Calendar by name. Their groups
//            are a source too: a tag nobody answered.
//   think  — only when something is NEW, the strong model decides whether to
//            message them first, with what it knows about them, the recent
//            chat, and every topic raised before and how it landed.
//   judge  — a second model has to agree it's worth sending now.
//   send   — one WhatsApp message in their 1:1, through sayAndRemember, so
//            their answer ("yes, move it") is an ordinary turn of the chat,
//            with the ordinary tools and the ordinary rules for acting.
//
// Pulse itself can't change anything: a tool that writes is never handed to
// it (mcp.listTools / util.looksReadOnlyTool), so a sentence in an email can't
// reach one. Quiet is the default at every step, and the budget is in code:
// waking hours, a gap between messages, a daily cap, nothing raised twice, and
// a topic that was ignored stays dropped.
import mongoose from "mongoose";
import OpenAI from "openai";
import m from "./mongo.js";
import u from "./util.js";
import p from "./prompts.js";
import mcp from "./mcp.js";
import oai from "./oai.js";
import { sayAndRemember } from "./say.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const WAKING_FROM = 8, WAKING_UNTIL = 21;         // their local hours
const DAILY_CAP = 3;                              // unprompted messages a day
const MIN_GAP_MS = 2 * 3600_000;                  // between two of them
const TALKING_MS = 15 * 60_000;                   // they're mid-conversation: wait
const IGNORED_AFTER_MS = 20 * 3600_000;           // no answer by then = ignored
const LOOK_BACK_MS = 26 * 3600_000;               // first look, or after a gap
const TOOLS_FRESH_MS = 24 * 3600_000;             // re-list a server's tools daily
const SEEN_KEEP = 400;

const stateSchema = new mongoose.Schema({
    chat_id: { type: String, required: true, unique: true },
    off: { type: Boolean, default: false },            // they said stop
    last_look_at: { type: Date, default: null },
    seen: { type: [String], default: [] },              // item keys already considered
    day: { type: String, default: "" },                 // their local date, for the cap
    sent_today: { type: Number, default: 0 },
    last_sent_at: { type: Date, default: null },
    brief_day: { type: String, default: "" },           // the morning look, once a day
    tools: { type: mongoose.Schema.Types.Mixed, default: {} },   // connector_id -> { at, read: [names] }
});
const topicSchema = new mongoose.Schema({
    chat_id: { type: String, required: true, index: true },
    key: { type: String, required: true },
    title: { type: String, default: "" },
    message: { type: String, default: "" },
    raised_at: { type: Date, default: Date.now },
    outcome: { type: String, default: "pending" },      // pending | engaged | ignored
    // For a plan of theirs (an event, a contest, a trip): whether they're going.
    // Asked the first time it comes up; "yes" means watch it for changes and
    // keep them on top of it, "no" puts it on the do-not-track list for good.
    // Also "yes" for something they asked to be kept posted on (a parcel, a
    // refund, an application), and "done" once that is over.
    track: { type: String, default: "" },               // "" unknown | yes | no | done
    asked_intent: { type: Boolean, default: false },
}, { timestamps: true });
topicSchema.index({ chat_id: 1, key: 1 });
topicSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 });
const PulseState = mongoose.models.PulseState || mongoose.model("PulseState", stateSchema);
const PulseTopic = mongoose.models.PulseTopic || mongoose.model("PulseTopic", topicSchema);

type Item = { key: string; source: string; what: string; why: string; when: string; weight: number };

const ITEMS_SCHEMA = {
    type: "object", additionalProperties: false, required: ["items"],
    properties: { items: { type: "array", items: {
        type: "object", additionalProperties: false, required: ["key", "source", "what", "why", "when", "weight"],
        properties: { key: { type: "string" }, source: { type: "string" }, what: { type: "string" }, why: { type: "string" }, when: { type: "string" }, weight: { type: "integer" } },
    } } },
};
const THINK_SCHEMA = {
    type: "object", additionalProperties: false, required: ["send", "message", "topic_key", "topic_title", "why_now", "urgency", "asks_intent", "finished"],
    properties: { send: { type: "boolean" }, message: { type: "string" }, topic_key: { type: "string" }, topic_title: { type: "string" }, why_now: { type: "string" }, urgency: { type: "integer" }, asks_intent: { type: "boolean" }, finished: { type: "boolean" } },
};
const JUDGE_SCHEMA = {
    type: "object", additionalProperties: false, required: ["useful", "timely", "new", "clear", "calm", "approve", "reason"],
    properties: { useful: { type: "integer" }, timely: { type: "integer" }, new: { type: "integer" }, clear: { type: "integer" }, calm: { type: "integer" }, approve: { type: "boolean" }, reason: { type: "string" } },
};
const asJson = (name: string, schema: any) => ({ format: { type: "json_schema" as const, name, schema, strict: true } });

// Who Pulse looks out for: everyone with a service of their own connected in
// their 1:1, and the owner. PULSE=off stops it for everyone.
async function whoToWatch(): Promise<string[]> {
    if (String(process.env.PULSE || "").toLowerCase() === "off") return [];
    const owner = u.phoneDigits(process.env.CREATOR_PHONE);
    const chats = new Set(await m.privateChatsWithConnectors());
    if (owner) chats.add(`${owner}@s.whatsapp.net`);
    return [...chats];
}

// The read-only tools of each connected server, re-listed once a day. A
// server that can't be listed lends Pulse nothing — better blind than handed a
// tool nobody checked.
async function readOnlyMcp(chatId: string, state: any): Promise<{ tools: any[]; labels: string[] }> {
    const ctx = await oai.mcpContextForGroup(chatId);
    const rows = await m.getMcpConnectorsForGroup(chatId);
    const cache: any = { ...(state.tools || {}) };
    const tools: any[] = [], labels: string[] = [];
    for (const entry of ctx.tools) {
        const row = rows.find(r => r.server_label === entry.server_label);
        if (!row) continue;
        let read: string[] | undefined = cache[row.connector_id]?.read;
        const fresh = cache[row.connector_id]?.at && Date.now() - new Date(cache[row.connector_id].at).getTime() < TOOLS_FRESH_MS;
        if (!read || !fresh) {
            try {
                const headers: Record<string, string> = entry.authorization ? { Authorization: `Bearer ${entry.authorization}` } : (entry.headers || {});
                read = (await mcp.listTools(entry.server_url, headers)).filter(t => t.readOnly).map(t => t.name);
                cache[row.connector_id] = { at: new Date(), read };
            } catch (e: any) {
                console.error(`pulse ${chatId}: can't list ${row.label}'s tools — ${e?.message || e}`);
                if (!read) continue;
            }
        }
        if (!read.length) continue;
        tools.push({ ...entry, allowed_tools: read, require_approval: "never" });
        labels.push(row.label);
    }
    await PulseState.updateOne({ chat_id: chatId }, { $set: { tools: cache } });
    return { tools, labels };
}

// Their groups: someone tagged them since the last look and they haven't
// spoken in that group since. Free — no model.
async function groupAsks(chatId: string, name: string, since: Date): Promise<Item[]> {
    if (!name) return [];
    const groups = await m.getGroupsByParticipant(chatId).catch(() => []);
    const tag = `@${name}`.toLowerCase();
    const out: Item[] = [];
    for (const g of groups) {
        const { messages } = await m.groupMessagesSince(g.chatId, since, chatId).catch(() => ({ messages: [] as any[] }));
        let lastAsk: any = null;
        for (const msg of messages) {
            if (msg.from === name) lastAsk = null;                       // they answered
            else if (String(msg.text).toLowerCase().includes(tag)) lastAsk = msg;
        }
        if (lastAsk) out.push({
            key: `group:${g.chatId}:${new Date(lastAsk.at).getTime()}`, source: `group "${g.name}"`,
            what: `${lastAsk.from} tagged them in "${g.name}": "${String(lastAsk.text).slice(0, 300)}"`,
            why: "someone in a group is waiting on them and they haven't replied there", when: new Date(lastAsk.at).toISOString(), weight: 3,
        });
    }
    return out;
}

async function look(chatId: string, name: string, timezone: string, since: Date, mcpTools: any[], labels: string[], topics: any[]): Promise<Item[]> {
    if (!mcpTools.length) return [];
    const going = topics.filter(t => t.track === "yes").map(t => `- ${t.title} (${t.key})`).join("\n");
    const dropped = topics.filter(t => t.track === "no").map(t => `- ${t.title}`).join("\n");
    try {
        const res: any = await client.responses.create({
            model: "gpt-5-mini",
            reasoning: { effort: "low" },
            tools: mcpTools,
            instructions: `${p.loadPrompt("pulse-look", { name: name || "the person", services: labels.join(", "), since: u.currentTimeString(timezone, since) })}`
                + `\n\n[Plans they're going to, and things they asked you to keep them posted on (a parcel, a refund, an application) — check each for ANY change: date, time, place, status, a delivery update. Status emails and automatic notifications about these ARE worth listing (weight 4; delivered, failed or delayed is 5). List a plan when it's today or tomorrow even if nothing changed]\n${going || "(none)"}`
                + `\n\n[Plans they said they're NOT going to — never list anything about these]\n${dropped || "(none)"}`
                + `\n\n[Context] Right now it is ${u.currentTimeString(timezone)}.`,
            input: [{ role: "user", content: "Look now." }],
            text: asJson("pulse_items", ITEMS_SCHEMA),
            store: false,
        });
        const items: Item[] = JSON.parse(res.output_text || "{}").items || [];
        return items.filter(i => i && i.key && i.what).map(i => ({ ...i, weight: Math.max(1, Math.min(5, Number(i.weight) || 1)) }));
    } catch (e: any) {
        console.error(`pulse ${chatId}: look failed — ${e?.message || e}`);
        return [];
    }
}

// What became of what was raised: any word from them after it counts as
// engaged; silence past IGNORED_AFTER_MS drops the topic for good.
async function settleTopics(chatId: string, history: { from: string; at?: Date }[]) {
    const pending: any[] = await PulseTopic.find({ chat_id: chatId, outcome: "pending" }).lean();
    for (const t of pending) {
        const answered = history.some(h => h.from && h.from !== "Gepetel" && h.at && h.at > new Date(t.raised_at));
        const outcome = answered ? "engaged" : (Date.now() - new Date(t.raised_at).getTime() > IGNORED_AFTER_MS ? "ignored" : "pending");
        if (outcome !== "pending") await PulseTopic.updateOne({ _id: t._id }, { $set: { outcome } });
    }
}

/** One look for one person. Returns what happened, for the log. */
export async function pulseFor(chatId: string, now = new Date()): Promise<string> {
    const digits = u.phoneDigits(chatId);
    const timezone = u.inferTimezone([digits]) || "UTC";
    const local = u.localParts(now, timezone);
    if (local.hour < WAKING_FROM || local.hour >= WAKING_UNTIL) return "asleep";

    const state: any = await PulseState.findOneAndUpdate({ chat_id: chatId }, { $setOnInsert: { chat_id: chatId } }, { upsert: true, new: true }).lean();
    if (state.off) return "off";
    const day = local.ymd;
    const sentToday = state.day === day ? state.sent_today : 0;

    const history = await m.getRecentMessages(chatId, 30);
    const lastTheirs = [...history].reverse().find(h => h.from && h.from !== "Gepetel");
    if (lastTheirs?.at && now.getTime() - lastTheirs.at.getTime() < TALKING_MS) return "talking";
    await settleTopics(chatId, history);

    const since = state.last_look_at && now.getTime() - new Date(state.last_look_at).getTime() < LOOK_BACK_MS
        ? new Date(state.last_look_at) : new Date(now.getTime() - LOOK_BACK_MS);
    const name = (await m.getPersonName(digits)) || "";
    const topics: any[] = await PulseTopic.find({ chat_id: chatId }).sort({ raised_at: -1 }).limit(40).lean();
    const { tools, labels } = await readOnlyMcp(chatId, state);
    const items = [...await look(chatId, name, timezone, since, tools, labels, topics), ...await groupAsks(chatId, name, since)];

    const seen = new Set<string>(state.seen || []);
    const fresh = items.filter(i => !seen.has(i.key));
    const briefDue = state.brief_day !== day && local.hour < 11;
    await PulseState.updateOne({ chat_id: chatId }, {
        $set: { last_look_at: now, seen: [...seen, ...fresh.map(i => i.key)].slice(-SEEN_KEEP), ...(briefDue ? { brief_day: day } : {}) },
    });
    if (!fresh.length && !(briefDue && items.length)) return `quiet (${items.length} known)`;

    if (sentToday >= DAILY_CAP) return "cap";
    if (state.last_sent_at && now.getTime() - new Date(state.last_sent_at).getTime() < MIN_GAP_MS
        && !fresh.some(i => i.weight >= 5)) return "gap";

    const kept: any[] = await m.listMemories(chatId, { limit: 20 }).catch(() => []);
    const language = u.conversationLanguage(history.filter(h => h.from && h.from !== "Gepetel").map(h => h.text).reverse().slice(0, 6), chatId);
    const decision = await think({ chatId, name, timezone, language, items, fresh, topics, kept, history, brief: briefDue });
    if (!decision?.send || !decision.message.trim()) return "nothing worth saying";
    // The same topic again only when they're tracking it (something changed
    // in a plan they're going to); never one they ignored or don't want.
    const before = topics.find(t => t.key === decision.topic_key);
    if (before?.track === "no") return "not tracked";
    if (before && before.track !== "yes" && before.outcome !== "engaged") return "already raised";

    const verdict = await judge(decision.message, decision.why_now, topics, history, timezone);
    if (!verdict?.approve) { console.log(`pulse ${chatId}: judge said no — ${verdict?.reason || "no verdict"}: ${decision.message}`); return "judged out"; }

    const ok = await sayAndRemember(chatId, decision.message.trim());
    if (!ok) return "send failed";
    await PulseTopic.updateOne(
        { chat_id: chatId, key: decision.topic_key || `t:${now.getTime()}` },
        { $set: { title: decision.topic_title, message: decision.message, raised_at: now, outcome: "pending", ...(decision.asks_intent ? { asked_intent: true } : {}), ...(decision.finished && before?.track === "yes" ? { track: "done" } : {}) } },
        { upsert: true },
    );
    await PulseState.updateOne({ chat_id: chatId }, { $set: { day, sent_today: sentToday + 1, last_sent_at: now } });
    return `sent: ${decision.topic_title}`;
}

async function think(x: {
    chatId: string; name: string; timezone: string; language: string; items: Item[]; fresh: Item[];
    topics: any[]; kept: any[]; history: { from: string; text: string; at?: Date }[]; brief: boolean;
}): Promise<{ send: boolean; message: string; topic_key: string; topic_title: string; why_now: string; urgency: number; asks_intent: boolean; finished: boolean } | null> {
    const freshKeys = new Set(x.fresh.map(i => i.key));
    const when = (d?: Date) => d ? u.currentTimeString(x.timezone, d) : "";
    const input = [
        `[What you know about them]\n${x.kept.map(k => `- ${k.summary}`).join("\n") || "(nothing kept yet)"}`,
        `[Recent private conversation, oldest first]\n${x.history.slice(-16).map(h => `${when(h.at)} ${h.from === "Gepetel" ? "You" : h.from}: ${String(h.text).replace(/\s+/g, " ").slice(0, 300)}`).join("\n") || "(none)"}`,
        `[Topics you raised before]\n${x.topics.map(t => `- ${t.key} "${t.title}" — ${when(t.raised_at)} — ${t.outcome}${t.track === "yes" && String(t.key).startsWith("follow:") ? " — FOLLOWING: they asked you to keep them posted on this" : t.track === "yes" ? " — TRACKING: they're going" : t.track === "done" ? " — finished, nothing more to say" : t.track === "no" ? " — DO NOT TRACK: they're not going, never raise it" : t.asked_intent ? " — asked whether they're going, no answer yet" : ""}`).join("\n") || "(none)"}`,
        `[Found just now]\n${x.items.map(i => `- ${freshKeys.has(i.key) ? "NEW " : ""}[${i.source}] (${i.key}) ${i.what} — ${i.why}${i.when ? ` — ${i.when}` : ""} — weight ${i.weight}`).join("\n")}`,
    ].join("\n\n");
    const mode = x.brief
        ? "This is the morning look: if anything today or tomorrow needs a decision or action from them, say it in one short message (up to three lines). If nothing does, stay quiet."
        : "This is a check during the day: write only for something NEW that shouldn't wait until they next look at their phone.";
    try {
        const res: any = await client.responses.create({
            model: "gpt-5.6-luna",
            reasoning: { effort: "medium" },
            instructions: `${p.loadPrompt("pulse-think", { name: x.name || "them", mode, language: x.language })}\n\n[Context] Right now it is ${u.currentTimeString(x.timezone)}.`,
            input: [{ role: "user", content: input }],
            text: asJson("pulse_decision", THINK_SCHEMA),
            store: false,
        });
        return JSON.parse(res.output_text || "null");
    } catch (e: any) {
        console.error(`pulse ${x.chatId}: think failed — ${e?.message || e}`);
        return null;
    }
}

async function judge(message: string, whyNow: string, topics: any[], history: { from: string; text: string }[], timezone: string) {
    try {
        const res: any = await client.responses.create({
            model: "gpt-5-mini",
            reasoning: { effort: "low" },
            instructions: `${p.loadPrompt("pulse-judge")}\n\n[Context] Right now it is ${u.currentTimeString(timezone)}.`,
            input: [{ role: "user", content: [
                `[Recent conversation]\n${history.slice(-8).map(h => `${h.from === "Gepetel" ? "Assistant" : "Person"}: ${String(h.text).replace(/\s+/g, " ").slice(0, 200)}`).join("\n") || "(none)"}`,
                `[Already raised]\n${topics.map(t => `- "${t.title}" (${t.outcome})`).join("\n") || "(nothing)"}`,
                `[Why the assistant thinks it can't wait]\n${whyNow}`,
                `[The message]\n${message}`,
            ].join("\n\n") }],
            text: asJson("pulse_verdict", JUDGE_SCHEMA),
            store: false,
        });
        return JSON.parse(res.output_text || "null") as { approve: boolean; reason: string } | null;
    } catch (e: any) {
        console.error(`pulse: judge failed — ${e?.message || e}`);
        return null;
    }
}

/** The tick: everyone Pulse looks out for, one after another. */
export async function runPulse(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const chatId of await whoToWatch()) {
        try { out[u.phoneDigits(chatId).slice(-4)] = await pulseFor(chatId); }
        catch (e: any) { out[u.phoneDigits(chatId).slice(-4)] = `error: ${e?.message || e}`; }
    }
    console.log(`pulse: ${JSON.stringify(out)}`);
    return out;
}

/** "Stop the check-ins" / "start them again", from their 1:1. */
export async function setPulse(chatId: string, on: boolean) {
    await PulseState.updateOne({ chat_id: chatId }, { $set: { off: !on } }, { upsert: true });
}

/** Their answer to "are you going?": track the plan, or never raise it again. */
export async function setTracking(chatId: string, key: string, going: boolean): Promise<boolean> {
    if (!going && key.startsWith("follow:")) {
        const r = await PulseTopic.updateOne({ chat_id: chatId, key }, { $set: { track: "done" } });
        return r.matchedCount > 0;
    }
    const r = await PulseTopic.updateOne({ chat_id: chatId, key }, { $set: { track: going ? "yes" : "no", outcome: "engaged" } });
    return r.matchedCount > 0;
}

/** "Keep me posted on my Amazon order": something to watch until it's over.
 *  Pulse looks for it on every round and any change to it is worth a message. */
export async function follow(chatId: string, what: string): Promise<{ ok: boolean; key?: string; reason?: string }> {
    const state: any = await PulseState.findOne({ chat_id: chatId }).lean();
    if (state?.off) return { ok: false, reason: "their check-ins are off — they'd have to turn them back on first" };
    const key = `follow:${Date.now()}`;
    await PulseTopic.create({ chat_id: chatId, key, title: what.slice(0, 200), raised_at: new Date(), outcome: "engaged", track: "yes" });
    return { ok: true, key };
}

/** For their 1:1 replies: the plans a check-in asked about, and the ones being
 *  tracked, so an answer like "da, merg" lands on the right one. */
export async function checkInsNote(chatId: string): Promise<string> {
    const rows: any[] = await PulseTopic.find({ chat_id: chatId, $or: [{ track: "yes" }, { asked_intent: true, track: "" }] })
        .sort({ raised_at: -1 }).limit(10).lean();
    if (!rows.length) return "";
    return `\n\n[What you're keeping an eye on for them] When they answer whether they're going to one of these, or tell you to stop following one, call track_plan with its key.\n`
        + rows.map(t => `- ${t.key}: "${t.title}" — ${t.key.startsWith("follow:") ? "they asked you to keep them posted; you are" : t.track === "yes" ? "they're going; you're keeping an eye on it" : "you asked whether they're going; no answer yet"}`).join("\n");
}

// For replaying a case against the real models without sending anything.
export const __forReplay = { think, judge };

export default { runPulse, pulseFor, setPulse, setTracking, checkInsNote, follow };
