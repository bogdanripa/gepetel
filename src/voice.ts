// Phone calls (off unless VOICE_ENABLED=1).
//
// A call to Gepetel's number is forwarded by the carrier to a SIP number, whose
// trunk points at OpenAI's SIP endpoint. OpenAI posts `live.transport.incoming`
// (gpt-live-1, the default) or `realtime.call.incoming` (VOICE_MODEL=gpt-realtime-*)
// here; we decide who is calling, accept with a voice prompt, and watch the
// call over the sideband WebSocket. The audio never passes through this
// process.
//
// The voice model knows nothing by itself. Everything that needs their data or
// does something goes through ONE tool, ask_gepetel, which runs an ordinary
// 1:1 turn (oai.generateReply) — the same prompt, memory, connectors, tools,
// wall and confirmations as their WhatsApp chat — and hands back the answer to
// be said out loud. Nothing about tools is duplicated here, and a call can
// never see more than the chat could.
import crypto from "crypto";
import WebSocket from "ws";
import OpenAI from "openai";
import p from "./prompts.js";
import u from "./util.js";
import quality from "./voiceQuality.js";
import steps, { type Step } from "./steps.js";
import vm from "./voiceMinutes.js";
import outbound, { type Mission } from "./voiceOutbound.js";
import calls, { type Direction } from "./callLog.js";

/** Who a call is with, and — on a call Gepetel placed to a business — the brief. */
export type Who = { author: string; language: string; timezone: string; aboutThem: string; mission?: Mission; calledBack?: boolean; dialled?: boolean };

/** A header from the SIP INVITE, as OpenAI sends it. */
export type SipHeader = { name: string; value: string };

export function enabled(env: Record<string, string | undefined> = process.env): boolean {
    return env.VOICE_ENABLED === "1";
}

/** A number as WhatsApp keys a person: digits with the country code, no "+".
 *  "+40722…", "0040722…", "40722…" and the national "0722…" all give
 *  "40722…" (the national form takes `cc`). "" for anything that isn't one. */
export function normalizeNumber(raw: string, cc: string = "40"): string {
    let s = String(raw || "").trim();
    s = s.replace(/^(sips?|tel):/i, "").split(/[@;?]/)[0];
    if (/[^\d+\s().-]/.test(s)) return "";
    const plus = s.trim().startsWith("+");
    let d = s.replace(/\D/g, "");
    if (!d) return "";
    if (plus) { /* already international */ }
    else if (d.startsWith("00")) d = d.slice(2);
    else if (d.startsWith("0")) d = cc + d.slice(1);
    return d.length >= 8 && d.length <= 15 ? d : "";
}

/** The caller's number from the INVITE. P-Asserted-Identity is the network's
 *  own claim and wins; then Remote-Party-ID; then From. Untrusted either way —
 *  a caller ID can be spoofed — which is why only a `direct` plan is answered on it. */
export function callerDigits(headers: SipHeader[], cc: string = "40"): string {
    const get = (n: string) => (headers || []).find(h => String(h?.name || "").toLowerCase() === n)?.value || "";
    for (const name of ["p-asserted-identity", "remote-party-id", "from"]) {
        const v = get(name);
        if (!v) continue;
        // Inside <…> if there is one: `"Ana" <sip:+40722…@host>;tag=…`.
        const uri = (v.match(/<([^>]+)>/)?.[1] || v).trim();
        const d = normalizeNumber(uri, cc);
        if (d) return d;
    }
    return "";
}

export type Decision = { accept: true } | { accept: false; status: number; why: string };

/** Accept or not — every input already looked up, so it can be tested. */
export function decide(x: { enabled: boolean; digits: string; allowed: boolean; knownUser: boolean; busy: boolean; quotaAllowed: boolean }): Decision {
    if (!x.enabled) return { accept: false, status: 480, why: "voice is off" };
    if (!x.digits) return { accept: false, status: 403, why: "no caller number" };
    if (!x.allowed) return { accept: false, status: 403, why: "not answered on this caller ID" };
    if (!x.knownUser) return { accept: false, status: 403, why: "no 1:1 chat with this number" };
    if (x.busy) return { accept: false, status: 486, why: "already on a call" };
    if (!x.quotaAllowed) return { accept: false, status: 486, why: "1:1 limit reached" };
    return { accept: true };
}

/** The voice model's instructions: the phone prompt, now, and their card. */
export function instructions(x: { author: string; language: string; timezone: string; aboutThem: string; now?: Date }): string {
    return p.loadPrompt("phone-call", { author: x.author || "them", language: x.language || "Romanian" })
        + `\n\n[Context] Right now it is ${u.currentTimeString(x.timezone, x.now || new Date())}.`
        + (x.aboutThem ? `\n${x.aboutThem}` : "");
}

/** Voices that read as a young guy; the test page lets the creator compare them. */
export const MALE_VOICES = ["verse", "cedar", "ash", "echo", "ballad"];

