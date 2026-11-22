// Real moments, replayed against the live model.
//
// A prompt change used to be tested by asking whether the file contained a
// phrase. Whether the model then BEHAVES differently was checked by hand, the
// day something went wrong, and never again. Each case here is a moment that
// did go wrong (or that must keep going right), with the names changed, and
// what should happen in it: say nothing, call this tool, never say that. Run
// before changing a prompt or a model, and to compare models on the same
// ground:
//
//   node dist/replay.js                     every case, on the models in use
//   node dist/replay.js --model gpt-5.6-luna   group and 1:1 replies on that model
//   node dist/replay.js --only family --runs 3
//
// It sends nothing and writes nothing: tool calls are answered with canned
// results. Exit code 1 when fewer than --min (default 0.85) of the runs pass.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import p from "./prompts.js";
import u from "./util.js";
import MODELS from "./models.js";
import { shaped } from "./promptShape.js";

type Line = [string, string];
type Expect = { silent?: boolean; quiet?: boolean; reaction?: boolean; yes?: string[]; no?: string[]; calls?: string[]; callsAny?: string[]; notCalls?: string[]; maxChars?: number; is?: string };
type Case = {
    name: string; from?: string; kind: "group" | "dm" | "gate" | "work-claim" | "follow-up";
    group?: { name?: string; people?: string[]; joinedHoursAgo?: number; repliesUsed?: number; rules?: string[]; timezone?: string };
    person?: { name?: string; number?: string; timezone?: string; language?: string };
    history?: Line[]; message?: string; note?: string; last?: string; asked?: string; answer?: string;
    toolResults?: Record<string, any>; expect: Expect;
};

const arg = (name: string, fallback = "") => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? String(process.argv[i + 1] || "") : fallback; };
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "replays");

const asInput = (history: Line[] = [], named: boolean) => history.map(([from, text]) => from === "Gepetel"
    ? { role: "assistant" as const, content: text }
    : { role: "user" as const, content: named && from ? `${from}: ${text}` : text });

function groupInstructions(c: Case): string {
    const g = c.group || {};
    const now = new Date();
    const people = g.people?.length ? g.people : ["Ana", "Dan", "Radu", "Ioana"];
    const stored = { addedAt: new Date(now.getTime() - (g.joinedHoursAgo ?? 800) * 3600_000), dailyReplyCount: g.repliesUsed || 0, dailyReplyLimit: 20, dailyResetDate: now.toISOString().slice(0, 10) };
    return p.loadPrompt("group-reply", { groupname: g.name || "Prieteni", numberofparticipants: String(people.length), pollvotes: "- You CANNOT see poll votes: no gateway sends them here." })
        + `\n\n[Context] Right now it is ${u.currentTimeString(g.timezone || "Europe/Bucharest")}. Use this for any date/time reasoning.`
        + `\n\n[Group roster] Besides you there are ${people.length} people in this group, and this is all of them: ${people.join(", ")}.`
        + `\n\n[Connected services] none — nothing is connected to this group yet.`
        + `\n\n${u.groupStanding(stored)}`
        + (u.isNewcomer(stored.addedAt) ? `\n\n${p.loadPrompt("group-newcomer")}` : "")
        + (g.rules?.length ? `\n\n[House rules — how THIS group has told you to behave here. They come before your own habits and before anything above about tone; every line you write here follows them, including the one you are writing now. Never say who set a rule or where.]\n${g.rules.map(r => `- ${r}`).join("\n")}` : "");
}

