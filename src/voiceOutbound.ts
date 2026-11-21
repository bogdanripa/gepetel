// Gepetel phones a business for someone (off unless VOICE_ENABLED=1 and
// VOICE_OUTBOUND=1; family only for now): "sună la Bun și rezervă o masă".
//
// The 1:1 chat finds the number and confirms with them first (dm.txt), then
// calls call_business. Twilio rings the business from Gepetel's verified
// number; once they pick up, its TwiML dials OpenAI's SIP endpoint with a
// signed x-gepetel-mission header, and the incoming-call webhook (voice.ts)
// accepts that leg with the brief below instead of the usual call prompt. The
// audio never passes through this process.
//
// After the call the transcript goes into their chat, an outcome is read out
// of it, and an ordinary 1:1 turn tells them how it went and does the next
// sensible things (the calendar, the people going) under the chat's own rules.
import crypto from "crypto";
import OpenAI from "openai";
import p from "./prompts.js";
import u from "./util.js";
import vm from "./voiceMinutes.js";
import calls from "./callLog.js";

export type Mission = {
    id: string;
    /** Whose errand: their 1:1 chat. */
    chatId: string;
    author: string;
    timezone: string;
    business_name: string;
    /** Digits with the country code, no "+". */
    phone: string;
    goal: string;
    must_have: string;
    acceptable_range: string;
    may_share: { name?: string; phone_for_booking?: string };
    questions_to_ask: string[];
    /** The language to speak to the business in. */
    call_language: string;
    createdAt: number;
    /** From the admin page: the creator plays the business in the browser. */
    test?: boolean;
    /** The creator, from his Claude connector, may have any number called —
     *  a person too. Never set from the tool's arguments. */
    anyNumber?: boolean;
};

export function outboundEnabled(env: Record<string, string | undefined> = process.env): boolean {
    return env.VOICE_ENABLED === "1" && env.VOICE_OUTBOUND === "1";
}

/** Everything a real outbound call needs is set. */
export function outboundConfigured(env: Record<string, string | undefined> = process.env): boolean {
    return outboundEnabled(env) && ["TWILIO_ACCOUNT_SID", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "VOICE_CALLER_ID", "OPENAI_PROJECT_ID", "VOICE_CALLBACK_SECRET"].every(k => !!env[k]);
}

/** A phone number as digits with the country code; "" if it isn't one.
 *  "+40 21 …", "0040…", "021 …" (national, takes `cc`) all work. */
export function businessNumber(raw: string, cc: string = "40"): string {
    const s = String(raw || "").trim();
    if (!s || /[^\d+\s().\/-]/.test(s)) return "";
    let d = s.replace(/\D/g, "");
    if (!d) return "";
    if (s.startsWith("+")) { /* international */ }
    else if (d.startsWith("00")) d = d.slice(2);
    else if (d.startsWith("0")) d = cc + d.slice(1);
    return d.length >= 8 && d.length <= 15 ? d : "";
}

/** Whether someone's call plan is `direct` (voiceMinutes.ts); injectable for tests. */
/** Their call plan, as far as phoning a business goes: trusted or not, and
 *  the call time left today. A plain boolean (old callers, tests) means
 *  trusted-or-not with time to spare. */
export type PlanOf = (chatId: string) => Promise<boolean | { direct: boolean; remainingS: number }>;
export type IsDirect = PlanOf;
const planOf: PlanOf = async chatId => { const p = await vm.plan(chatId); return { direct: p.direct, remainingS: p.remainingS }; };
async function readPlan(chatId: string, f: PlanOf): Promise<{ direct: boolean; remainingS: number }> {
    const p = await f(chatId);
    return typeof p === "boolean" ? { direct: p, remainingS: p ? 3600 : 0 } : p;
}
/** Whether a number is publicly listed for that business (oai.verifyBusinessPhone). */
export type VerifyBusiness = (name: string, digits: string) => Promise<{ verified: boolean; listing?: string }>;

