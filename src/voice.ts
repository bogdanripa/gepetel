// Phone calls (off unless VOICE_ENABLED=1).
//
// A call to Gepetel's number is forwarded by the carrier to a SIP number, whose
// trunk points at OpenAI's SIP endpoint. OpenAI posts `realtime.call.incoming`
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
import steps, { type Step } from "./steps.js";

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
 *  a caller ID can be spoofed — which is why calls also need VOICE_CALLERS. */
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

/** Who may call. VOICE_CALLERS is a comma list of numbers, or "*" for anyone
 *  who already talks to Gepetel 1:1. Empty means nobody: a spoofed caller ID
 *  must not open someone's mail by voice, so it is never on by accident. */
export function callerAllowed(digits: string, env: Record<string, string | undefined> = process.env): boolean {
    if (!digits) return false;
    const list = String(env.VOICE_CALLERS || "").split(",").map(s => s.trim()).filter(Boolean);
    if (list.includes("*")) return true;
    return list.map(x => normalizeNumber(x, env.VOICE_COUNTRY_CODE || "40")).includes(digits);
}

export type Decision = { accept: true } | { accept: false; status: number; why: string };

/** Accept or not — every input already looked up, so it can be tested. */
export function decide(x: { enabled: boolean; digits: string; allowed: boolean; knownUser: boolean; busy: boolean; quotaAllowed: boolean }): Decision {
    if (!x.enabled) return { accept: false, status: 480, why: "voice is off" };
    if (!x.digits) return { accept: false, status: 403, why: "no caller number" };
    if (!x.allowed) return { accept: false, status: 403, why: "caller not in VOICE_CALLERS" };
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

/** What to say on picking up. A call-back knows it is one. */
export function greeting(language: string, calledBack: boolean): string {
    return calledBack
        ? `You are calling them back: they just tried to call you on WhatsApp, which you can't answer, so you rang them on the phone. They pick up not knowing who it is, so open warmly and casually, like a friend ringing back: say it's you, Gepetel, by their first name if you know it, mention in passing that you saw their call, and ask what's up, all in one short breath in ${language}. Like "Hei Anca, eu sunt, Gepetel! Am văzut că m-ai sunat, ce faci?" or "Hey, it's me, Gepetel, saw you called, what's up?". Then let them talk.`
        : `Pick up like a friend who's glad they rang: say it's Gepetel and ask what's going on, warm and casual, in one short breath in ${language}, by first name if you know it. Like "Gepetel aici, ce se întâmplă, prietene?" or "Gepetel here, what's happening my friend?". Then let them talk.`;
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

/** The call as it goes into the chat's history: one message, newest kept. */
export function transcript(lines: Line[], startedAt: Date, endedAt: Date, timezone: string, max = 3500): string {
    const mins = Math.max(1, Math.round((endedAt.getTime() - startedAt.getTime()) / 60000));
    const head = `[Phone call with them, ${u.currentTimeString(timezone, startedAt)}, ${mins} min]`;
    const body = lines.filter(l => l.text.trim()).map(l => `${l.who === "them" ? "Them" : "You"}: ${l.text.trim().replace(/\s+/g, " ")}`);
    let out = body.join("\n");
    if (out.length > max) out = "…" + out.slice(out.length - max);
    return `${head}\n${out || "(nothing was said)"}`;
}

/** The note an ask_gepetel request carries into the chat turn. */
export function askNote(request: string, lines: Line[]): string {
    const so = lines.slice(-12).map(l => `${l.who === "them" ? "Them" : "You"}: ${l.text.trim()}`).join("\n");
    return `[On a phone call with them right now. What you answer is read out loud to them: a few short plain sentences, no lists, no links, no numbers or codes to copy — send those in this chat instead and say so.${so ? `\nSo far in the call:\n${so}` : ""}]\n${request}`;
}


/** What the call runs with: the same for a phone call and a browser test call. */
/** A hint, not a lock, for writing down what the caller says. Locking one
 *  language broke callers who switch mid-call; no hint at all wrote spoken
 *  Romanian down as Turkish ("Tadık çare var", 2026-11-17). */
export function transcriptionHint(language: string): string {
    const l = String(language || "").trim() || "Romanian";
    return `The speaker usually speaks ${l}, and may switch to English or another language mid-call, even mid-sentence. Write every phrase in the language actually spoken, with its own spelling and diacritics; never translate.`;
}

export function sessionConfig(who: { author: string; language: string; timezone: string; aboutThem: string }, env: Record<string, string | undefined> = process.env) {
    return {
        type: "realtime" as const,
        model: env.VOICE_MODEL || "gpt-realtime-2.1",
        instructions: instructions({ author: who.author, language: who.language, timezone: who.timezone, aboutThem: who.aboutThem }),
        audio: {
            input: { transcription: { model: "gpt-4o-transcribe", prompt: transcriptionHint(who.language) }, turn_detection: { type: "semantic_vad", eagerness: "high" } },
            output: { voice: env.VOICE_VOICE || "verse", speed: Math.min(1.5, Math.max(0.25, Number(env.VOICE_SPEED) || 1.2)) },
        },
        tools: [ASK_TOOL, END_TOOL],
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
export async function startBrowserCall(offerSdp: string, chatId: string, deps: VoiceDeps, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<{ status: number; sdp?: string; why?: string }> {
    if (!offerSdp.startsWith("v=")) return { status: 400, why: "not an SDP offer" };
    if (!chatId) return { status: 400, why: "CREATOR_PHONE is not set" };
    if (live.has(chatId)) return { status: 409, why: "already on a call" };
    const who = await deps.lookup(chatId);
    if (!who.known) return { status: 404, why: "no 1:1 chat with Gepetel on this number" };
    if (isLiveModel(env.VOICE_MODEL)) return startLiveBrowserCall(offerSdp, chatId, who, deps, env, fetchImpl);
    const fd = new FormData();
    fd.set("sdp", offerSdp);
    fd.set("session", JSON.stringify(sessionConfig(who, env)));
    const r = await fetchImpl("https://api.openai.com/v1/realtime/calls", { method: "POST", headers: { Authorization: `Bearer ${env.OPENAI_API_KEY || ""}` }, body: fd });
    const body = await r.text();
    if (!r.ok) { console.error(`[voice] test call refused by OpenAI: ${r.status} ${body.slice(0, 300)}`); return { status: 502, why: `OpenAI said ${r.status}` }; }
    const callId = callIdFromLocation(r.headers.get("location"));
    if (!callId) return { status: 502, why: "no call id from OpenAI" };
    live.set(chatId, callId);
    console.log(`[voice] test call from the admin page (${callId})`);
    void runCall(callId, chatId, { ...who, test: true }, deps, env).catch(e => console.error(`[voice] test call ${callId}: ${e?.message || e}`)).finally(() => live.delete(chatId));
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

/** POST /v1/live/sessions body for a browser (WebRTC) test call. */
export function liveSessionBody(who: { author: string; language: string; timezone: string; aboutThem: string }, offerSdp: string, env: Record<string, string | undefined> = process.env) {
    return {
        session: {
            model: LIVE_MODEL,
            instructions: instructions({ author: who.author, language: who.language, timezone: who.timezone, aboutThem: who.aboutThem }) + LIVE_NOTE,
            audio: { output: { voice: env.VOICE_VOICE || "verse" } },
            delegation: { type: "client" },
        },
        transport: { type: "webrtc", sdp: offerSdp },
    };
}

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

async function startLiveBrowserCall(offerSdp: string, chatId: string, who: { author: string; language: string; timezone: string; aboutThem: string }, deps: VoiceDeps, env: Record<string, string | undefined>, fetchImpl: typeof fetch): Promise<{ status: number; sdp?: string; why?: string }> {
    const r = await fetchImpl("https://api.openai.com/v1/live/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY || ""}`, "Content-Type": "application/json" },
        body: JSON.stringify(liveSessionBody(who, offerSdp, env)),
    });
    const text = await r.text();
    if (!r.ok) { console.error(`[voice] live test call refused by OpenAI: ${r.status} ${text.slice(0, 300)}`); return { status: 502, why: `OpenAI said ${r.status}: ${text.slice(0, 200)}` }; }
    let j: any = {};
    try { j = JSON.parse(text); } catch { /* below */ }
    const sessionId = String(j?.session?.id || "");
    const sdp = String(j?.transport?.sdp || "");
    if (!sessionId || !sdp) return { status: 502, why: "no session id or SDP answer from OpenAI" };
    live.set(chatId, sessionId);
    console.log(`[voice] live test call from the admin page (${sessionId})`);
    void runLiveCall(sessionId, chatId, { ...who, test: true }, deps, env).catch(e => console.error(`[voice] live test call ${sessionId}: ${e?.message || e}`)).finally(() => { live.delete(chatId); closers.delete(chatId); });
    return { status: 200, sdp };
}

function runLiveCall(sessionId: string, chatId: string, who: { author: string; language: string; timezone: string; test?: boolean }, deps: VoiceDeps, env: Record<string, string | undefined>): Promise<void> {
    return new Promise(resolve => {
        const startedAt = new Date();
        const lines: Line[] = [];
        const seenEvents = new Set<string>();
        let handedOffAt = 0;          // lines index of the last hand-off
        let lastOut = 0, lastIn = 0;  // when each side last said something
        let greeted = false, finished = false;
        const ws = new WebSocket(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`, {
            headers: { Authorization: `Bearer ${env.OPENAI_API_KEY || ""}` },
        });
        let n = 0;
        const send = (o: any) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event_id: `gep_${Date.now()}_${n++}`, ...o })); };
        const close = () => { send({ type: "session.close" }); setTimeout(() => ws.close(), 5000); };
        closers.set(chatId, close);
        const cap = setTimeout(() => { console.log(`[voice] ${sessionId}: time limit, closing`); close(); }, Number(env.VOICE_MAX_MINUTES || 15) * 60_000);
        const greet = () => {
            if (greeted) return;
            greeted = true;
            send({ type: "session.commentary.append", delegation_id: null, content: greeting(who.language, false) });
        };
        const finish = async () => {
            if (finished) return;
            finished = true;
            clearTimeout(cap);
            const text = markTest(transcript(lines.map(l => ({ ...l, text: l.text.trim() })).filter(l => l.text), startedAt, new Date(), who.timezone), !!who.test);
            console.log(`[voice] ${sessionId} ended after ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s, ${lines.length} lines`);
            await deps.remember(chatId, sessionId, text, who.author).catch(e => console.error(`[voice] saving the call failed: ${e?.message || e}`));
            resolve();
        };
        // The docs: greet once the session has started; attaching replays the
        // last 3 s, which may or may not include session.started.
        ws.on("open", () => setTimeout(greet, 1500));
        ws.on("message", async (buf: WebSocket.RawData) => {
            let ev: any;
            try { ev = JSON.parse(buf.toString()); } catch { return; }
            if (ev.event_id) {
                if (seenEvents.has(ev.event_id)) return;
                seenEvents.add(ev.event_id);
            }
            if (ev.type === "session.started") greet();
            else if (ev.type === "session.input_transcript.delta" && ev.delta) { addDelta(lines, "them", String(ev.delta)); lastIn = Date.now(); }
            else if (ev.type === "session.output_transcript.delta" && ev.delta) { addDelta(lines, "gepetel", String(ev.delta)); lastOut = Date.now(); }
            else if (ev.type === "session.delegation.created") {
                const delegationId = String(ev.delegation?.id || ev.delegation_id || ev.id || "");
                const request = delegatedRequest(lines, handedOffAt);
                handedOffAt = lines.length;
                console.log(`[voice] ${sessionId} hand-off ${delegationId}: ${request.slice(0, 200)}`);
                const narrator = new Narrator(
                    (what, fallback) => send({ type: "session.commentary.append", delegation_id: delegationId, content: progressInstructions(who.language, what, fallback) }),
                    () => Date.now() - lastOut < 800 || Date.now() - lastIn < 800,
                );
                narrator.start();
                let answer = "";
                try { answer = await deps.ask(chatId, who.author, askNote(request, lines), st => narrator.step(st)); }
                catch (e: any) { answer = "Something went wrong on my side — tell them to try again in a minute, or write in the chat."; console.error(`[voice] ask failed: ${e?.message || e}`); }
                console.log(`[voice] ${sessionId} ask took ${narrator.finish()}`);
                send({ type: "session.commentary.append", delegation_id: delegationId, content: `The answer (say it back faithfully, spoken): ${answer || "(nothing to say)"}` });
            } else if (ev.type === "session.closed") {
                console.log(`[voice] ${sessionId} closed: ${ev.reason || "?"}`);
                ws.close();
            } else if (ev.type === "error") {
                console.error(`[voice] ${sessionId} error: ${JSON.stringify(ev.error || ev).slice(0, 300)}`);
            }
        });
        ws.on("close", () => void finish());
        ws.on("error", (e: any) => { console.error(`[voice] ${sessionId} socket: ${e?.message || e}`); void finish(); });
    });
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

export type CallbackDecision = { ring: true } | { ring: false; why: string };

/** Ring them back or not — inputs looked up, so it can be tested. */
export function decideCallback(x: { configured: boolean; group: boolean; digits: string; allowed: boolean; knownUser: boolean; busy: boolean; lastAt?: number; now: number }): CallbackDecision {
    if (!x.configured) return { ring: false, why: "call-back not configured" };
    if (x.group) return { ring: false, why: "group call" };
    if (!x.digits) return { ring: false, why: "no number" };
    if (!x.allowed) return { ring: false, why: "caller not in VOICE_CALLERS" };
    if (!x.knownUser) return { ring: false, why: "no 1:1 chat with this number" };
    if (x.busy) return { ring: false, why: "already on a call" };
    if (x.lastAt && x.now - x.lastAt < CALLBACK_TTL_S * 1000) return { ring: false, why: "rang them back moments ago" };
    return { ring: true };
}

/**
 * A WhatsApp call came in (already rejected by the gateway). Returns true when
 * it is handled here — rung back, or deliberately left alone (busy, just rung)
 * — and false when the caller should get the usual "write to me" note.
 */
export async function callBack(from: string, opts: { group?: boolean; knownUser: (chatId: string) => Promise<boolean>; fetchImpl?: typeof fetch; env?: Record<string, string | undefined> }): Promise<boolean> {
    const env = opts.env || process.env;
    const digits = normalizeNumber(from.startsWith("+") ? from : `+${u.phoneDigits(from)}`);
    const chatId = digits ? `${digits}@s.whatsapp.net` : "";
    const configured = callbackConfigured(env);
    const allowed = callerAllowed(digits, env);
    const d = decideCallback({
        configured, group: !!opts.group, digits, allowed,
        knownUser: configured && allowed && !opts.group ? await opts.knownUser(chatId) : false,
        busy: live.has(chatId), lastAt: calledBack.get(digits), now: Date.now(),
    });
    const tail = digits ? `…${digits.slice(-4)}` : "(no number)";
    if (!d.ring) {
        console.log(`[voice] WhatsApp call from ${tail}: not calling back (${d.why})`);
        return configured && (d.why === "already on a call" || d.why === "rang them back moments ago");
    }
    calledBack.set(digits, Date.now());
    for (const [k, t] of calledBack) if (Date.now() - t > 3_600_000) calledBack.delete(k);
    const ts = Math.floor(Date.now() / 1000);
    const body = new URLSearchParams({
        To: `+${digits}`,
        From: env.VOICE_CALLER_ID!,
        Twiml: callbackTwiml(env.OPENAI_PROJECT_ID!, digits, ts, env.VOICE_CALLBACK_SECRET!),
        Timeout: "30",
    });
    const auth = Buffer.from(`${env.TWILIO_API_KEY_SID}:${env.TWILIO_API_KEY_SECRET}`).toString("base64");
    const res = await (opts.fetchImpl || fetch)(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID!)}/Calls.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[voice] call-back to ${tail} failed: ${res.status} ${text.slice(0, 200)}`);
        calledBack.delete(digits);
        return false;
    }
    console.log(`[voice] WhatsApp call from ${tail}: calling them back`);
    return true;
}

// ---------------------------------------------------------------------------

export type VoiceDeps = {
    client: OpenAI;
    /** Is there a 1:1 chat with them, and what to call them. */
    lookup: (chatId: string) => Promise<{ known: boolean; author: string; language: string; timezone: string; aboutThem: string }>;
    /** Count the call against their 1:1 limit. */
    claimQuota: (chatId: string) => Promise<boolean>;
    /** One ordinary 1:1 turn; the answer, not sent. */
    ask: (chatId: string, author: string, text: string, onStep?: (s: Step) => void) => Promise<string>;
    /** The finished call into their chat history. */
    remember: (chatId: string, callId: string, text: string, author: string) => Promise<void>;
};

const live = new Map<string, string>();       // chatId → callId
const closers = new Map<string, () => void>(); // chatId → how to end a Live session

/** End the call someone is on (the test page's Hang up). */
export async function hangUp(chatId: string, deps: { client: OpenAI }): Promise<void> {
    const close = closers.get(chatId);
    if (close) { close(); return; }
    const callId = live.get(chatId);
    if (callId) await deps.client.realtime.calls.hangup(callId).catch(() => {});
}
const seen = new Map<string, number>();       // webhook-id → when

/** The call someone is on now, if any. */
export function liveCall(chatId: string): string { return live.get(chatId) || ""; }

/** POST body from OpenAI (raw text) → status to answer with. */
export async function handleWebhook(raw: string, headers: Record<string, any>, deps: VoiceDeps, env: Record<string, string | undefined> = process.env): Promise<number> {
    try {
        await deps.client.webhooks.verifySignature(raw, headers, env.OPENAI_WEBHOOK_SECRET);
    } catch (e: any) {
        console.error(`[voice] webhook rejected: ${e?.message || e}`);
        return 400;
    }
    const id = String(headers["webhook-id"] || "");
    if (id) {
        if (seen.has(id)) return 200;
        seen.set(id, Date.now());
        for (const [k, t] of seen) if (Date.now() - t > 3_600_000) seen.delete(k);
    }
    const event = JSON.parse(raw);
    // The same pending call is announced as live.call.incoming too; the first
    // accept picks the API. This one speaks the Realtime API.
    if (event?.type !== "realtime.call.incoming") return 200;
    const callId = String(event.data?.call_id || "");
    if (!callId) return 200;
    void takeCall(callId, event.data?.sip_headers || [], deps, env).catch(e => console.error(`[voice] call ${callId} failed:`, e?.message || e));
    return 200;
}

async function takeCall(callId: string, headers: SipHeader[], deps: VoiceDeps, env: Record<string, string | undefined>): Promise<void> {
    // A signed call-back says who it is for; otherwise the caller ID.
    const forWhom = callbackFor(headers, env.VOICE_CALLBACK_SECRET);
    const digits = forWhom || callerDigits(headers, env.VOICE_COUNTRY_CODE || "40");
    const calledBackLeg = !!forWhom;
    const chatId = digits ? `${digits}@s.whatsapp.net` : "";
    const who = chatId ? await deps.lookup(chatId) : null;
    const allowed = callerAllowed(digits, env);
    const d = decide({
        enabled: enabled(env), digits, allowed,
        knownUser: !!who?.known, busy: live.has(chatId),
        // Counted only for a call that would otherwise be taken.
        quotaAllowed: allowed && !!who?.known && !live.has(chatId) ? await deps.claimQuota(chatId) : true,
    });
    const tail = digits ? `…${digits.slice(-4)}` : "(no number)";
    if (!d.accept) {
        console.log(`[voice] call from ${tail} rejected: ${d.why}`);
        await deps.client.realtime.calls.reject(callId, { status_code: d.status }).catch(e => console.error(`[voice] reject failed: ${e?.message || e}`));
        return;
    }
    live.set(chatId, callId);
    try {
        await deps.client.realtime.calls.accept(callId, sessionConfig(who!, env) as any);
    } catch (e: any) {
        live.delete(chatId);
        console.error(`[voice] accept failed for ${tail}: ${e?.message || e}`);
        return;
    }
    console.log(`[voice] call from ${tail} accepted (${callId})`);
    await runCall(callId, chatId, { ...who!, calledBack: calledBackLeg }, deps, env).finally(() => live.delete(chatId));
}

function runCall(callId: string, chatId: string, who: { author: string; language: string; timezone: string; calledBack?: boolean; test?: boolean }, deps: VoiceDeps, env: Record<string, string | undefined>): Promise<void> {
    return new Promise(resolve => {
        const startedAt = new Date();
        const lines: Line[] = [];
        const ws = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, {
            headers: { Authorization: `Bearer ${env.OPENAI_API_KEY || ""}` },
        });
        const send = (o: any) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
        const hangup = () => deps.client.realtime.calls.hangup(callId).catch(() => {});
        // A cap on the cost of one call.
        const cap = setTimeout(() => { console.log(`[voice] ${callId}: time limit, hanging up`); void hangup(); }, Number(env.VOICE_MAX_MINUTES || 15) * 60_000);
        let finished = false;
        const finish = async () => {
            if (finished) return;
            finished = true;
            clearTimeout(cap);
            const text = markTest(transcript(lines, startedAt, new Date(), who.timezone), !!who.test);
            console.log(`[voice] ${callId} ended after ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s, ${lines.length} lines`);
            await deps.remember(chatId, callId, text, who.author).catch(e => console.error(`[voice] saving the call failed: ${e?.message || e}`));
            resolve();
        };

        // Who is talking: a response being produced, or them. A status line
        // never cuts in on either, and a new response waits for the last one.
        let responding = false, theyTalk = false, createWhenDone = false;
        const respond = () => { if (responding) createWhenDone = true; else { responding = true; send({ type: "response.create" }); } };
        ws.on("open", () => {
            // Pick up the phone: a short greeting, in their language.
            send({ type: "response.create", response: { instructions: greeting(who.language, !!who.calledBack) } });
        });
        ws.on("message", async (buf: WebSocket.RawData) => {
            let ev: any;
            try { ev = JSON.parse(buf.toString()); } catch { return; }
            if (ev.type === "response.created") responding = true;
            else if (ev.type === "response.done") {
                responding = false;
                if (createWhenDone) { createWhenDone = false; respond(); }
            } else if (ev.type === "input_audio_buffer.speech_started") theyTalk = true;
            else if (ev.type === "input_audio_buffer.speech_stopped") theyTalk = false;
            if (ev.type === "conversation.item.input_audio_transcription.completed" && ev.transcript) {
                lines.push({ who: "them", text: String(ev.transcript) });
            } else if (ev.type === "response.output_audio_transcript.done" && ev.transcript) {
                lines.push({ who: "gepetel", text: String(ev.transcript) });
            } else if (ev.type === "response.function_call_arguments.done") {
                let args: any = {};
                try { args = JSON.parse(ev.arguments || "{}"); } catch { /* empty */ }
                if (ev.name === "end_call") {
                    // Let the goodbye play out before the line drops.
                    setTimeout(() => void hangup(), 2500);
                    return;
                }
                let output = "";
                if (ev.name === "ask_gepetel") {
                    const request = String(args.request || "").trim();
                    console.log(`[voice] ${callId} ask: ${request.slice(0, 200)}`);
                    const narrator = new Narrator((what, fallback) => {
                        responding = true;
                        send({ type: "response.create", response: { instructions: progressInstructions(who.language, what, fallback), tool_choice: "none" } });
                    }, () => responding || theyTalk);
                    narrator.start();
                    try { output = await deps.ask(chatId, who.author, askNote(request, lines), st => narrator.step(st)); }
                    catch (e: any) { output = "Something went wrong on my side — tell them to try again in a minute, or write in the chat."; console.error(`[voice] ask failed: ${e?.message || e}`); }
                    console.log(`[voice] ${callId} ask took ${narrator.finish()}`);
                } else {
                    output = `unknown tool: ${ev.name}`;
                }
                send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: ev.call_id, output: output || "(nothing to say)" } });
                respond();
            } else if (ev.type === "error") {
                console.error(`[voice] ${callId} error: ${JSON.stringify(ev.error || ev).slice(0, 300)}`);
            }
        });
        ws.on("close", () => void finish());
        ws.on("error", (e: any) => { console.error(`[voice] ${callId} socket: ${e?.message || e}`); void finish(); });
    });
}

export default { MALE_VOICES, LIVE_MODEL, isLiveModel, liveSessionBody, delegatedRequest, addDelta, hangUp, progressInstructions, Narrator, transcriptionHint, liveCall, sessionConfig, callIdFromLocation, markTest, startBrowserCall, enabled, normalizeNumber, callerDigits, callerAllowed, decide, instructions, greeting, transcript, askNote, handleWebhook, callbackSig, callbackFor, callbackTwiml, callbackConfigured, decideCallback, callBack, ASK_TOOL, END_TOOL };