function dmInstructions(c: Case): string {
    const who = c.person || {};
    const number = who.number || "40700000001";
    const theirs = [...(c.history || [])].reverse().filter(([f]) => f !== "Gepetel").map(([, t]) => t);
    const language = who.language || u.conversationLanguage([...(String(c.message || "").startsWith("[") ? [] : [String(c.message || "")]), ...theirs].slice(0, 6), `${number}@s.whatsapp.net`);
    return p.loadPrompt("dm", { author: who.name || "Ana", groups: "(none — you do not share any group with this person yet)", userId: `${number}@s.whatsapp.net`, botPhone: u.BOT_PHONE_DISPLAY })
        + `\n\n[Context] Right now it is ${u.currentTimeString(who.timezone || "Europe/Bucharest")}. Use this for any date/time reasoning.`
        + `\n\n[Language] They are writing in ${language}: write your whole reply in that language — whatever the language of earlier messages, pasted text, pages or tool results.`
        + `\n\n[Connected services in THIS private chat] none.`
        + (c.note ? `\n\n${c.note}` : "");
}

const CANNED: Record<string, any> = {
    set_house_rule: { ok: true, tell_the_group: "at most one short line that you've got it — or just a 👍. Then follow it, starting with that very line." },
    only_reply_when_asked: { ok: true, tell_the_group: "you may now say, in one short line, that you'll only speak when asked — the code enforces it" },
    create_poll: { ok: true, poll_id: "p1", note: "The poll has been posted to the group." },
    set_reminder: { set: true, reminder_id: "r2" },
    cancel_my_reminder: { deleted: true },
};

async function reply(client: OpenAI, c: Case, model: string, tools: any[]): Promise<{ text: string; calls: string[] }> {
    const group = c.kind === "group";
    // Laid out as production lays it out, and with the prompt on every round.
    const first = shaped({
        model, instructions: group ? groupInstructions(c) : dmInstructions(c), tools, tool_choice: "auto",
        input: [...asInput(c.history, group), { role: "user", content: String(c.message || "") }],
    });
    let out: any = await client.responses.create(first as any);
    const calls: string[] = [];
    for (let round = 0; round < 4; round++) {
        const asked = (out.output || []).filter((i: any) => i?.type === "function_call");
        if (!asked.length) break;
        calls.push(...asked.map((i: any) => String(i.name)));
        out = await client.responses.create({
            model, previous_response_id: out.id, instructions: first.instructions, tools,
            input: asked.map((i: any) => ({ type: "function_call_output" as const, call_id: i.call_id, output: JSON.stringify(c.toolResults?.[i.name] ?? CANNED[i.name] ?? { ok: true }) })),
        } as any);
    }
    return { text: u.dropRepeatedEmoji(u.cleanWhatsAppText(String(out.output_text || "").trim()), [...(c.history || [])].reverse().find(([f]) => f === "Gepetel")?.[1] || ""), calls };
}

const one = async (client: OpenAI, instructions: string, content: string, effort: "low" | "medium" = "low") =>
    String((await client.responses.create({ model: MODELS.small(), reasoning: { effort }, instructions, input: [{ role: "user", content }] } as any)).output_text || "").trim();

/** Why a run fails, or [] when it passes. */
export function judge(e: Expect, text: string, calls: string[]): string[] {
    const why: string[] = [];
    const silent = !text || /^\W*no answer\W*$/i.test(text);
    const reaction = !!u.reactionOnly(text);
    const rx = (s: string) => new RegExp(s, "iu");
    if (e.silent && !silent) why.push("should have said nothing");
    if (e.reaction && !reaction) why.push("should have been a lone emoji");
    if (e.quiet && !(silent || reaction)) why.push("should have said nothing, or only reacted");
    for (const y of e.yes || []) if (!rx(y).test(text)) why.push(`missing /${y}/`);
    for (const n of e.no || []) if (rx(n).test(text)) why.push(`said /${n}/`);
    for (const t of e.calls || []) if (!calls.includes(t)) why.push(`did not call ${t}`);
    if (e.callsAny?.length && !e.callsAny.some(t => calls.includes(t))) why.push(`called none of ${e.callsAny.join(", ")}`);
    for (const t of e.notCalls || []) if (calls.includes(t)) why.push(`called ${t}`);
    if (e.maxChars && text.length > e.maxChars) why.push(`${text.length} characters, over ${e.maxChars}`);
    if (e.is && !new RegExp(`^\\W*${e.is}\\b`, "i").test(text)) why.push(`answered "${text.split("\n")[0].slice(0, 30)}", not ${e.is}`);
    return why;
}