/** A business call needs at least this much of today's call time. */
export const MIN_CALL_S = 60;

/** call_business is offered in anyone's 1:1 chat: the call's minutes come
 *  off their own call time (startMission checks there's enough), so it is
 *  open to all, the way calling Gepetel is. */
export async function toolAvailable(chatId: string, env: Record<string, string | undefined> = process.env, _plan?: PlanOf): Promise<boolean> {
    return outboundEnabled(env) && /^\d{8,15}@s\.whatsapp\.net$/.test(String(chatId || ""));
}

// --- Business hours: no calls to a business at night ----------------------

/** "9-22" → [9, 22]; anything odd → the default. */
export function hoursWindow(spec: string | undefined): [number, number] {
    const m = String(spec || "").match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
    if (!m) return [9, 22];
    const a = Number(m[1]), b = Number(m[2]);
    return a >= 0 && b <= 24 && a < b ? [a, b] : [9, 22];
}

/** The hour (0-23) on the wall clock in a timezone. */
export function localHour(now: Date, timezone: string): number {
    try {
        const h = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: timezone || "Europe/Bucharest" }).format(now);
        return Number(h) % 24;
    } catch { return now.getUTCHours(); }
}

export function withinHours(now: Date, timezone: string, spec?: string): boolean {
    const [a, b] = hoursWindow(spec);
    const h = localHour(now, timezone);
    return h >= a && h < b;
}

// --- Limits ----------------------------------------------------------------

const REDIAL_MS = 10 * 60_000;
const placed = new Map<string, number[]>();      // chatId → when each call went out
const lastTo = new Map<string, number>();        // `${chatId}|${digits}` → when

export type OutboundDecision = { ok: true } | { ok: false; why: string; tell: string };

/** Place the call or not — every input looked up, so it can be tested. */
export function decideOutbound(x: { available: boolean; configured: boolean; confirmed: boolean; digits: string; ownNumber: boolean; inHours: boolean; callsToday: number; maxPerDay: number; lastToSameAt?: number; again: boolean; now: number; minutesLeftS?: number; payLink?: string }): OutboundDecision {
    if (!x.available) return { ok: false, why: "outbound calls are off for this chat", tell: "Phoning businesses isn't switched on here. Say so in one line; offer the number instead." };
    if (x.minutesLeftS !== undefined && x.minutesLeftS < MIN_CALL_S) return { ok: false, why: "no call minutes left today", tell: `No call went out: today's call time is used up (a call to a business comes off it). Say so in one line${x.payLink ? `, and that they can get more call time here: ${x.payLink}` : ""}; or offer the number to call themselves.` };
    if (!x.confirmed) return { ok: false, why: "not confirmed", tell: "Not called. First tell them exactly what you'll do — the business, the number, what you'll ask for, when, under whose name — and ask if you should go ahead. Call again with user_confirmed only after a clear yes." };
    if (!x.digits) return { ok: false, why: "no valid number", tell: "That isn't a phone number I can dial. Find the business's number (their mail, their contacts, get_place_info) and confirm it with them." };
    if (x.ownNumber) return { ok: false, why: "own number", tell: "That's Gepetel's own number or theirs — not the business. Find the business's number." };
    if (!x.configured) return { ok: false, why: "phone line not set up", tell: "The phone line isn't set up yet, so no call went out. Say so in one line and give them the number to call." };
    if (!x.inHours) return { ok: false, why: "outside business hours", tell: "It's outside normal business hours there, so no call went out. Offer to do it in the morning (a reminder or a scheduled check-in), or give them the number." };
    if (x.callsToday >= x.maxPerDay) return { ok: false, why: "daily outbound limit", tell: "Today's limit of calls to businesses is reached. Say so in one line; offer to do it tomorrow." };
    if (!x.again && x.lastToSameAt && x.now - x.lastToSameAt < REDIAL_MS) return { ok: false, why: "called them minutes ago", tell: "You called this number minutes ago. Don't ring again unless they ask you to try again — then call with again: true." };
    return { ok: true };
}