/** The name to greet them by: the first word of how they're known. */
export function firstName(author: string): string {
    const n = String(author || "").trim().split(/\s+/)[0] || "";
    return /^[\p{L}][\p{L}'’-]*$/u.test(n) ? n : "";
}

/** What to say on picking up. On a call-back Gepetel is the caller, so he
 *  waits for them: this is what he says once they've answered. */
export function greeting(language: string, calledBack: boolean, author = ""): string {
    const n = firstName(author);
    const ro = n ? `Salut ${n}, Ge-Pe-Tel aici` : "Salut, Ge-Pe-Tel aici";
    const en = n ? `Hey ${n}, this is Jeh-Peh-Tel` : "Hey, this is Jeh-Peh-Tel";
    return calledBack
        ? `You rang them back: they tried to call you on WhatsApp, which you can't answer, so you called their phone. They have just picked up and said hello. Answer in ${language} with just this: in Romanian "${ro}, am văzut că m-ai sunat", in English "${en}, saw you called", in another language the same few words. Then stop and let them talk.`
        : `Answer the phone in ${language} with exactly this and nothing more: in Romanian "${ro}", in English "${en}", in another language the same few words. Then stop and let them talk.`;
}

/** A call-back they picked up but haven't said anything on yet. */
export function silentLine(language: string, author = ""): string {
    const n = firstName(author);
    return `They picked up but haven't said anything yet. Ask only this, in ${language}: in Romanian "${n ? `Alo, vorbesc cu ${n}?` : "Alo?"}", in English "${n ? `Hello? Is this ${n}?` : "Hello?"}". Then wait for them.`;
}

/** How a phone call hears turns (see sessionConfig). */
// "high" cut him off on every breath of line noise; "low" left long pauses
// after a short "Alo?" (2026-11-21). "medium" is the middle.
export const TURN_DETECTION = { type: "semantic_vad" as const, eagerness: "medium" as const };

/** After a dialled call is answered and nobody speaks: opening, "are you there?", goodbye. */
export const SILENCE_LADDER_MS = [4000, 10_000, 16_000];

export function stillThereLine(language: string): string {
    return `They still haven't said anything. Ask once, briefly, in ${language}, whether they can hear you: in Romanian "Alo? Mă auziți?", in English "Hello? Can you hear me?". Then wait.`;
}

export function silentByeLine(language: string): string {
    return `Nobody has answered on the line. Say only, in ${language}, that it seems they can't hear you and you'll try again later: in Romanian "Se pare că nu se aude. Revin mai târziu. O zi bună!", in English "Seems you can't hear me, I'll try again later. Bye!". Nothing else.`;
}

/** On a call-back he waits this long for them to speak first. */
export const CALLBACK_WAIT_MS = 4000;

/** What a call-back's session knows from the start, so the first thing they
 *  say gets the right opening without a separate nudge. */
function callbackOpening(who: { author: string; language: string; calledBack?: boolean }): string {
    return who.calledBack ? `\n\n[This call] ${greeting(who.language || "Romanian", true, who.author)}` : "";
}

export const ASK_TOOL = {
    type: "function" as const,
    name: "ask_gepetel",
    description: "Everything that needs their data or does something: mail, calendar, reminders, contacts, memory, groups, their computer, the web, sending anything. Runs exactly like their WhatsApp chat and returns the answer to say back to them.",
    parameters: {
        type: "object",
        properties: { request: { type: "string", description: "What they asked, in their words, with anything from this call that it needs." } },
        required: ["request"],
    },
};

export const END_TOOL = {
    type: "function" as const,
    name: "end_call",
    description: "Hang up, after you've said goodbye.",
    parameters: { type: "object", properties: {} },
};

export type Line = { who: "them" | "gepetel"; text: string };

/** The name as spoken ("Ge-Pe-Tel", "Jeh-Peh-Tel", "Ge Pe Tel") written back as Gepetel. */
export function writtenName(text: string): string {
    return String(text).replace(/\b(?:Ge|Je|Jeh|Dje|Dge)[\s\-‐–.]+(?:Pe|Peh)[\s\-‐–.]+Tel\b/gi, "Gepetel");
}

/** The call as it goes into the chat's history: one message, newest kept. */
export function transcript(lines: Line[], startedAt: Date, endedAt: Date, timezone: string, max = 3500): string {
    const mins = Math.max(1, Math.round((endedAt.getTime() - startedAt.getTime()) / 60000));
    const head = `[Phone call with them, ${u.currentTimeString(timezone, startedAt)}, ${mins} min]`;
    const body = lines.filter(l => l.text.trim()).map(l => `${l.who === "them" ? "Them" : "You"}: ${writtenName(l.text.trim().replace(/\s+/g, " "))}`);
    let out = body.join("\n");
    if (out.length > max) out = "…" + out.slice(out.length - max);
    return `${head}\n${out || "(nothing was said)"}`;
}

/** In an answer during a call: what follows this line goes to their WhatsApp. */
export const CHAT_MARK = "[[whatsapp]]";

/** An answer during a call, split into what is said and what is sent to the
 *  chat. Without the mark it is all said (2026-11-21: "Ți-am pus și în chat
 *  informația" — nothing ever went, a call's answer was only spoken). */
export function splitForChat(answer: string): { spoken: string; chat: string } {
    const t = String(answer || "");
    const i = t.toLowerCase().indexOf(CHAT_MARK);
    if (i < 0) return { spoken: t.trim(), chat: "" };
    return { spoken: t.slice(0, i).trim(), chat: t.slice(i + CHAT_MARK.length).trim() };
}

/** What the voice is handed after the chat part went out, or didn't. */
export function spokenAfterSend(spoken: string, chat: string, sent: boolean): string {
    if (!chat) return spoken;
    return `${spoken}\n(${sent ? "The written details were just sent to their WhatsApp chat; you may say so." : "Sending the written details to WhatsApp FAILED: don't say they were sent."})`;
}

/** The note an ask_gepetel request carries into the chat turn. */
export function askNote(request: string, lines: Line[]): string {
    const so = lines.slice(-12).map(l => `${l.who === "them" ? "Them" : "You"}: ${l.text.trim()}`).join("\n");
    return `[On a phone call with them right now. What you answer is read out loud to them: a few short plain sentences, no lists, no links, no numbers or codes to copy. Anything they should have in writing (a link, an address, a number, a list) goes AFTER a line with just ${CHAT_MARK} at the end of your answer: that part is sent to them on WhatsApp, the rest is said. Only say you've sent something if it's below that line.${so ? `\nSo far in the call:\n${so}` : ""}]\n${request}`;
}


/** What the call runs with: the same for a phone call and a browser test call. */
/** A hint, not a lock, for writing down what the caller says. Locking one
 *  language broke callers who switch mid-call; no hint at all wrote spoken
 *  Romanian down as Turkish ("Tadık çare var", 2026-11-17). */
export function transcriptionHint(language: string): string {
    const l = String(language || "").trim() || "Romanian";
    return `The speaker is talking to an assistant named Gepetel (said Ge-Pe-Tel); write that name as Gepetel. The speaker usually speaks ${l}, and may switch to English or another language mid-call, even mid-sentence. Write every phrase in the language actually spoken, with its own spelling and diacritics; never translate.`;
}

export function sessionConfig(who: Who, env: Record<string, string | undefined> = process.env) {
    return {
        type: "realtime" as const,
        model: env.VOICE_MODEL || "gpt-realtime-2.1",
        instructions: who.mission ? outbound.outboundInstructions(who.mission) : instructions({ author: who.author, language: who.language, timezone: who.timezone, aboutThem: who.aboutThem }) + callbackOpening(who),
        audio: {
            // A phone line carries noise, breathing and echo of his own voice: on
            // "high" every bit of it cut him off mid-sentence (2026-11-21, the
            // call to Anca). Filter it, and wait for real speech.
            input: { transcription: { model: "gpt-4o-transcribe", prompt: transcriptionHint(who.language) }, noise_reduction: { type: "near_field" }, turn_detection: who.dialled ? { ...TURN_DETECTION, create_response: false, interrupt_response: false } : TURN_DETECTION },
            output: { voice: env.VOICE_VOICE || LIVE_VOICE, speed: Math.min(1.5, Math.max(0.25, Number(env.VOICE_SPEED) || 1.2)) },
        },
        // A business call has nothing to look up: only hanging up.
        tools: who.mission ? [END_TOOL] : [ASK_TOOL, END_TOOL],
        tool_choice: "auto" as const,
    };
}

// ---------------------------------------------------------------------------
// Narration while ask_gepetel runs: a spoken "thinking" line, like a status
// box, driven by what the reply is actually doing (steps.ts) — "Mă uit în
// calendarul de mâine…", "Am găsit trei, acum le citesc…" — with a timed
// "still on it" when a step goes quiet. Long silences on a call are awkward.

/** What the voice model is told to say for a step, or for a quiet stretch. */
export function progressInstructions(language: string, what: string, fallback: boolean): string {
    const lang = language || "Romanian";
    const head = fallback
        ? `ask_gepetel is still running${what ? ` (last step: ${what})` : ""}. In one short sentence in ${lang}, say what you're still doing, naming it (e.g. "Încă mă uit prin calendar…").`
        : `ask_gepetel is working: ${what}. In one very short sentence in ${lang}, say that, as what you're doing right now (e.g. "Mă uit în calendarul de mâine…", "Am găsit trei, acum le citesc…").`;
    return `${head} Don't answer yet, don't repeat an earlier line, and say nothing from inside their mail, calendar or files beyond what they asked about. If they spoke a different language just now, use theirs.`;
}

/** Times one ask, says its steps, and keeps the line from going silent. */
export class Narrator {
    private startedAt = 0;
    private lastSpokenAt = 0;
    private lastStepAt = 0;
    private pending = "";
    private lastWhat = "";
    private fallbacks = 0;
    private resultIn = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private timeline: string[] = [];
    constructor(private speak: (what: string, fallback: boolean) => void, private speaking: () => boolean, private now: () => number = Date.now) {}
    start(): void {
        this.startedAt = this.lastSpokenAt = this.now();
        this.timer = setInterval(() => this.tick(), 500);
    }
    step(st: Step): void {
        if (this.resultIn) return;
        const what = steps.describeStep(st);
        this.timeline.push(`+${((this.now() - this.startedAt) / 1000).toFixed(1)} ${st.phase} ${st.kind}${st.server ? ` ${st.server}` : ""}${st.name ? `.${st.name}` : ""}${typeof st.count === "number" ? ` (${st.count})` : ""}`);
        if (!what) return;
        this.pending = this.lastWhat = what;
        this.lastStepAt = this.now();
        this.tick();
    }
    tick(): void {
        if (this.resultIn) return;
        const now = this.now();
        const speaking = this.speaking();
        // A gap is counted from the end of anything said, not its start.
        if (speaking) this.lastSpokenAt = now;
        const d = steps.progressDecision({ now, askStartedAt: this.startedAt, lastSpokenAt: this.lastSpokenAt, lastStepAt: this.lastStepAt, pendingStep: !!this.pending, speaking, resultIn: this.resultIn, fallbacks: this.fallbacks });
        if (d === "none") return;
        if (d === "step") { this.speak(this.pending, false); this.pending = ""; }
        else { this.speak(this.lastWhat, true); this.fallbacks++; }
        this.lastSpokenAt = now;
    }
    /** The answer is in: stop, and say where the time went. */
    finish(): string {
        this.resultIn = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        return `${((this.now() - this.startedAt) / 1000).toFixed(1)}s${this.timeline.length ? ` [${this.timeline.join(" · ")}]` : " [no steps]"}`;
    }
}

/** The call id from the Location of a WebRTC call ("/v1/realtime/calls/rtc_123"). */
export function callIdFromLocation(location: string | null | undefined): string {
    const last = String(location || "").split("?")[0].split("/").filter(Boolean).pop() || "";
    return /^[A-Za-z0-9_-]+$/.test(last) ? last : "";
}

/** The head of a call's transcript; a browser test call says it is one. */
export function markTest(text: string, test: boolean): string {
    return test ? text.replace(/^\[Phone call with them/, "[Test call from the admin page (not a real phone call)") : text;
}

// ---------------------------------------------------------------------------
// A test call from the admin page: the browser's microphone over WebRTC, the
// same session, greeting, tools and sideband as a phone call. Always as the
// creator's own chat — the page is behind the admin password and never speaks
// as anyone else.

/** Browser SDP offer → OpenAI's SDP answer; the call then runs like a phone call. */
export async function startBrowserCall(offerSdp: string, chatId: string, deps: VoiceDeps, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch, mission?: Mission): Promise<{ status: number; sdp?: string; why?: string }> {
    if (!offerSdp.startsWith("v=")) return { status: 400, why: "not an SDP offer" };
    if (!chatId) return { status: 400, why: "CREATOR_PHONE is not set" };
    if (live.has(chatId)) return { status: 409, why: "already on a call" };
    const found = await deps.lookup(chatId);
    if (!found.known) return { status: 404, why: "no 1:1 chat with Gepetel on this number" };
    // The outbound test: the creator plays the business, in the call's language.
    const who = mission ? { ...found, language: mission.call_language, mission } : found;
    if (isLiveModel(env.VOICE_MODEL)) return startLiveBrowserCall(offerSdp, chatId, who, deps, env, fetchImpl);
    const fd = new FormData();
    fd.set("sdp", offerSdp);
    fd.set("session", JSON.stringify(sessionConfig(who, env)));
    const r = await fetchImpl("https://api.openai.com/v1/realtime/calls", { method: "POST", headers: { Authorization: `Bearer ${env.OPENAI_API_KEY || ""}` }, body: fd });
    const body = await r.text();
    if (!r.ok) { console.error(`[voice] test call refused by OpenAI: ${r.status} ${calls.oneLine(body)}`); return { status: 502, why: `OpenAI said ${r.status}` }; }
    const callId = callIdFromLocation(r.headers.get("location"));
    if (!callId) return { status: 502, why: "no call id from OpenAI" };
    live.set(chatId, callId);
    console.log(`[voice] test call from the admin page (${callId})`);
    void runCall(callId, chatId, { ...who, test: true }, deps, env).catch(e => console.error(`[voice] test call ${callId}: ${calls.errLine(e)}`)).finally(() => live.delete(chatId));
    return { status: 200, sdp: body };
}

// ---------------------------------------------------------------------------
// gpt-live-1 (OpenAI's newer Live API), test page only for now. A different
// protocol for the same call: the session is created with JSON at
// /v1/live/sessions and watched at /v1/live/sessions/{id}/attach; there are no
// function tools — the model *delegates* (session.delegation.created, with no
// text: the request is what they just said), and the answer goes back as
// session.commentary.append on that delegation, which the model puts into its
// own words. Progress lines go the same way. It can't hang up by itself.

export const LIVE_MODEL = "gpt-live-1";
export function isLiveModel(model: string | undefined): boolean { return model === LIVE_MODEL; }

const LIVE_NOTE = `

On this line you have no tools called ask_gepetel or end_call. Wherever these instructions say to call ask_gepetel, hand the request off (delegate) instead: your backend is Gepetel's WhatsApp brain, with their mail, calendar, reminders and computer, and what it finds comes back to you to say. Say your short lead-in first, as above. You can't hang up: when they say goodbye, just say goodbye.`;

/** The phone voice on gpt-live-1, picked by ear on the test page (2026-11-17). */
export const LIVE_VOICE = "ballad";

/** Phone calls go through the Live API unless VOICE_MODEL names a Realtime model. */
export function phoneUsesLive(env: Record<string, string | undefined> = process.env): boolean {
    return !env.VOICE_MODEL || isLiveModel(env.VOICE_MODEL);
}

/** The Live session: same instructions as any call, delegation for the lookups. */
const LIVE_OUTBOUND_NOTE = `

On this line you have no end_call tool and can't hang up: after your goodbye, just stop — the line is cut for you. If the other side is an automated phone menu, hand off (delegate) and the right key is pressed for you; for anything else, don't hand off.`;

export function liveSession(who: Who, env: Record<string, string | undefined> = process.env) {
    return {
        model: LIVE_MODEL,
        instructions: who.mission ? outbound.outboundInstructions(who.mission) + LIVE_OUTBOUND_NOTE : instructions({ author: who.author, language: who.language, timezone: who.timezone, aboutThem: who.aboutThem }) + callbackOpening(who) + LIVE_NOTE,
        audio: { output: { voice: env.VOICE_VOICE || LIVE_VOICE } },
        delegation: { type: "client" },
    };
}

/** POST /v1/live/sessions body for a browser (WebRTC) test call. */
export function liveSessionBody(who: Who, offerSdp: string, env: Record<string, string | undefined> = process.env) {
    return { session: liveSession(who, env), transport: { type: "webrtc", sdp: offerSdp } };
}

/** POST /v1/live/sessions/{id}/accept body for a phone (SIP) call: SIP negotiates the audio format. */
export function liveAcceptBody(who: Who, env: Record<string, string | undefined> = process.env) {
    return { session: { type: "live", ...liveSession(who, env) } };
}

/**
 * Is this a goodbye? gpt-live-1 can't hang up by itself, so the relay does it
 * once a goodbye has been said. Looks at the end of a line only, without
 * diacritics, Romanian and English.
 */
export function isGoodbye(text: string): boolean {
    const t = String(text || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
    if (!t) return false;
    const tail = t.split(" ").slice(-6).join(" ");
    return /\b(la revedere|pa pa|ciao|pe curand|ne auzim|ne vedem|o zi buna|o seara buna|noapte buna|te pup|va pup|numai bine|bye|goodbye|bye bye|see you|see ya|talk (to you )?(soon|later)|take care|have a (good|nice|great) (one|day|evening|night))\b/.test(tail)
        || /(^| )pa$/.test(tail);
}

/** How long after a goodbye's last word the line is cut: the audio trails the transcript. */
export const GOODBYE_GRACE_MS = 2500;

/** What they asked for in a delegation: their words since the last hand-off. */
export function delegatedRequest(lines: Line[], from: number): string {
    const said = lines.slice(from).filter(l => l.who === "them").map(l => l.text.trim()).filter(Boolean);
    if (said.length) return said.join(" ");
    const last = [...lines].reverse().find(l => l.who === "them");
    return last ? last.text.trim() : "";
}

/** A transcript delta onto the running lines: same speaker continues the line. */
export function addDelta(lines: Line[], who: Line["who"], delta: string): void {
    const last = lines[lines.length - 1];
    if (last && last.who === who) last.text += delta;
    else lines.push({ who, text: delta });
}

async function startLiveBrowserCall(offerSdp: string, chatId: string, who: Who, deps: VoiceDeps, env: Record<string, string | undefined>, fetchImpl: typeof fetch): Promise<{ status: number; sdp?: string; why?: string }> {
    const r = await fetchImpl("https://api.openai.com/v1/live/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY || ""}`, "Content-Type": "application/json" },
        body: JSON.stringify(liveSessionBody(who, offerSdp, env)),
    });
    const text = await r.text();
    if (!r.ok) { console.error(`[voice] live test call refused by OpenAI: ${r.status} ${calls.oneLine(text)}`); return { status: 502, why: `OpenAI said ${r.status}: ${text.slice(0, 200)}` }; }
    let j: any = {};
    try { j = JSON.parse(text); } catch { /* below */ }
    const sessionId = String(j?.session?.id || "");
    const sdp = String(j?.transport?.sdp || "");
    if (!sessionId || !sdp) return { status: 502, why: "no session id or SDP answer from OpenAI" };
    live.set(chatId, sessionId);
    console.log(`[voice] live test call from the admin page (${sessionId})`);
    void runLiveCall(sessionId, chatId, { ...who, test: true }, deps, env).catch(e => console.error(`[voice] live test call ${sessionId}: ${calls.errLine(e)}`)).finally(() => { live.delete(chatId); closers.delete(chatId); });
    return { status: 200, sdp };
}

function runLiveCall(sessionId: string, chatId: string, who: { author: string; language: string; timezone: string; test?: boolean; calledBack?: boolean; sip?: boolean; limitS?: number; mission?: Mission; lineKey?: string }, deps: VoiceDeps, env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Promise<void> {
    return new Promise(resolve => {
        const startedAt = new Date();
        const q = quality.begin(sessionId, LIVE_MODEL);
        const rec = callRecord(sessionId, chatId, who, LIVE_MODEL, who.sip ? "live" : "webrtc");
        const lines: Line[] = [];
        const seenEvents = new Set<string>();
        let handedOffAt = 0;          // lines index of the last hand-off
        let lastOut = 0, lastIn = 0;  // when each side last said something
        let greeted = false, finished = false, closing = false;
        let theyByeAt = -1;           // lines index of their goodbye, if any
        let byeTimer: ReturnType<typeof setTimeout> | undefined;
        const ws = new WebSocket(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`, {
            headers: { Authorization: `Bearer ${env.OPENAI_API_KEY || ""}` },
        });
        let n = 0;
        const send = (o: any) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event_id: `gep_${Date.now()}_${n++}`, ...o })); };
        // A phone call is hung up (the docs: keep the sideband open until
        // session.closed); a browser session is closed from the socket.
        const close = (why = "hung up from the admin page") => {
            if (closing) return;
            closing = true;
            rec.hungUp(why);
            if (who.sip) {
                void fetchImpl(`https://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/hangup`, { method: "POST", headers: { Authorization: `Bearer ${env.OPENAI_API_KEY || ""}` } })
                    .then(async r => { if (!r.ok) { const t = calls.oneLine(await r.text().catch(() => "")); console.error(`[voice] ${sessionId} hangup failed: ${r.status} ${t}`); rec.ev("hangup failed", `${r.status} ${t}`); } })
                    .catch(e => { console.error(`[voice] ${sessionId} hangup failed: ${calls.errLine(e)}`); rec.ev("hangup failed", calls.errLine(e)); });
                setTimeout(() => ws.close(), 15_000);
            } else {
                send({ type: "session.close" });
                setTimeout(() => ws.close(), 5000);
            }
        };
        closers.set(who.lineKey || chatId, close);
        // A cap on the cost of one call, and today's minutes.
        const timers = vm.callTimers(who.test ? undefined : who.limitS, Number(who.mission ? env.VOICE_OUTBOUND_MAX_MINUTES || 10 : env.VOICE_MAX_MINUTES || 15));
        const cap = setTimeout(() => { console.log(`[voice] ${sessionId}: time limit, closing`); close("time limit"); }, timers.endAtMs);
        // A business call: they speak first; on hold for 5 minutes, give up.
        let heardThem = false;
        const idleMs = 5 * 60_000;
        let idle: ReturnType<typeof setTimeout> | undefined;
        const stillThere = () => { if (!who.mission) return; clearTimeout(idle); idle = setTimeout(() => { console.log(`[voice] ${sessionId}: nobody for 5 minutes, giving up`); close("nobody for 5 minutes"); }, idleMs); };
        const wrap = timers.wrapAtMs !== null ? setTimeout(() => {
            console.log(`[voice] ${sessionId}: today's call time almost up, wrapping up`);
            rec.ev("wrap-up sent");
            send({ type: "session.commentary.append", delegation_id: null, content: wrapUpInstructions(who.language) });
        }, timers.wrapAtMs) : undefined;
        // It can't hang up by itself: once Gepetel's line ends in a goodbye, or
        // ends after theirs did, cut the line when its audio has played out.
        const afterOutput = () => {
            clearTimeout(byeTimer);
            byeTimer = setTimeout(() => {
                const mine = [...lines].reverse().find(l => l.who === "gepetel");
                const mineIdx = mine ? lines.lastIndexOf(mine) : -1;
                if (mine && (isGoodbye(mine.text) || (theyByeAt >= 0 && mineIdx > theyByeAt))) {
                    console.log(`[voice] ${sessionId}: goodbye said, hanging up`);
                    close("goodbye");
                }
            }, GOODBYE_GRACE_MS);
        };
        const greet = () => {
            if (greeted) return;
            greeted = true;
            if (who.mission) {
                // They pick up and speak first; only a silent line gets our opening.
                if (!heardThem) { rec.ev("opening sent", "nobody spoke first"); send({ type: "session.commentary.append", delegation_id: null, content: outbound.openingInstructions(who.mission) }); }
                return;
            }
            if (who.calledBack) {
                // We rang them: they speak first; a silent line gets "alo?".
                if (!heardThem) { rec.ev("silent-line sent", "nobody spoke first"); send({ type: "session.commentary.append", delegation_id: null, content: silentLine(who.language, who.author) }); }
                return;
            }
            rec.ev("greeting sent");
            send({ type: "session.commentary.append", delegation_id: null, content: greeting(who.language, false, who.author) });
        };
        const finish = async () => {
            if (finished) return;
            finished = true;
            clearTimeout(cap);
            clearTimeout(wrap);
            clearTimeout(byeTimer);
            clearTimeout(idle);
            const billed = await countMinutes(chatId, who, startedAt, deps);
            const said = lines.map(l => ({ ...l, text: l.text.trim() })).filter(l => l.text);
            rec.end(said, billed);
            const text = who.mission ? outbound.transcriptFor(who.mission, said, startedAt, new Date()) : markTest(transcript(said, startedAt, new Date(), who.timezone), !!who.test);
            console.log(`[voice] ${sessionId} ended after ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s, ${lines.length} lines`);
            { const log = q.end(s => { rec.quality = s; rec.flush(); }); if (who.test) quality.finishTest(chatId, log); else log(); }
            rec.flush();
            await deps.remember(chatId, sessionId, text, who.author, who.mission ? undefined : { lines, test: !!who.test }).catch(e => console.error(`[voice] saving the call failed: ${calls.errLine(e)}`));
            if (who.mission && deps.missionDone) void deps.missionDone(who.mission, text).catch(e => console.error(`[voice] after the call to ${who.mission?.business_name}: ${calls.errLine(e)}`));
            resolve();
        };
        // The docs: greet once the session has started; attaching replays the
        // last 3 s, which may or may not include session.started. A business
        // call waits longer: whoever picks up says hello first.
        ws.on("open", () => { rec.connected(); setTimeout(greet, who.mission ? 5000 : who.calledBack ? CALLBACK_WAIT_MS : 1500); stillThere(); });
        ws.on("message", async (buf: WebSocket.RawData) => {
            let ev: any;
            try { ev = JSON.parse(buf.toString()); } catch { return; }
            if (ev.event_id) {
                if (seenEvents.has(ev.event_id)) return;
                seenEvents.add(ev.event_id);
            }
            q.event(ev);
            if (ev.type === "session.started") { rec.ev("session started"); if (!who.mission && !who.calledBack) greet(); }
            else if (ev.type === "session.input_transcript.delta" && ev.delta) {
                addDelta(lines, "them", String(ev.delta)); lastIn = Date.now(); rec.them();
                heardThem = true; stillThere();
                clearTimeout(byeTimer);   // they're still talking
                if (who.mission && outbound.isVoicemail(lines[lines.length - 1].text)) { console.log(`[voice] ${sessionId}: voicemail, hanging up`); close("voicemail"); return; }
                const last = lines[lines.length - 1];
                theyByeAt = isGoodbye(last.text) ? lines.length - 1 : (theyByeAt === lines.length - 1 ? -1 : theyByeAt);
            }
            else if (ev.type === "session.output_transcript.delta" && ev.delta) { addDelta(lines, "gepetel", String(ev.delta)); lastOut = Date.now(); rec.us(); afterOutput(); }
            else if (ev.type === "session.delegation.created" && who.mission) {
                // On a business call the only hand-off is a phone menu: press the key.
                const delegationId = String(ev.delegation?.id || ev.delegation_id || ev.id || "");
                const recent = lines.slice(-8).map(l => `${l.who === "them" ? who.mission!.business_name : "You"}: ${l.text.trim()}`).join("\n");
                const h = await outbound.resolveHandOff(deps.client, who.mission, recent);
                if (h.press && who.sip) for (const k of h.press) send({ type: "transport.dtmf.send", event: k });
                console.log(`[voice] ${sessionId} hand-off on a business call: ${h.press ? `pressed ${h.press}` : "no key"}`);
                rec.ev("hand-off (phone menu)", h.press ? `pressed ${h.press}` : "no key");
                send({ type: "session.commentary.append", delegation_id: delegationId, content: who.sip || !h.press ? h.say : `(Test call, no real keypad: imagine you pressed ${h.press}.) ${h.say}` });
            }
            else if (ev.type === "session.delegation.created") {
                const delegationId = String(ev.delegation?.id || ev.delegation_id || ev.id || "");
                const request = delegatedRequest(lines, handedOffAt);
                handedOffAt = lines.length;
                console.log(`[voice] ${sessionId} hand-off ${delegationId}: ${request.slice(0, 200)}`);
                rec.ev("ask", request.slice(0, 200));
                const askedAt = Date.now();
                const narrator = new Narrator(
                    (what, fallback) => send({ type: "session.commentary.append", delegation_id: delegationId, content: progressInstructions(who.language, what, fallback) }),
                    () => Date.now() - lastOut < 800 || Date.now() - lastIn < 800,
                );
                narrator.start();
                let answer = "";
                try { answer = await deps.ask(chatId, who.author, askNote(request, lines), st => narrator.step(st)); }
                catch (e: any) { answer = "Something went wrong on my side — tell them to try again in a minute, or write in the chat."; console.error(`[voice] ${sessionId} ask failed: ${calls.errLine(e)}`); rec.ev("ask failed", calls.errLine(e)); }
                const took = narrator.finish();
                console.log(`[voice] ${sessionId} ask took ${took}`);
                rec.ask(request, Date.now() - askedAt, took);
                send({ type: "session.commentary.append", delegation_id: delegationId, content: `The answer (say it back faithfully, spoken): ${answer || "(nothing to say)"}` });
            } else if (ev.type === "session.closed") {
                console.log(`[voice] ${sessionId} closed: ${calls.oneLine(ev.reason || "?")}`);
                rec.ev("session closed", ev.reason || "?");
                rec.hungUp(`closed: ${calls.oneLine(ev.reason || "?", 200)}`);
                ws.close();
            } else if (ev.type === "error") {
                console.error(`[voice] ${sessionId} error: ${calls.oneLine(JSON.stringify(ev.error || ev))}`);
                rec.ev("error", JSON.stringify(ev.error || ev));
            }
        });
        ws.on("close", (code: number) => { rec.ev("socket closed", String(code || "")); void finish(); });
        ws.on("error", (e: any) => { console.error(`[voice] ${sessionId} socket: ${calls.errLine(e)}`); rec.hungUp(`socket error: ${calls.errLine(e, 200)}`); void finish(); });
    });
}

/** What the voice is told when today's call time is nearly over. */
export function wrapUpInstructions(language: string): string {
    return `Today's call time is almost up — about half a minute left. In ${language}, in one or two short sentences: tell them warmly the time's nearly up, finish what you were saying, mention that they'll get a link on WhatsApp if they want more call time, and say goodbye. Don't start anything new.`;
}

/** A limited call's seconds go on today's count; used up → the note with the link. */
async function countMinutes(chatId: string, who: { test?: boolean; limitS?: number; mission?: Mission }, startedAt: Date, deps: VoiceDeps): Promise<number> {
    // A call to a business counts too: on the time of whoever sent it.
    if (who.test || who.mission?.test || (who.limitS === undefined && !who.mission) || !deps.minutes) return 0;
    const billed = vm.billedSeconds(startedAt, new Date());
    try {
        const left = await deps.minutes.used(chatId, billed);
        console.log(`[voice] …${chatId.split("@")[0].slice(-4)}: ${left}s of call time left today`);
        if (left <= 0) await deps.minutes.limitNote(chatId);
    } catch (e: any) { console.error(`[voice] counting call minutes failed: ${calls.errLine(e)}`); }
    return billed;
}

/** Which way a call goes, for its record. */
export function callDirection(who: { test?: boolean; mission?: Mission; calledBack?: boolean }): Direction {
    return who.test || who.mission?.test ? "browser-test" : who.mission ? "outbound-mission" : who.calledBack ? "callback" : "inbound";
}

/** The call's record (callLog.ts): the one its announcement opened, or a new one. */
function callRecord(id: string, chatId: string, who: { author: string; test?: boolean; mission?: Mission; calledBack?: boolean }, model: string, route: string) {
    const rec = calls.ensure(id, { direction: callDirection(who), model, chatId, name: who.author, business: who.mission?.business_name, missionId: who.mission?.id, test: !!who.test || !!who.mission?.test });
    if (!rec.route) rec.set({ route });
    if (!rec.tail && chatId) rec.set({ tail: `…${chatId.split("@")[0].slice(-4)}` });
    return rec;
}

// ---------------------------------------------------------------------------
// Calling back after a WhatsApp call.
//
// WhatsApp calls can't be answered (the gateway rejects them). Instead Twilio
// rings the person on the phone line from Gepetel's own number (a verified
// caller ID) and connects them to OpenAI's SIP endpoint. On that leg the SIP
// From is Gepetel's number, not theirs, so the call carries who it is for in
// x- headers, signed: x-gepetel-for (digits), x-gepetel-ts (unix seconds),
// x-gepetel-sig (HMAC of both). Without a valid signature the header is
// ignored and the usual caller-ID rules apply.

const CALLBACK_TTL_S = 120;

export function callbackSig(digits: string, ts: number, secret: string): string {
    return crypto.createHmac("sha256", secret).update(`${digits}.${ts}`).digest("hex").slice(0, 32);
}

/** The number a signed call-back is for, or "" if there is none or it doesn't check out. */
export function callbackFor(headers: SipHeader[], secret: string | undefined, nowS: number = Math.floor(Date.now() / 1000)): string {
    if (!secret) return "";
    const get = (n: string) => (headers || []).find(h => String(h?.name || "").toLowerCase() === n)?.value?.trim() || "";
    const digits = get("x-gepetel-for"), ts = Number(get("x-gepetel-ts")), sig = get("x-gepetel-sig");
    if (!/^\d{8,15}$/.test(digits) || !Number.isFinite(ts) || !/^[0-9a-f]{32}$/.test(sig)) return "";
    if (Math.abs(nowS - ts) > CALLBACK_TTL_S) return "";
    const want = Buffer.from(callbackSig(digits, ts, secret)), got = Buffer.from(sig);
    return want.length === got.length && crypto.timingSafeEqual(want, got) ? digits : "";
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** TwiML for the call-back leg: dial OpenAI's SIP endpoint with the signed x- headers. */
export function callbackTwiml(projectId: string, digits: string, ts: number, secret: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error("bad OPENAI_PROJECT_ID");
    if (!/^\d{8,15}$/.test(digits)) throw new Error("bad number");
    const q = [["x-gepetel-for", digits], ["x-gepetel-ts", String(ts)], ["x-gepetel-sig", callbackSig(digits, ts, secret)]]
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    const uri = `sip:${projectId}@sip.api.openai.com;transport=tls?${q}`;
    return `<Response><Dial><Sip>${xmlEscape(uri)}</Sip></Dial></Response>`;
}

/** Everything a call-back needs is set. */
export function callbackConfigured(env: Record<string, string | undefined> = process.env): boolean {
    return enabled(env) && ["TWILIO_ACCOUNT_SID", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "VOICE_CALLER_ID", "OPENAI_PROJECT_ID", "VOICE_CALLBACK_SECRET"].every(k => !!env[k]);
}

const calledBack = new Map<string, number>();   // digits → when we last rang them

export type CallbackDecision = { ring: true } | { ring: false; why: string; note?: boolean };

/** Ring them back or not — inputs looked up, so it can be tested. */
export function decideCallback(x: { configured: boolean; group: boolean; digits: string; direct: boolean; knownUser: boolean; busy: boolean; lastAt?: number; now: number; free?: number; remainingS?: number }): CallbackDecision {
    if (!x.configured) return { ring: false, why: "call-back not configured" };
    if (x.group) return { ring: false, why: "group call" };
    if (!x.digits) return { ring: false, why: "no number" };
    if (!x.knownUser) return { ring: false, why: "no 1:1 chat with this number" };
    // Anyone who talks to Gepetel 1:1 is rung back within today's minutes
    // (voiceMinutes.ts); with none left they get the note with the link.
    const left = (x.remainingS || 0) > 0;
    if (!left && !x.direct && !((x.free || 0) > 0)) return { ring: false, why: "calls are off" };
    if (!left) return { ring: false, why: "no call minutes left today", note: true };
    if (x.busy) return { ring: false, why: "already on a call" };
    if (x.lastAt && x.now - x.lastAt < CALLBACK_TTL_S * 1000) return { ring: false, why: "rang them back moments ago" };
    return { ring: true };
}

/**
 * A WhatsApp call came in (already rejected by the gateway). Returns true when
 * it is handled here — rung back, or deliberately left alone (busy, just rung)
 * — and false when the caller should get the usual "write to me" note.
 */
export async function callBack(from: string, opts: { group?: boolean; knownUser: (chatId: string) => Promise<boolean>; fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; minutes?: VoiceMinutesDeps }): Promise<boolean> {
    const env = opts.env || process.env;
    const digits = normalizeNumber(from.startsWith("+") ? from : `+${u.phoneDigits(from)}`);
    const chatId = digits ? `${digits}@s.whatsapp.net` : "";
    const configured = callbackConfigured(env);
    // Without call minutes nobody is rung back.
    const mayAsk = configured && !opts.group && !!digits && !!opts.minutes;
    const knownUser = mayAsk ? await opts.knownUser(chatId) : false;
    const remainingS = knownUser && opts.minutes ? await opts.minutes.remaining(chatId) : 0;
    const direct = knownUser && opts.minutes ? await opts.minutes.direct(chatId) : false;
    // Their own daily minutes matter only to tell "used up" from "calls are off".
    const free = knownUser && opts.minutes && remainingS <= 0 ? await allowanceOf(opts.minutes, chatId, env) : 0;
    const d = decideCallback({
        configured, group: !!opts.group, digits, direct, knownUser,
        busy: live.has(chatId), lastAt: calledBack.get(digits), now: Date.now(),
        free, remainingS,
    });
    const tail = digits ? `…${digits.slice(-4)}` : "(no number)";
    if (!d.ring) {
        console.log(`[voice] call from ${tail}: not calling back (${d.why})`);
        if (d.note && opts.minutes) { await opts.minutes.limitNote(chatId).catch(e => console.error(`[voice] limit note for ${tail} failed: ${calls.errLine(e)}`)); return true; }
        return configured && (d.why === "already on a call" || d.why === "rang them back moments ago");
    }
    calledBack.set(digits, Date.now());
    for (const [k, t] of calledBack) if (Date.now() - t > 3_600_000) calledBack.delete(k);
    const ts = Math.floor(Date.now() / 1000);
    // Gepetel first, then their phone rings (voiceOutbound.dialFirstBody).
    const body = outbound.dialFirstBody({
        sip: outbound.sipUri(env.OPENAI_PROJECT_ID!, [["x-gepetel-for", digits], ["x-gepetel-ts", String(ts)], ["x-gepetel-sig", callbackSig(digits, ts, env.VOICE_CALLBACK_SECRET!)]]),
        to: digits, callerId: env.VOICE_CALLER_ID!,
        answeredUrl: outbound.answeredUrl(u.publicBaseUrl(), `cb_${digits}`, ts, env.VOICE_CALLBACK_SECRET!),
    });
    const auth = Buffer.from(`${env.TWILIO_API_KEY_SID}:${env.TWILIO_API_KEY_SECRET}`).toString("base64");
    const res = await (opts.fetchImpl || fetch)(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID!)}/Calls.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[voice] call-back to ${tail} failed: ${res.status} ${calls.oneLine(text)}`);
        calls.callbackRung(digits, ts, chatId, false, `${res.status} ${text}`);
        calledBack.delete(digits);
        return false;
    }
    console.log(`[voice] call from ${tail}: calling them back`);
    calls.callbackRung(digits, ts, chatId, true, `Twilio ${res.status}`);
    return true;
}

// ---------------------------------------------------------------------------

/** Everyone's call time and plan (voiceMinutes.ts). */
export type VoiceMinutesDeps = {
    /** Seconds left today. */
    remaining: (chatId: string) => Promise<number>;
    /** Their plan trusts their caller ID: answered directly, may phone businesses. */
    direct: (chatId: string) => Promise<boolean>;
    /** Their minutes a day; absent: VOICE_FREE_MINUTES. */
    allowance?: (chatId: string) => Promise<number>;
    /** Count a finished call; seconds left after it. */
    used: (chatId: string, seconds: number) => Promise<number>;
    /** The once-a-day "today's call time is used up" note, with the link. */
    limitNote: (chatId: string) => Promise<void>;
};

export type VoiceDeps = {
    /** Absent: no call is answered and nobody is rung back. */
    minutes?: VoiceMinutesDeps;
    client: OpenAI;
    /** Is there a 1:1 chat with them, and what to call them. */
    lookup: (chatId: string) => Promise<{ known: boolean; author: string; language: string; timezone: string; aboutThem: string }>;
    /** Count the call against their 1:1 limit. */
    claimQuota: (chatId: string) => Promise<boolean>;
    /** One ordinary 1:1 turn; the answer, not sent. */
    ask: (chatId: string, author: string, text: string, onStep?: (s: Step) => void) => Promise<string>;
    /** The finished call into their chat history. */
    remember: (chatId: string, callId: string, text: string, author: string, call?: { lines: Line[]; test: boolean }) => Promise<void>;
    /** After a call Gepetel placed to a business: tell them how it went, and the next steps. */
    missionDone?: (mission: Mission, transcript: string) => Promise<void>;
};

const live = new Map<string, string>();       // chatId → callId
const closers = new Map<string, () => void>(); // chatId → how to end a Live session

/** A call on another transport (Grok) holds the line like any other: one at a time, Hang up ends it. */
export function holdLine(chatId: string, id: string, close: () => void): boolean {
    if (live.has(chatId)) return false;
    live.set(chatId, id);
    closers.set(chatId, close);
    return true;
}
export function releaseLine(chatId: string): void { live.delete(chatId); closers.delete(chatId); }

/** End the call someone is on (the test page's Hang up). */
export async function hangUp(chatId: string, deps: { client: OpenAI }): Promise<void> {
    const close = closers.get(chatId);
    if (close) { close(); return; }
    const callId = live.get(chatId);
    if (callId) {
        calls.byId(callId)?.hungUp("hung up from the admin page");
        await deps.client.realtime.calls.hangup(callId).catch(e => console.error(`[voice] ${callId} hangup failed: ${calls.errLine(e)}`));
    }
}
const seen = new Map<string, number>();       // webhook-id → when

/** The call someone is on now, if any. */
export function liveCall(chatId: string): string { return live.get(chatId) || ""; }

/** POST body from OpenAI (raw text) → status to answer with. */
export async function handleWebhook(raw: string, headers: Record<string, any>, deps: VoiceDeps, env: Record<string, string | undefined> = process.env): Promise<number> {
    try {
        await deps.client.webhooks.verifySignature(raw, headers, env.OPENAI_WEBHOOK_SECRET);
    } catch (e: any) {
        console.error(`[voice] webhook rejected: ${calls.errLine(e)}`);
        return 400;
    }
    const id = String(headers["webhook-id"] || "");
    if (id) {
        if (seen.has(id)) { console.log(`[voice] webhook ${id} delivered again, ignored`); return 200; }
        seen.set(id, Date.now());
        for (const [k, t] of seen) if (Date.now() - t > 3_600_000) seen.delete(k);
    }
    const event = JSON.parse(raw);
    // The same pending call is announced by both APIs; exactly one of them
    // decides it (the first accept or reject wins), picked by VOICE_MODEL.
    const type = String(event?.type || "");
    const route = webhookRoute(type, String(event?.data?.type || "sip"), env);
    // Every announcement goes on its call's record (callLog.ts), the ones
    // left alone too: an ignored event used to leave no line at all.
    const note = (annId: string, sh: SipHeader[]) => {
        try {
            const callbackDigits = callbackFor(sh, env.VOICE_CALLBACK_SECRET);
            return calls.announcement(type, annId, sh, { callbackDigits, missionId: outbound.missionIdFromHeaders(sh, env.VOICE_CALLBACK_SECRET), digits: callbackDigits ? "" : callerDigits(sh, env.VOICE_COUNTRY_CODE || "40") });
        } catch (e: any) { console.error(`[voice] call log for ${annId}: ${calls.errLine(e)}`); return calls.ensure(annId); }
    };
    const failed = (annId: string) => (e: any) => { const why = calls.errLine(e); console.error(`[voice] call ${annId} failed: ${why}`); const r = calls.byId(annId); if (r) { r.ev("failed", why); if (!r.acceptedAt) { r.acceptFailed = r.acceptFailed || why; r.end([], 0); } r.flush(); } };
    if (route === "live") {
        const sessionId = String(event.data?.session_id || "");
        if (!sessionId) { console.log(`[voice] webhook ${type} without a session id, ignored`); return 200; }
        // Announced under both Live names during the migration: one decision.
        if (seen.has(`live:${sessionId}`)) { console.log(`[voice] ${sessionId}: announced again (${type}), ignored`); calls.byId(sessionId)?.ev("ignored", `${type}: announced again`); return 200; }
        seen.set(`live:${sessionId}`, Date.now());
        // A leg we dialled ourselves (a call-back, a call to a business) goes
        // out through Twilio's <Dial><Sip>, which has no SRTP, and Live SIP
        // requires it (2026-11-21: "Live SIP calls require SRTP", the line
        // dropped as Anca picked up). Leave it to the realtime announcement.
        const sh = event.data?.sip_headers || [];
        const rec = note(sessionId, sh);
        if (callbackFor(sh, env.VOICE_CALLBACK_SECRET) || outbound.missionIdFromHeaders(sh, env.VOICE_CALLBACK_SECRET)) {
            console.log(`[voice] ${sessionId}: a leg we dialled, answering it on realtime`);
            rec.ev("ignored", "a leg we dialled: left to the realtime announcement (Live SIP needs SRTP)");
            return 200;
        }
        lastLiveEventAt = Date.now();
        rec.set({ route: "live" });
        void takeLiveCall(sessionId, sh, deps, env).catch(failed(sessionId));
    } else if (route === "realtime") {
        const callId = String(event.data?.call_id || "");
        if (!callId) { console.log(`[voice] webhook ${type} without a call id, ignored`); return 200; }
        note(callId, event.data?.sip_headers || []).set({ route: "realtime" });
        void takeCall(callId, event.data?.sip_headers || [], deps, env).catch(failed(callId));
    } else if (route === "realtime-fallback") {
        const callId = String(event.data?.call_id || "");
        if (!callId) { console.log(`[voice] webhook ${type} without a call id, ignored`); return 200; }
        // A leg we dialled ourselves never goes to Live (no SRTP): take it now,
        // every second counts before OpenAI drops the INVITE.
        const sh = event.data?.sip_headers || [];
        const rec = note(callId, sh);
        if (callbackFor(sh, env.VOICE_CALLBACK_SECRET) || outbound.missionIdFromHeaders(sh, env.VOICE_CALLBACK_SECRET)) {
            console.log(`[voice] ${callId}: a leg we dialled, taking it on realtime now`);
            rec.set({ route: "realtime" }).ev("taking it now", "a leg we dialled: realtime at once");
            void takeCall(callId, sh, deps, env).catch(failed(callId));
            return 200;
        }
        // Live gets first go; if no Live announcement shows up, take it here
        // rather than let it ring out.
        const since = Date.now();
        rec.ev("waiting for Live", `${LIVE_GRACE_MS} ms`);
        setTimeout(() => {
            // A Live announcement just before or during the wait has it, unless that accept failed.
            if (lastLiveEventAt >= since - 10_000) {
                console.log(`[voice] ${callId}: Live has this call, realtime announcement ignored`);
                rec.ev("ignored", "Live has this call");
                rec.flush();
                return;
            }
            console.log(`[voice] ${callId}: no Live announcement, answering on realtime`);
            rec.set({ route: "realtime-fallback" }).ev("no Live announcement", "answering on realtime");
            void takeCall(callId, event.data?.sip_headers || [], deps, env).catch(failed(callId));
        }, LIVE_GRACE_MS);
    } else {
        const annId = String(event?.data?.session_id || event?.data?.call_id || event?.id || "?");
        console.log(`[voice] webhook ${type || "?"} (${String(event?.data?.type || "-")}, ${annId}) ignored: not an incoming call this route takes`);
    }
    return 200;
}

/** Which handler decides an incoming-call webhook, or none. With Live as the
 *  choice, a realtime announcement is the fallback ("realtime-fallback"): the
 *  project's webhook may only send realtime.call.incoming (2026-11-21: every
 *  call was answered 200 and dropped, because Live never got its event). */
export function webhookRoute(type: string, transport: string, env: Record<string, string | undefined> = process.env): "live" | "realtime" | "realtime-fallback" | null {
    if (phoneUsesLive(env)) {
        if ((type === "live.transport.incoming" || type === "live.call.incoming") && transport === "sip") return "live";
        return type === "realtime.call.incoming" ? "realtime-fallback" : null;
    }
    return type === "realtime.call.incoming" ? "realtime" : null;
}

/** How long a realtime announcement waits for the Live one before taking the call itself. */
export const LIVE_GRACE_MS = 2000;
let lastLiveEventAt = 0;

/** Who is calling, and may they — the same checks for both APIs. */
async function screenCall(headers: SipHeader[], deps: VoiceDeps, env: Record<string, string | undefined>) {
    // A signed call-back says who it is for; otherwise the caller ID.
    const forWhom = callbackFor(headers, env.VOICE_CALLBACK_SECRET);
    const digits = forWhom || callerDigits(headers, env.VOICE_COUNTRY_CODE || "40");
    const chatId = digits ? `${digits}@s.whatsapp.net` : "";
    const who = chatId ? await deps.lookup(chatId) : null;
    // Everyone talks within today's minutes (voiceMinutes.ts). A `direct` plan
    // is answered on its caller ID; anyone else only on our own signed
    // call-back — their caller ID alone proves nothing.
    const known = !!who?.known && !!deps.minutes;
    const direct = known ? await deps.minutes!.direct(chatId) : false;
    const remainingS = known ? await deps.minutes!.remaining(chatId) : 0;
    const free = known && remainingS <= 0 ? await allowanceOf(deps.minutes!, chatId, env) : 0;
    const route = vm.routeCall({ digits, direct, knownUser: !!who?.known, signedLeg: !!forWhom, free, remainingS });
    const allowed = route.route === "answer";
    let d = decide({
        enabled: enabled(env), digits, allowed,
        knownUser: !!who?.known, busy: live.has(chatId),
        // Counted only for a call that would otherwise be taken.
        quotaAllowed: allowed && !!who?.known && !live.has(chatId) ? await deps.claimQuota(chatId) : true,
    });
    if (!d.accept && enabled(env) && digits && !allowed) {
        d = route.route === "callback" ? { accept: false, status: 603, why: "caller ID not trusted: ringing them back on their own number" }
            : route.route === "limit-note" ? { accept: false, status: 603, why: "no call minutes left today" }
            : route.route === "reject" ? { accept: false, status: 403, why: route.why } : d;
    }
    const limitS = route.route === "answer" && route.limited ? route.remainingS : undefined;
    return { d, who, chatId, digits, route: route.route, limitS, calledBack: !!forWhom, tail: digits ? `…${digits.slice(-4)}` : "(no number)" };
}

/** Their minutes a day, for telling "used up" from "calls are off". */
async function allowanceOf(minutes: VoiceMinutesDeps, chatId: string, env: Record<string, string | undefined>): Promise<number> {
    return minutes.allowance ? minutes.allowance(chatId) : vm.freeMinutes(env);
}

/** After turning a call down: someone not answered on their caller ID is rung back, or told today's time is used up. */
function afterReject(route: string, digits: string, deps: VoiceDeps, env: Record<string, string | undefined>): void {
    if (!deps.minutes || (route !== "callback" && route !== "limit-note")) return;
    void callBack(`+${digits}`, { knownUser: async () => true, minutes: deps.minutes, env })
        .catch(e => console.error(`[voice] ringing …${digits.slice(-4)} back failed: ${calls.errLine(e)}`));
}

/** A signed leg of a call Gepetel placed to a business (voiceOutbound.ts), if this is one. */
function missionOf(headers: SipHeader[], env: Record<string, string | undefined>): Mission | undefined {
    if (!outbound.outboundEnabled(env)) return undefined;
    const id = outbound.missionIdFromHeaders(headers, env.VOICE_CALLBACK_SECRET);
    return id ? outbound.getMission(id) : undefined;
}

/** The business on the line, as the call code sees "who". */
async function missionWho(m: Mission, deps: VoiceDeps): Promise<Who> {
    // The brief already has what the call needs; looking them up (history,
    // memory) took seconds the other side spent hearing a ring tone, and
    // OpenAI dropped the call before it was accepted (2026-11-21).
    const them = m.author && m.timezone ? null : await deps.lookup(m.chatId).catch(() => null);
    return { author: m.author || them?.author || "", language: m.call_language, timezone: m.timezone || them?.timezone || "Europe/Bucharest", aboutThem: "", mission: m };
}

/** The screen's decision onto the call's record. */
function screened(rec: ReturnType<typeof calls.ensure>, d: Decision, who: { author: string } | null, chatId: string, tail: string, route: string, limitS: number | undefined, calledBack: boolean): void {
    rec.set({ chatId, name: who?.author || "", tail: tail.startsWith("…") ? tail : "", direction: calledBack ? "callback" : undefined });
    rec.ev("screened", d.accept ? `accept (${route}${limitS !== undefined ? `, ${limitS}s left today` : ""})` : `reject ${d.status}: ${d.why} (${route})`);
}

/** A call turned down: its record is finished (a call-back, if any, is its own record). */
function rejected(rec: ReturnType<typeof calls.ensure>, route: string): void {
    rec.rejected = rec.timeline.filter(e => e.event === "screened").pop()?.detail?.replace(/^reject /, "") || "rejected";
    if (route === "callback") rec.ev("ringing them back");
    else if (route === "limit-note") rec.ev("limit note");
    rec.end([], 0);
    rec.flush();
}

async function takeLiveCall(sessionId: string, headers: SipHeader[], deps: VoiceDeps, env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Promise<void> {
    const api = (what: string, body: any) => fetchImpl(`https://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/${what}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY || ""}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const rec = calls.ensure(sessionId).set({ model: LIVE_MODEL, route: "live" });
    const acceptFailed = async (r: any, what: string) => {
        const body = calls.oneLine(await r.text().catch(() => ""));
        rec.acceptFailed = `${r.status} ${body}`;
        rec.ev("accept failed", rec.acceptFailed);
        rec.flush();
        console.error(`[voice] ${sessionId} accept failed for ${what}: ${r.status} ${body}`);
    };
    const mission = missionOf(headers, env);
    if (mission) {
        // Our own call to a business: the brief, not the caller checks.
        const mw = await missionWho(mission, deps);
        rec.set({ direction: "outbound-mission", chatId: mission.chatId, name: mw.author, business: mission.business_name, missionId: mission.id, test: !!mission.test }).ev("screened", `the call to ${mission.business_name}`);
        const key = `mission:${mission.id}`;
        live.set(key, sessionId);
        rec.ev("accept sent");
        const r = await api("accept", liveAcceptBody(mw, env)).catch(e => ({ ok: false, status: 0, text: async () => calls.errLine(e) }) as any);
        if (!r.ok) { live.delete(key); await acceptFailed(r, `the call to ${mission.business_name}`); return; }
        console.log(`[voice] ${sessionId} accepted in ${rec.accepted()} ms (route ${rec.route}, call to ${mission.business_name})`);
        rec.flush();
        console.log(`[voice] call to ${mission.business_name} connected on ${LIVE_MODEL} (${sessionId})`);
        await runLiveCall(sessionId, mission.chatId, { ...mw, sip: true, lineKey: key }, deps, env, fetchImpl)
            .finally(() => { live.delete(key); closers.delete(key); });
        return;
    }
    const { d, who, chatId, digits, route, limitS, calledBack, tail } = await screenCall(headers, deps, env);
    screened(rec, d, who, chatId, tail, route, limitS, calledBack);
    if (!d.accept) {
        console.log(`[voice] call from ${tail} rejected: ${d.why}`);
        const r = await api("reject", { status_code: d.status }).catch(e => { console.error(`[voice] ${sessionId} reject failed: ${calls.errLine(e)}`); rec.ev("reject failed", calls.errLine(e)); return null; });
        if (r && !r.ok) { const t = calls.oneLine(await r.text().catch(() => "")); console.error(`[voice] ${sessionId} reject failed: ${r.status} ${t}`); rec.ev("reject failed", `${r.status} ${t}`); }
        rejected(rec, route);
        afterReject(route, digits, deps, env);
        return;
    }
    live.set(chatId, sessionId);
    rec.ev("accept sent");
    const r = await api("accept", liveAcceptBody({ ...who!, calledBack }, env)).catch(e => ({ ok: false, status: 0, text: async () => calls.errLine(e) }) as any);
    if (!r.ok) {
        live.delete(chatId);
        lastLiveEventAt = 0;   // Live couldn't take it: the realtime announcement may
        await acceptFailed(r, tail);
        return;
    }
    console.log(`[voice] ${sessionId} accepted in ${rec.accepted()} ms (route ${rec.route})`);
    rec.flush();
    console.log(`[voice] call from ${tail} accepted on ${LIVE_MODEL} (${sessionId})`);
    await runLiveCall(sessionId, chatId, { ...who!, calledBack, sip: true, limitS }, deps, env, fetchImpl)
        .finally(() => { live.delete(chatId); closers.delete(chatId); });
}

async function takeCall(callId: string, headers: SipHeader[], deps: VoiceDeps, env: Record<string, string | undefined>): Promise<void> {
    const rec = calls.ensure(callId).set({ model: env.VOICE_MODEL || "gpt-realtime-2.1" });
    const acceptFailed = (e: any, what: string) => {
        rec.acceptFailed = calls.errLine(e);
        rec.ev("accept failed", rec.acceptFailed);
        rec.flush();
        console.error(`[voice] ${callId} accept failed for ${what}: ${rec.acceptFailed}`);
    };
    const mission = missionOf(headers, env);
    if (mission) {
        const mw = await missionWho(mission, deps);
        rec.set({ direction: "outbound-mission", chatId: mission.chatId, name: mw.author, business: mission.business_name, missionId: mission.id, test: !!mission.test }).ev("screened", `the call to ${mission.business_name}`);
        rec.ev("accept sent");
        try { await deps.client.realtime.calls.accept(callId, sessionConfig({ ...mw, dialled: true }, env) as any); }
        catch (e: any) { acceptFailed(e, `the call to ${mission.business_name}`); return; }
        console.log(`[voice] ${callId} accepted in ${rec.accepted()} ms (route ${rec.route || "realtime"}, call to ${mission.business_name})`);
        rec.flush();
        console.log(`[voice] call to ${mission.business_name} connected (${callId})`);
        await runCall(callId, mission.chatId, mw, deps, env);
        return;
    }
    const { d, who, chatId, digits, route, limitS, calledBack: calledBackLeg, tail } = await screenCall(headers, deps, env);
    screened(rec, d, who, chatId, tail, route, limitS, calledBackLeg);
    if (!d.accept) {
        console.log(`[voice] call from ${tail} rejected: ${d.why}`);
        await deps.client.realtime.calls.reject(callId, { status_code: d.status }).catch(e => { console.error(`[voice] ${callId} reject failed: ${calls.errLine(e)}`); rec.ev("reject failed", calls.errLine(e)); });
        rejected(rec, route);
        afterReject(route, digits, deps, env);
        return;
    }
    live.set(chatId, callId);
    rec.ev("accept sent");
    try {
        await deps.client.realtime.calls.accept(callId, sessionConfig({ ...who!, calledBack: calledBackLeg, dialled: calledBackLeg }, env) as any);
    } catch (e: any) {
        live.delete(chatId);
        acceptFailed(e, tail);
        return;
    }
    console.log(`[voice] ${callId} accepted in ${rec.accepted()} ms (route ${rec.route || "realtime"})`);
    rec.flush();
    console.log(`[voice] call from ${tail} accepted (${callId})`);
    await runCall(callId, chatId, { ...who!, calledBack: calledBackLeg, limitS }, deps, env).finally(() => live.delete(chatId));
}

/**
 * How a call's control socket is reached and ended. The default is OpenAI's
 * sideband for a Realtime call; Grok (voiceGrok.ts) brings its own socket,
 * session setup and audio relay but shares everything else — the tools, the
 * narration, the transcript into history.
 */
export type CallIO = {
    open: () => WebSocket;
    hangup: () => void | Promise<unknown>;
    /** First thing on open (default: the greeting). */
    onOpen?: (send: (o: any) => void) => void;
    /** Extra fields on a status line's response.create (OpenAI: no tools). */
    progressExtra?: Record<string, any>;
    /** Every event, before the shared handling; may add lines of its own. */
    onEvent?: (ev: any, lines: Line[]) => void;
    /** A finished ask, for the test page's timing. */
    onAsk?: (request: string, seconds: number) => void;
};

export function runCall(callId: string, chatId: string, who: { author: string; language: string; timezone: string; calledBack?: boolean; test?: boolean; limitS?: number; mission?: Mission }, deps: VoiceDeps, env: Record<string, string | undefined>, io?: CallIO): Promise<void> {
    return new Promise(resolve => {
        const startedAt = new Date();
        const q = quality.begin(callId, io ? "grok-voice" : (env.VOICE_MODEL || "gpt-realtime-2.1"));
        const rec = callRecord(callId, chatId, who, io ? "grok-voice" : (env.VOICE_MODEL || "gpt-realtime-2.1"), io ? "grok" : "webrtc");
        const lines: Line[] = [];
        const ws = io ? io.open() : new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, {
            headers: { Authorization: `Bearer ${env.OPENAI_API_KEY || ""}` },
        });
        const send = (o: any) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
        const hangup = () => io ? Promise.resolve(io.hangup()) : deps.client.realtime.calls.hangup(callId).catch(() => {});
        // A cap on the cost of one call, and today's minutes.
        const timers = vm.callTimers(who.test ? undefined : who.limitS, Number(who.mission ? env.VOICE_OUTBOUND_MAX_MINUTES || 10 : env.VOICE_MAX_MINUTES || 15));
        const cap = setTimeout(() => { console.log(`[voice] ${callId}: time limit, hanging up`); rec.hungUp("time limit"); void hangup(); }, timers.endAtMs);
        // A business call: they speak first; on hold for 5 minutes, give up.
        let heardThem = false;
        let idle: ReturnType<typeof setTimeout> | undefined;
        const stillThere = () => { if (!who.mission) return; clearTimeout(idle); idle = setTimeout(() => { console.log(`[voice] ${callId}: nobody for 5 minutes, giving up`); rec.hungUp("nobody for 5 minutes"); void hangup(); }, 5 * 60_000); };
        let opener: ReturnType<typeof setTimeout> | undefined;
        // A leg we dialled (dial-first): their phone is still ringing when the
        // session opens. Nothing is said, and nothing they "say" counts, until
        // Twilio reports the answer; then the silence ladder runs.
        const dialled = !io && !who.test && (!!who.mission || !!who.calledBack);
        const answerKey = who.mission ? who.mission.id : `cb_${chatId.split("@")[0]}`;
        let answered = !dialled;
        const ladder: ReturnType<typeof setTimeout>[] = [];
        const say = (instructions: string, what: string) => { if (heardThem || responding) return; responding = true; rec.ev(what, "nobody spoke"); send({ type: "response.create", response: { instructions } }); };
        const onAnswer = () => {
            if (answered) return;
            answered = true;
            rec.ev("they answered");
            console.log(`[voice] ${callId}: they answered`);
            // Explicitly back on: a partial update kept create_response:false from
            // the ringing phase and he never answered (2026-11-21, test call).
            send({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: { ...TURN_DETECTION, create_response: true, interrupt_response: true } } } } });
            ladder.push(setTimeout(() => say(who.mission ? outbound.openingInstructions(who.mission) : silentLine(who.language, who.author), who.mission ? "opening sent" : "silent-line sent"), SILENCE_LADDER_MS[0]));
            ladder.push(setTimeout(() => say(stillThereLine(who.language), "are-you-there sent"), SILENCE_LADDER_MS[1]));
            ladder.push(setTimeout(() => {
                if (heardThem) return;
                console.log(`[voice] ${callId}: silence after the answer, hanging up`);
                say(silentByeLine(who.language), "silent-bye sent");
                rec.hungUp("silence after the answer");
                setTimeout(() => void hangup(), 4000);
            }, SILENCE_LADDER_MS[2]));
        };
        let wrapPending = false;
        const wrapUp = () => {
            console.log(`[voice] ${callId}: today's call time almost up, wrapping up`);
            if (responding) { wrapPending = true; return; }
            rec.ev("wrap-up sent");
            responding = true;
            send({ type: "response.create", response: { instructions: wrapUpInstructions(who.language), ...(io ? io.progressExtra || {} : { tool_choice: "none" }) } });
        };
        const wrap = timers.wrapAtMs !== null ? setTimeout(wrapUp, timers.wrapAtMs) : undefined;
        let finished = false;
        const finish = async () => {
            if (finished) return;
            finished = true;
            clearTimeout(cap);
            clearTimeout(wrap);
            clearTimeout(idle);
            clearTimeout(opener);
            for (const t of ladder) clearTimeout(t);
            if (dialled) outbound.offAnswered(answerKey);
            const billed = await countMinutes(chatId, who, startedAt, deps);
            rec.end(lines, billed);
            const text = who.mission ? outbound.transcriptFor(who.mission, lines, startedAt, new Date()) : markTest(transcript(lines, startedAt, new Date(), who.timezone), !!who.test);
            console.log(`[voice] ${callId} ended after ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s, ${lines.length} lines`);
            { const log = q.end(s => { rec.quality = s; rec.flush(); }); if (who.test) quality.finishTest(chatId, log); else log(); }
            rec.flush();
            await deps.remember(chatId, callId, text, who.author, who.mission ? undefined : { lines, test: !!who.test }).catch(e => console.error(`[voice] saving the call failed: ${calls.errLine(e)}`));
            if (who.mission && deps.missionDone) void deps.missionDone(who.mission, text).catch(e => console.error(`[voice] after the call to ${who.mission?.business_name}: ${calls.errLine(e)}`));
            resolve();
        };

        // Who is talking: a response being produced, or them. A status line
        // never cuts in on either, and a new response waits for the last one.
        let responding = false, theyTalk = false, createWhenDone = false, lastResponseAt = 0;
        const respond = () => { if (responding) createWhenDone = true; else { responding = true; send({ type: "response.create" }); } };
        ws.on("open", () => {
            rec.connected();
            if (io?.onOpen) { io.onOpen(send); return; }
            if (dialled) {
                // Their phone rings now; wait for the answer (or their first words).
                stillThere();
                outbound.onAnswered(answerKey, onAnswer);
                return;
            }
            if (who.mission) {
                // Whoever picks up says hello first; a silent line gets our opening.
                stillThere();
                opener = setTimeout(() => { if (!heardThem && !responding) { responding = true; rec.ev("opening sent", "nobody spoke first"); send({ type: "response.create", response: { instructions: outbound.openingInstructions(who.mission!) } }); } }, 5000);
                return;
            }
            if (who.calledBack) {
                // We rang them: they speak first; a silent line gets "alo?".
                opener = setTimeout(() => { if (!heardThem && !responding) { responding = true; rec.ev("silent-line sent", "nobody spoke first"); send({ type: "response.create", response: { instructions: silentLine(who.language, who.author) } }); } }, CALLBACK_WAIT_MS);
                return;
            }
            // Pick up the phone: a short greeting, in their language.
            rec.ev("greeting sent");
            send({ type: "response.create", response: { instructions: greeting(who.language, false, who.author) } });
        });
        ws.on("message", async (buf: WebSocket.RawData) => {
            let ev: any;
            try { ev = JSON.parse(buf.toString()); } catch { return; }
            io?.onEvent?.(ev, lines);
            q.event(ev);
            if (ev.type === "response.created") { responding = true; lastResponseAt = Date.now(); }
            else if (ev.type === "response.done") {
                responding = false;
                if (wrapPending) { wrapPending = false; wrapUp(); }
                else if (createWhenDone) { createWhenDone = false; respond(); }
            } else if (ev.type === "input_audio_buffer.speech_started") theyTalk = true;
            else if (ev.type === "input_audio_buffer.speech_stopped") theyTalk = false;
            if (ev.type === "input_audio_buffer.speech_started" && answered) { heardThem = true; stillThere(); rec.them(); }
            // Before the answer it's the ring tone — unless real words come
            // through (the notice got lost): then they did pick up.
            if (!answered && ev.type === "conversation.item.input_audio_transcription.completed" && /\p{L}{2,}/u.test(String(ev.transcript || ""))) { onAnswer(); heardThem = true; lines.push({ who: "them", text: String(ev.transcript) }); rec.them(); respond(); }
            // A dialled leg: they spoke and nothing started answering them —
            // answer anyway rather than leave them saying "alo?" into silence.
            if (dialled && answered && ev.type === "input_audio_buffer.speech_stopped") {
                const at = Date.now();
                setTimeout(() => { if (!responding && lastResponseAt < at && !finished) { rec.ev("nudged a reply", "turn detection didn't start one"); respond(); } }, 800);
            }
            if (ev.type === "error") { console.error(`[voice] ${callId} realtime error: ${calls.errLine(ev.error || ev)}`); rec.ev("realtime error", calls.errLine(ev.error || ev)); }
            if (ev.type === "conversation.item.input_audio_transcription.completed" && ev.transcript && answered) {
                lines.push({ who: "them", text: String(ev.transcript) });
                rec.them();
                if (who.mission && outbound.isVoicemail(String(ev.transcript))) { console.log(`[voice] ${callId}: voicemail, hanging up`); rec.hungUp("voicemail"); void hangup(); }
            } else if (ev.type === "response.output_audio_transcript.done" && ev.transcript) {
                lines.push({ who: "gepetel", text: String(ev.transcript) });
                rec.us();
            } else if (ev.type === "response.function_call_arguments.done") {
                let args: any = {};
                try { args = JSON.parse(ev.arguments || "{}"); } catch { /* empty */ }
                if (ev.name === "end_call") {
                    // Let the goodbye play out before the line drops.
                    rec.hungUp("end_call (goodbye)");
                    setTimeout(() => void hangup(), 2500);
                    return;
                }
                let output = "";
                if (ev.name === "ask_gepetel") {
                    const request = String(args.request || "").trim();
                    console.log(`[voice] ${callId} ask: ${request.slice(0, 200)}`);
                    rec.ev("ask", request.slice(0, 200));
                    const narrator = new Narrator((what, fallback) => {
                        responding = true;
                        send({ type: "response.create", response: { instructions: progressInstructions(who.language, what, fallback), ...(io ? io.progressExtra || {} : { tool_choice: "none" }) } });
                    }, () => responding || theyTalk);
                    narrator.start();
                    const askedAt = Date.now();
                    try { output = await deps.ask(chatId, who.author, askNote(request, lines), st => narrator.step(st)); }
                    catch (e: any) { output = "Something went wrong on my side — tell them to try again in a minute, or write in the chat."; console.error(`[voice] ${callId} ask failed: ${calls.errLine(e)}`); rec.ev("ask failed", calls.errLine(e)); }
                    const took = narrator.finish();
                    console.log(`[voice] ${callId} ask took ${took}`);
                    rec.ask(request, Date.now() - askedAt, took);
                    io?.onAsk?.(request, (Date.now() - askedAt) / 1000);
                } else {
                    console.log(`[voice] ${callId}: unknown tool ${String(ev.name || "?")}`);
                    rec.ev("unknown tool", String(ev.name || "?"));
                    output = `unknown tool: ${ev.name}`;
                }
                send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: ev.call_id, output: output || "(nothing to say)" } });
                respond();
            } else if (ev.type === "error") {
                console.error(`[voice] ${callId} error: ${calls.oneLine(JSON.stringify(ev.error || ev))}`);
                rec.ev("error", JSON.stringify(ev.error || ev));
            }
        });
        ws.on("close", (code: number) => { rec.ev("socket closed", String(code || "")); rec.hungUp("line closed"); void finish(); });
        ws.on("error", (e: any) => { console.error(`[voice] ${callId} socket: ${calls.errLine(e)}`); rec.hungUp(`socket error: ${calls.errLine(e, 200)}`); void finish(); });
    });
}

export default { TURN_DETECTION, SILENCE_LADDER_MS, stillThereLine, silentByeLine, CHAT_MARK, splitForChat, spokenAfterSend, wrapUpInstructions, holdLine, releaseLine, runCall, MALE_VOICES, LIVE_MODEL, LIVE_VOICE, isLiveModel, phoneUsesLive, liveSession, liveSessionBody, liveAcceptBody, isGoodbye, GOODBYE_GRACE_MS, webhookRoute, delegatedRequest, addDelta, hangUp, progressInstructions, Narrator, transcriptionHint, writtenName, firstName, silentLine, CALLBACK_WAIT_MS, liveCall, sessionConfig, callIdFromLocation, markTest, startBrowserCall, enabled, normalizeNumber, callerDigits, decide, instructions, greeting, transcript, askNote, handleWebhook, callbackSig, callbackFor, callbackTwiml, callbackConfigured, decideCallback, callBack, ASK_TOOL, END_TOOL };