async function runCase(client: OpenAI, c: Case, kit: { group: any[]; dm: any[] }, forced: string): Promise<{ why: string[]; said: string }> {
    if (c.kind === "group" || c.kind === "dm") {
        const model = forced || (c.kind === "group" ? MODELS.group() : MODELS.dm());
        const r = await reply(client, c, model, c.kind === "group" ? kit.group : kit.dm);
        return { why: judge(c.expect, r.text, r.calls), said: `${r.calls.length ? `[${r.calls.join(", ")}] ` : ""}${r.text.replace(/\s+/g, " ").slice(0, 150)}` };
    }
    const convo = (c.history || []).map(([f, t]) => `${f === "Gepetel" ? "Gepetel (me)" : f}: ${t}`).join("\n");
    const text = c.kind === "gate" ? await one(client, p.loadPrompt("should-reply"), `${c.last ? `Gepetel (me) just said: "${c.last}"\n\n` : ""}Latest group messages (last line is the new one):\n${convo}`)
        : c.kind === "work-claim" ? await one(client, p.loadPrompt("announces-work"), `${c.asked ? `What they had written:\n${c.asked}\n\n` : ""}The message about to be sent:\n${c.answer}`)
        : await one(client, `${p.loadPrompt("follow-up-decide", { author: "them" })}\n\n[Context] Right now it is ${u.currentTimeString("Europe/Bucharest")}.`, (c.history || []).map(([f, t]) => `${f}: ${t}`).join("\n"), "medium");
    return { why: judge(c.expect, text, []), said: text.replace(/\s+/g, " ").slice(0, 80) };
}

export async function main(): Promise<number> {
    const only = arg("only").toLowerCase(), runs = Math.max(1, Number(arg("runs", "1")) || 1), forced = arg("model"), min = Number(arg("min", "0.85")) || 0.85;
    const cases: Case[] = fs.readdirSync(DIR).filter(f => f.endsWith(".json")).sort()
        .flatMap(f => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) as Case[])
        .filter(c => !only || `${c.name} ${c.from || ""} ${c.kind}`.toLowerCase().includes(only));
    const client = new OpenAI();
    const kit = cases.some(c => c.kind === "group" || c.kind === "dm") ? (await import("./oai.js")).replayKit() : { group: [], dm: [] };
    console.log(`${cases.length} case(s) × ${runs} run(s) — group replies on ${forced || MODELS.group()}, 1:1 on ${forced || MODELS.dm()}, checks on ${MODELS.small()}\n`);
    let passed = 0, total = 0;
    const results = await Promise.all(cases.map(async c => {
        const rs = await Promise.all(Array.from({ length: runs }, () => runCase(client, c, kit, forced).catch(e => ({ why: [`error: ${String(e?.message || e).slice(0, 80)}`], said: "" }))));
        return { c, rs };
    }));
    for (const { c, rs } of results) {
        const ok = rs.filter(r => !r.why.length).length;
        passed += ok; total += rs.length;
        const bad = rs.find(r => r.why.length);
        console.log(`${ok === rs.length ? "ok  " : "FAIL"} ${ok}/${rs.length}  [${c.kind}] ${c.name}${bad ? `\n          ${bad.why.join("; ")}\n          said: ${bad.said}` : ""}`);
    }
    const rate = total ? passed / total : 1;
    console.log(`\n${passed}/${total} passed (${Math.round(rate * 100)}%)${rate < min ? ` — below ${Math.round(min * 100)}%` : ""}`);
    return rate < min ? 1 : 0;
}

if (process.argv[1] && path.basename(process.argv[1]) === "replay.js") main().then(code => process.exit(code)).catch(e => { console.error(e); process.exit(2); });