/** Calls placed today (rolling 24 h) for a chat. */
function callsToday(chatId: string, now: number): number {
    const list = (placed.get(chatId) || []).filter(t => now - t < 86_400_000);
    placed.set(chatId, list);
    return list.length;
}

// --- Missions ---------------------------------------------------------------

const MISSION_TTL_MS = 3 * 60 * 60_000;
const missions = new Map<string, Mission>();

export function saveMission(m: Mission): Mission {
    const now = Date.now();
    for (const [k, v] of missions) if (now - v.createdAt > MISSION_TTL_MS) missions.delete(k);
    missions.set(m.id, m);
    return m;
}
export function getMission(id: string): Mission | undefined { return missions.get(id); }

/** How a call went, kept on its mission so it can be asked for (call_status). */
const outcomes = new Map<string, { outcome: Outcome; at: number }>();
export function recordOutcome(id: string, outcome: Outcome, at: number = Date.now()): void {
    for (const [k, v] of outcomes) if (at - v.at > MISSION_TTL_MS) outcomes.delete(k);
    outcomes.set(id, { outcome, at });
}

/** Where a call stands, for the person who sent it — nobody else's. A call
 *  still without an outcome long after it went out was most likely never
 *  picked up (no answer, busy): no voice session ever started. */
export function missionStatus(id: string, chatId: string, now: number = Date.now()): { status: "calling" | "done" | "no-outcome" | "unknown"; business?: string; outcome?: Outcome } {
    const m = missions.get(String(id || ""));
    if (!m || m.chatId !== chatId) return { status: "unknown" };
    const o = outcomes.get(m.id);
    if (o) return { status: "done", business: m.business_name, outcome: o.outcome };
    return { status: now - m.createdAt > 15 * 60_000 ? "no-outcome" : "calling", business: m.business_name };
}

/** The brief from the tool's arguments, tidied; null if it can't be a call. */
export function missionFrom(args: any, ctx: { chatId: string; author: string; timezone: string }, cc: string = "40"): Mission | null {
    const phone = businessNumber(String(args?.phone || ""), cc);
    const name = String(args?.business_name || "").trim();
    const goal = String(args?.goal || "").trim();
    if (!name || !goal) return null;
    const qs = Array.isArray(args?.questions_to_ask) ? args.questions_to_ask : String(args?.questions_to_ask || "").split(/\n|;/);
    return {
        id: `m_${crypto.randomBytes(9).toString("hex")}`,
        chatId: ctx.chatId, author: ctx.author, timezone: ctx.timezone,
        business_name: name.slice(0, 120), phone, goal: goal.slice(0, 600),
        must_have: String(args?.must_have || "").trim().slice(0, 400),
        acceptable_range: String(args?.acceptable_range || "").trim().slice(0, 400),
        may_share: { name: String(args?.may_share?.name || "").trim().slice(0, 80) || undefined, phone_for_booking: String(args?.may_share?.phone_for_booking || "").trim().slice(0, 30) || undefined },
        questions_to_ask: qs.map((q: any) => String(q || "").trim()).filter(Boolean).slice(0, 8).map((q: string) => q.slice(0, 200)),
        call_language: String(args?.language || "Romanian").trim().slice(0, 30) || "Romanian",
        createdAt: Date.now(),
    };
}

// The mission's id rides on the SIP INVITE, signed like a call-back.
const MISSION_HEADER_TTL_S = 300;   // ring time + their pick-up before the leg reaches OpenAI

export function missionSig(id: string, ts: number, secret: string): string {
    return crypto.createHmac("sha256", secret).update(`mission.${id}.${ts}`).digest("hex").slice(0, 32);
}

/** The mission a signed SIP leg is for, or "" if none or it doesn't check out. */
export function missionIdFromHeaders(headers: { name: string; value: string }[], secret: string | undefined, nowS: number = Math.floor(Date.now() / 1000)): string {
    if (!secret) return "";
    const get = (n: string) => (headers || []).find(h => String(h?.name || "").toLowerCase() === n)?.value?.trim() || "";
    const id = get("x-gepetel-mission"), ts = Number(get("x-gepetel-ts")), sig = get("x-gepetel-sig");
    if (!/^m_[0-9a-f]{18}$/.test(id) || !Number.isFinite(ts) || !/^[0-9a-f]{32}$/.test(sig)) return "";
    if (Math.abs(nowS - ts) > MISSION_HEADER_TTL_S) return "";
    const want = Buffer.from(missionSig(id, ts, secret)), got = Buffer.from(sig);
    return want.length === got.length && crypto.timingSafeEqual(want, got) ? id : "";
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** TwiML run once the business picks up: bridge them to OpenAI with the signed mission. */
export function missionTwiml(projectId: string, id: string, ts: number, secret: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error("bad OPENAI_PROJECT_ID");
    if (!/^m_[0-9a-f]{18}$/.test(id)) throw new Error("bad mission id");
    const q = [["x-gepetel-mission", id], ["x-gepetel-ts", String(ts)], ["x-gepetel-sig", missionSig(id, ts, secret)]]
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    return `<Response><Dial><Sip>${xmlEscape(`sip:${projectId}@sip.api.openai.com;transport=tls?${q}`)}</Sip></Dial></Response>`;
}

// --- What the voice is told -------------------------------------------------

export function outboundInstructions(m: Mission, now: Date = new Date()): string {
    const share = [m.may_share.name ? `the name for the booking: ${m.may_share.name}` : "", m.may_share.phone_for_booking ? `a phone number for the booking: ${m.may_share.phone_for_booking}` : ""].filter(Boolean).join("; ");
    return p.loadPrompt("phone-outbound", {
        author: m.author || "them",
        client: m.may_share.name || m.author || "them",
        business: m.business_name,
        language: m.call_language || "Romanian",
        goal: m.goal,
        must_have: m.must_have || "(nothing beyond the goal)",
        range: m.acceptable_range || "(none — accept only exactly the goal; anything else, say you'll check and call back)",
        share: share || "(nothing — if they need a name or number, say you'll call back with it)",
        questions: m.questions_to_ask.length ? m.questions_to_ask.map(q => `- ${q}`).join("\n") : "- (none given — use judgement: see below)",
    }) + (m.anyNumber ? `\n\n[This call] ${m.business_name} may be a person rather than a business: that's expected here, so don't hang up for that. If what you're calling for says you call as yourself, it overrides how to open above: no \"on behalf of\", no introduction as an assistant — they know you, Gepetel, from WhatsApp; greet them by name like a friend (\"Bună, Anca! Gepetel aici.\"), say what you called to say, warmly and briefly, and say goodbye. Otherwise everything above stands: say who you're calling for and that you're an AI assistant, keep to the errand, be brief and polite.` : "")
      + `\n\n[Context] Right now it is ${u.currentTimeString(m.timezone || "Europe/Bucharest", now)} where ${m.author || "they"} are.`;
}

/** If nobody says anything once the line opens, Gepetel starts. */
export function openingInstructions(m: Mission): string {
    return `The line is open but they haven't said anything. In ${m.call_language || "Romanian"}, greet them and say who you are and why you're calling, in one or two short sentences, exactly as your instructions say. Then let them answer.`;
}

/** An answering machine or the network's "leave a message": hang up, say nothing. */
export function isVoicemail(text: string): boolean {
    const t = String(text || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    return /(dupa (semnal|bip|ton)|lasati un mesaj|lasa(ti)? mesaj|casuta (vocala|de mesaje)|mesageri[ae] vocala|nu (poate fi|este) (contactat|disponibil)|abonatul|leave (a|your) message|after the (tone|beep)|voicemail|mailbox|not available to take your call|is unavailable)/.test(t);
}

/** The business call as it goes into their chat's history. */
export function transcriptFor(m: Mission, lines: { who: "them" | "gepetel"; text: string }[], startedAt: Date, endedAt: Date, max = 3500): string {
    const mins = Math.max(1, Math.round((endedAt.getTime() - startedAt.getTime()) / 60000));
    const head = `[${m.test ? "Test of a call" : "Phone call"} you made for them to ${m.business_name}${m.phone ? ` (+${m.phone})` : ""}, ${u.currentTimeString(m.timezone || "Europe/Bucharest", startedAt)}, ${mins} min. Your brief: ${m.goal}]`;
    const body = lines.filter(l => l.text.trim()).map(l => `${l.who === "them" ? m.business_name : "You"}: ${l.text.trim().replace(/\s+/g, " ")}`);
    let out = body.join("\n");
    if (out.length > max) out = "…" + out.slice(out.length - max);
    return `${head}\n${out || "(nobody spoke — no answer, or the line dropped)"}`;
}

// --- Phone menus on the Live API: the model hands off, we press the key ----

/** A key (or keys) from the menu decision; "" when nothing should be pressed. */
export function keysToPress(raw: any): string {
    const k = String(raw?.press || "").replace(/\s+/g, "");
    return /^[0-9A-D*#]{1,6}$/.test(k) ? k : "";
}

/** On a business call the voice can only hand off for a phone menu: which key, if any. */
export async function resolveHandOff(client: OpenAI, m: Mission, recent: string): Promise<{ press: string; say: string }> {
    try {
        const r = await client.responses.create({
            model: "gpt-5.6-luna",
            instructions: `You help a phone assistant on a call to ${m.business_name}, whose goal is: ${m.goal}. Below is the end of the call so far. If the other side is an automated phone menu ("press 1 for…", "apăsați tasta…"), pick the key that gets closest to the goal (a reservation, a person at the restaurant, the right department); else no key.`,
            input: [{ role: "user", content: recent.slice(-2000) || "(nothing yet)" }],
            text: { format: { type: "json_schema", name: "menu", strict: true, schema: { type: "object", additionalProperties: false, required: ["press", "why"], properties: { press: { type: "string", description: "The key(s) to press, e.g. \"2\", or \"\" for none." }, why: { type: "string" } } } } },
        } as any);
        const j = JSON.parse((r as any).output_text || "{}");
        const press = keysToPress(j);
        return press
            ? { press, say: `Pressed ${press} on the phone menu (${String(j.why || "").slice(0, 120)}). Wait for what comes next; say nothing over the menu.` }
            : { press: "", say: "No lookups on this call and no key to press. Carry on yourself within your brief; if something is outside it, say you'll check and call back." };
    } catch (e: any) {
        console.error(`[voice] menu decision failed: ${calls.errLine(e)}`);
        return { press: "", say: "No lookups on this call. Carry on yourself within your brief; if something is outside it, say you'll check and call back." };
    }
}

// --- After the call -----------------------------------------------------------

export type Outcome = {
    reached: boolean;
    done: boolean;
    when: string;
    party_size: string;
    under_name: string;
    conditions: string;
    extra_info: string;
    alternatives: string;
    summary: string;
};

/** The model's JSON → an Outcome, whatever it left out. */
export function parseOutcome(text: string): Outcome {
    let j: any = {};
    try { j = JSON.parse(String(text || "").replace(/^```(json)?|```$/g, "").trim() || "{}"); } catch { j = {}; }
    const s = (v: any) => (v === null || v === undefined ? "" : String(v)).trim();
    return {
        reached: !!j.reached, done: !!j.done,
        when: s(j.when), party_size: s(j.party_size), under_name: s(j.under_name),
        conditions: s(j.conditions), extra_info: s(j.extra_info), alternatives: s(j.alternatives),
        summary: s(j.summary) || "(no summary)",
    };
}

const OUTCOME_SCHEMA = {
    type: "object", additionalProperties: false,
    required: ["reached", "done", "when", "party_size", "under_name", "conditions", "extra_info", "alternatives", "summary"],
    properties: {
        reached: { type: "boolean", description: "A person (or the business) actually answered and talked." },
        done: { type: "boolean", description: "The goal was achieved and confirmed by them (e.g. the table is booked)." },
        when: { type: "string", description: "Agreed date and time, as said; \"\" if none." },
        party_size: { type: "string" },
        under_name: { type: "string" },
        conditions: { type: "string", description: "Deposit, how long they hold the table, cancellation, anything they asked of us." },
        extra_info: { type: "string", description: "Useful things learnt: parking, terrace, address details, the occasion handled." },
        alternatives: { type: "string", description: "Other times/options they offered if the goal wasn't met." },
        summary: { type: "string", description: "Two plain sentences on how it went." },
    },
};

export async function extractOutcome(client: OpenAI, m: Mission, transcript: string): Promise<Outcome> {
    try {
        const r = await client.responses.create({
            model: "gpt-5.6-luna",
            instructions: `Read this phone call an assistant made to ${m.business_name} for ${m.author || "someone"}. The brief was: ${m.goal}. Say only what the transcript shows was said; never assume a booking that wasn't confirmed.`,
            input: [{ role: "user", content: transcript }],
            text: { format: { type: "json_schema", name: "outcome", strict: true, schema: OUTCOME_SCHEMA } },
        } as any);
        return parseOutcome((r as any).output_text || "{}");
    } catch (e: any) {
        console.error(`[voice] outcome of ${m.id} failed: ${calls.errLine(e)}`);
        return parseOutcome(JSON.stringify({ summary: "Couldn't read how the call went — check the transcript above." }));
    }
}

/** The note the 1:1 turn gets after the call: tell them, and think two steps ahead. */
export function outcomeNote(m: Mission, o: Outcome): string {
    const facts = [
        `reached: ${o.reached ? "yes" : "no"}`, `goal done: ${o.done ? "yes" : "no"}`,
        o.when && `when: ${o.when}`, o.party_size && `party: ${o.party_size}`, o.under_name && `under the name: ${o.under_name}`,
        o.conditions && `conditions: ${o.conditions}`, o.extra_info && `also learnt: ${o.extra_info}`, o.alternatives && `they offered instead: ${o.alternatives}`,
        `summary: ${o.summary}`,
    ].filter(Boolean).join("\n");
    const test = m.test ? `\nTHIS WAS A TEST CALL from the admin page (the creator played ${m.business_name}). Tell them how it went and say, in a line or two, what you WOULD now do — but do NOT create or change calendar events, send anything, or contact anyone.` : "";
    return `[note] You just phoned ${m.business_name}${m.phone ? ` (+${m.phone})` : ""} for them; the call's transcript is in this chat just above. Brief: ${m.goal}.
How it went:
${facts}${test}
Now, as a really good assistant who thinks two steps ahead:
- Tell them in a few lines how it went: what's booked (or not), and anything they need to know (deposit, how long the table is held, parking).
- If it's booked: look in their calendar that day first (search_events / list_events); update an event that's already there, never a second copy. Otherwise add it with the address, the place's phone number and the conditions in the description. Invite the people they said are going, as the calendar rules say.
- Worth offering, not doing: a reminder to leave in time; posting it to a group they share with the people going; anything that costs money.
- If it didn't work out: say what they offered instead, and suggest one or two similar places nearby (get_place_info) — ask before calling one.
- Nothing visible to others and nothing that costs money without their yes.`;
}

// --- Placing the call --------------------------------------------------------

export const CALL_BUSINESS_TOOL = {
    type: "function",
    name: "call_business",
    description: "Phone a business for them (a restaurant, a shop, a salon, a clinic's front desk) — to book, ask, confirm or change something. Only a real errand with a business, only when they asked: never a private person, never a friend \"for fun\", never a prank or a joke call, whoever asks. Use the business's own public number (their site, their listing); a number that isn't listed for that business is refused. You must have their clear yes to this exact call first (user_confirmed). The call happens on its own; when it's over you'll tell them here how it went.",
    parameters: {
        type: "object",
        properties: {
            business_name: { type: "string" },
            phone: { type: "string", description: "The business's number, as found (their mail, contacts, get_place_info). Never invent one." },
            goal: { type: "string", description: "What to get, plainly: \"a table for 4 on Friday 21 Nov at 20:00\"." },
            must_have: { type: "string", description: "What must be true for it to count (e.g. \"inside, non-smoking\")." },
            acceptable_range: { type: "string", description: "What may be accepted instead, from what they said (e.g. \"19:30–21:00, terrace OK\"). Leave empty if they gave no room." },
            may_share: { type: "object", properties: { name: { type: "string", description: "Their full name as they'd give it for a booking (\"Bogdan Ripa\"), with \"domnul\"/\"doamna\" only if they use it themselves; ask if you don't know it." }, phone_for_booking: { type: "string" } }, additionalProperties: false, description: "What Gepetel may give the business: the name for the booking (also who he says he's calling for), and a phone number only if they said so." },
            questions_to_ask: { type: "array", items: { type: "string" }, description: "Useful things to ask while on the line (parking, deposit, how long they hold the table, a cake for the birthday…)." },
            language: { type: "string", description: "Language to speak to the business in (default Romanian)." },
            user_confirmed: { type: "boolean", description: "True only after they said yes to this exact call." },
            again: { type: "boolean", description: "True only if they asked to try the same number again within minutes." },
        },
        required: ["business_name", "phone", "goal", "user_confirmed"],
        additionalProperties: false,
    },
    strict: false,
};

/** The tool: check, then ring the business. What it returns is for the model. */
export async function startMission(args: any, ctx: { chatId: string; author: string; timezone: string }, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch, plan: PlanOf = planOf, verify?: VerifyBusiness, opts: { anyNumber?: boolean } = {}): Promise<any> {
    const cc = env.VOICE_COUNTRY_CODE || "40";
    const m = missionFrom(args, ctx, cc);
    const now = Date.now();
    const digits = m?.phone || "";
    const own = !!digits && (digits === businessNumber(env.VOICE_CALLER_ID || "", cc) || digits === String(ctx.chatId).split("@")[0]);
    const mine = await readPlan(ctx.chatId, plan).catch(() => ({ direct: false, remainingS: 0 }));
    const d = decideOutbound({
        available: await toolAvailable(ctx.chatId, env), configured: outboundConfigured(env), confirmed: args?.user_confirmed === true,
        digits, ownNumber: own, inHours: withinHours(new Date(now), ctx.timezone || "Europe/Bucharest", env.VOICE_OUTBOUND_HOURS),
        // Trusted plans get the full daily count; anyone else a few calls a day.
        callsToday: callsToday(ctx.chatId, now), maxPerDay: mine.direct ? Number(env.VOICE_OUTBOUND_MAX || 10) : Number(env.VOICE_OUTBOUND_MAX_OTHERS || 3),
        minutesLeftS: mine.remainingS, payLink: vm.payLink(u.publicBaseUrl(), ctx.chatId),
        lastToSameAt: lastTo.get(`${ctx.chatId}|${digits}`), again: args?.again === true, now,
    });
    const tail = digits ? `…${digits.slice(-4)}` : "(no number)";
    if (!m) return { called: false, tell_the_user: "Not called: it needs the business's name, its number and what to get." };
    if (!d.ok) { console.log(`[voice] call to ${m.business_name} ${tail} not placed: ${d.why}`); return { called: false, reason: d.why, tell_the_user: d.tell }; }
    // Gepetel only phones businesses, on a number that business publishes
    // online — for everyone, trusted plans too. Never a private person, a
    // friend for fun, or a prank: a number nobody lists for that business
    // gets no call.
    // The one exception: the creator, from his own Claude chat (usermcp), may
    // have any number called. Still an errand, never a prank.
    if (opts.anyNumber) m.anyNumber = true;
    const v = m.anyNumber ? { verified: true, listing: "the creator's own request, from Claude" } : verify ? await verify(m.business_name, digits).catch(() => ({ verified: false })) : { verified: false };
    if (!v.verified) {
        console.log(`[voice] call to ${m.business_name} ${tail} not placed: number not listed for that business`);
        return { called: false, reason: "number not listed for that business", tell_the_user: "No call went out: that number couldn't be confirmed online as this business's own number, and Gepetel only phones businesses on the numbers they publish. Say so in one line, and offer to look up the business's official number, or give them the number to call themselves." };
    }
    console.log(`[voice] ${m.business_name} ${tail} is listed: ${(v as any).listing || "(no detail)"}`);
    saveMission(m);
    const ts = Math.floor(now / 1000);
    const body = new URLSearchParams({
        To: `+${digits}`,
        From: env.VOICE_CALLER_ID!,
        Twiml: missionTwiml(env.OPENAI_PROJECT_ID!, m.id, ts, env.VOICE_CALLBACK_SECRET!),
        Timeout: "30",
        TimeLimit: String(Math.round(Number(env.VOICE_OUTBOUND_MAX_MINUTES || 10) * 60)),
    });
    const auth = Buffer.from(`${env.TWILIO_API_KEY_SID}:${env.TWILIO_API_KEY_SECRET}`).toString("base64");
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID!)}/Calls.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body,
    }).catch((e: any) => ({ ok: false, status: 0, text: async () => String(e?.message || e) }) as any);
    if (!res.ok) {
        const why = `${res.status} ${calls.oneLine(await res.text().catch(() => ""))}`;
        console.error(`[voice] call to ${m.business_name} ${tail} failed: ${why}`);
        calls.missionPlaced(m, false, why);
        missions.delete(m.id);
        return { called: false, reason: "the phone line refused the call", tell_the_user: "The call couldn't be placed. Say so in one line and give them the number to call themselves." };
    }
    placed.set(ctx.chatId, [...(placed.get(ctx.chatId) || []), now]);
    lastTo.set(`${ctx.chatId}|${digits}`, now);
    console.log(`[voice] calling ${m.business_name} ${tail} for …${ctx.chatId.split("@")[0].slice(-4)} (${m.id})`);
    calls.missionPlaced(m, true, `Twilio ${res.status}, ${tail}`);
    return { called: true, mission: m.id, tell_the_user: "The call is going out now. Tell them in one short line that you're calling and will tell them here how it went. Don't claim anything is booked." };
}

/** A test mission from the admin page: no number, the creator plays the business. */
export function testMission(args: any, ctx: { chatId: string; author: string; timezone: string }): Mission | null {
    const m = missionFrom({ ...args, phone: args?.phone || "" }, ctx);
    if (!m) return null;
    m.test = true;
    return saveMission(m);
}

export default { MIN_CALL_S, recordOutcome, missionStatus, outboundEnabled, outboundConfigured, businessNumber, toolAvailable, hoursWindow, localHour, withinHours, decideOutbound, saveMission, getMission, missionFrom, missionSig, missionIdFromHeaders, missionTwiml, outboundInstructions, openingInstructions, isVoicemail, transcriptFor, keysToPress, resolveHandOff, parseOutcome, extractOutcome, outcomeNote, CALL_BUSINESS_TOOL, startMission, testMission };
