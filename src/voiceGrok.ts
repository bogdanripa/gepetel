// xAI Grok Voice on the admin test page, next to gpt-realtime-2.1 and
// gpt-live-1. Grok has no browser WebRTC and no server sideband: it is one
// WebSocket carrying both the audio and the events. So the relay sits in the
// middle — the browser streams its microphone here as 24 kHz PCM, the relay
// forwards it to xAI and plays xAI's audio back down the same browser socket —
// and runs the call with the shared runCall (voice.ts): same instructions,
// greeting, ask_gepetel/end_call, spoken step status, transcript into history.
//
// Test page only, creator only. Docs (2026-11-17): wss://api.x.ai/v1/realtime,
// session.update {instructions, voice, turn_detection server_vad, tools with
// type "function", audio.input/output.format, audio.output.speed 0.7–1.5,
// reasoning.effort}, response.output_audio.delta, response.function_call_
// arguments.done, conversation.item.input_audio_transcription.updated
// (cumulative, with transcription model "grok-transcribe"). Priced per minute.

import type { Server, IncomingMessage } from "http";
import type { Duplex } from "stream";
import crypto from "crypto";
import WebSocket, { WebSocketServer } from "ws";
import voice, { type VoiceDeps, type Line } from "./voice.js";

// Male voices from GET /v1/tts/voices (2026-11-17), Rex first: the casual one.
export const GROK_VOICES = ["rex", "leo", "sal", "cosmo", "lux", "helix", "orion", "castor", "atlas", "kepler"];
export const GROK_MODEL_NAME = "grok-voice";
export const WS_PATH = "/voice/test/grok/ws";

const GROK_NOTE = "\n\nYou may be a bit cheekier and more irreverent than usual — banter, irony — but the same rules on privacy and confirmations apply.";

/** The session.update that sets a Grok call up like a phone call. */
export function grokSession(who: { author: string; language: string; timezone: string; aboutThem: string }, opts: { voice?: string; speed?: number; reasoning?: string } = {}) {
    const speed = Math.min(1.5, Math.max(0.7, Number(opts.speed) || 1.2));
    return {
        type: "session.update",
        session: {
            instructions: voice.instructions({ author: who.author, language: who.language, timezone: who.timezone, aboutThem: who.aboutThem }) + GROK_NOTE,
            voice: GROK_VOICES.includes(String(opts.voice)) ? opts.voice : GROK_VOICES[0],
            // Thinking before every sentence is a pause on the line; the real
            // thinking happens in ask_gepetel.
            reasoning: { effort: opts.reasoning === "high" ? "high" : "none" },
            turn_detection: { type: "server_vad" },
            audio: {
                input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "grok-transcribe" } },
                output: { format: { type: "audio/pcm", rate: 24000 }, speed },
            },
            tools: [voice.ASK_TOOL, voice.END_TOOL],
        },
    };
}

/**
 * Captions from Grok's events, into the call's lines. What they say comes as
 * a cumulative transcript per item (replace, not append); what Grok says comes
 * as transcript deltas per response, kept until the response is done. Returns
 * a caption for the browser when a line changed.
 */
export class GrokCaptions {
    private theirs = new Map<string, number>();  // item_id → index in lines
    private ours = new Map<string, string>();    // response_id → text so far
    private oursDone = new Set<string>();
    constructor(private lines: Line[]) {}
    take(ev: any): { who: Line["who"]; text: string; key: string } | null {
        const t = ev?.type || "";
        if (t === "conversation.item.input_audio_transcription.completed") {
            // The shared handler pushes the final line itself: drop the draft.
            const id = String(ev.item_id || "");
            const at = this.theirs.get(id);
            if (at !== undefined) {
                this.lines.splice(at, 1);
                this.theirs.delete(id);
                for (const [k, i] of this.theirs) if (i > at) this.theirs.set(k, i - 1);
            }
            return ev.transcript ? { who: "them", text: String(ev.transcript), key: id || `them_${this.lines.length}` } : null;
        }
        if (t === "conversation.item.input_audio_transcription.updated") {
            const id = String(ev.item_id || ev.item?.id || `them_${this.lines.length}`);
            const text = String(ev.transcript ?? ev.text ?? "").trim();
            if (!text) return null;
            const at = this.theirs.get(id);
            if (at === undefined) { this.theirs.set(id, this.lines.length); this.lines.push({ who: "them", text }); }
            else this.lines[at] = { who: "them", text };
            return { who: "them", text, key: id };
        }
        if (/^response\.(output_)?audio_transcript\.delta$/.test(t) || t === "response.output_text.delta") {
            const id = String(ev.response_id || "r");
            this.ours.set(id, (this.ours.get(id) || "") + String(ev.delta || ""));
            return { who: "gepetel", text: this.ours.get(id)!, key: id };
        }
        if (/^response\.(output_)?audio_transcript\.done$/.test(t)) {
            // The shared handler already takes response.output_audio_transcript.done.
            const id = String(ev.response_id || "r");
            this.oursDone.add(id);
            if (t !== "response.output_audio_transcript.done" && ev.transcript) this.lines.push({ who: "gepetel", text: String(ev.transcript) });
            return ev.transcript ? { who: "gepetel", text: String(ev.transcript), key: id } : null;
        }
        if (t === "response.done") {
            const id = String(ev.response?.id || ev.response_id || "r");
            const text = (this.ours.get(id) || "").trim();
            if (text && !this.oursDone.has(id)) this.lines.push({ who: "gepetel", text });
            this.ours.delete(id);
            this.oursDone.delete(id);
        }
        return null;
    }
}

// One-use tickets: the page's authenticated POST mints one, its socket spends
// it. A browser socket carries no basic-auth header we can rely on.
type Ticket = { exp: number; voice: string; speed: number };
const tickets = new Map<string, Ticket>();

export function mintTicket(opts: { voice?: string; speed?: number }, now = Date.now()): string {
    for (const [k, t] of tickets) if (t.exp < now) tickets.delete(k);
    const id = crypto.randomBytes(24).toString("base64url");
    tickets.set(id, { exp: now + 60_000, voice: GROK_VOICES.includes(String(opts.voice)) ? String(opts.voice) : GROK_VOICES[0], speed: Number(opts.speed) || 1.2 });
    return id;
}

export function spendTicket(id: string, now = Date.now()): Ticket | null {
    const t = tickets.get(id);
    tickets.delete(id);
    return t && t.exp >= now ? t : null;
}

export function configured(env: Record<string, string | undefined> = process.env): boolean {
    return !!(env.GROK_API_KEY || env.XAI_API_KEY);
}

/** The browser's socket: microphone up, Grok's voice and captions down. */
export function attachGrokTest(server: Server, deps: VoiceDeps, creatorChat: () => string, env: Record<string, string | undefined> = process.env): void {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        let url: URL;
        try { url = new URL(req.url || "", "http://localhost"); } catch { return; }
        if (url.pathname !== WS_PATH) return;
        const ticket = spendTicket(url.searchParams.get("t") || "");
        const chatId = creatorChat();
        if (!ticket || !chatId || !configured(env)) {
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, browser => void runGrok(browser, chatId, ticket, deps, env));
    });
}

async function runGrok(browser: WebSocket, chatId: string, ticket: Ticket, deps: VoiceDeps, env: Record<string, string | undefined>): Promise<void> {
    const toBrowser = (o: any) => { if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(o)); };
    const who = await deps.lookup(chatId);
    if (!who.known) { toBrowser({ type: "error", error: "no 1:1 chat with Gepetel on this number" }); browser.close(); return; }
    const callId = `grok_${crypto.randomBytes(6).toString("hex")}`;
    let xai: WebSocket | null = null;
    const close = () => { try { xai?.close(); } catch { /* gone */ } try { browser.close(); } catch { /* gone */ } };
    if (!voice.holdLine(chatId, callId, close)) { toBrowser({ type: "error", error: "already on a call" }); browser.close(); return; }
    console.log(`[voice] test call from the admin page (${callId}, Grok, ${ticket.voice})`);

    let greeted = false;
    let captions: GrokCaptions | null = null;
    const io: import("./voice.js").CallIO = {
        open: () => {
            xai = new WebSocket(`wss://api.x.ai/v1/realtime?model=${encodeURIComponent(env.GROK_VOICE_MODEL || "grok-voice-latest")}`, {
                headers: { Authorization: `Bearer ${env.GROK_API_KEY || env.XAI_API_KEY || ""}` },
            });
            // Microphone up: raw PCM16 frames from the page.
            browser.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
                if (!isBinary || xai?.readyState !== WebSocket.OPEN) return;
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
                xai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: buf.toString("base64") }));
            });
            browser.on("close", () => { try { xai?.close(); } catch { /* gone */ } });
            return xai;
        },
        hangup: close,
        onOpen: send => {
            send(grokSession(who, { voice: ticket.voice, speed: ticket.speed, reasoning: env.GROK_REASONING }));
            // Greet once the session took, or after a second either way.
            setTimeout(() => greet(send), 1200);
        },
        progressExtra: {},
        onEvent: (ev, lines) => {
            captions ||= new GrokCaptions(lines);
            const t = ev?.type || "";
            if (t === "session.updated" && sendRef) greet(sendRef);
            if (t === "response.output_audio.delta" || t === "response.audio.delta") {
                if (ev.delta && browser.readyState === WebSocket.OPEN) browser.send(Buffer.from(String(ev.delta), "base64"));
                return;
            }
            // They started talking: stop what is still queued to play.
            if (t === "input_audio_buffer.speech_started") toBrowser({ type: "clear" });
            const c = captions.take(ev);
            if (c) toBrowser({ type: "caption", ...c });
            if (t === "response.function_call_arguments.done") {
                let a: any = {};
                try { a = JSON.parse(ev.arguments || "{}"); } catch { /* empty */ }
                toBrowser({ type: "tool", text: ev.name === "ask_gepetel" ? `→ ask_gepetel: ${a.request || ""}` : `→ ${ev.name}` });
            }
            if (t === "error") toBrowser({ type: "error", error: ev.error || ev });
        },
        onAsk: (_request, seconds) => toBrowser({ type: "tool", text: `← ask_gepetel answered in ${seconds.toFixed(1)} s` }),
    };
    let sendRef: ((o: any) => void) | null = null;
    const greet = (send: (o: any) => void) => {
        sendRef = send;
        if (greeted) return;
        greeted = true;
        send({ type: "response.create", response: { instructions: voice.greeting(who.language, false) } });
    };
    // session.updated may arrive before the timer: keep the sender for it.
    const origOnOpen = io.onOpen!;
    io.onOpen = send => { sendRef = send; origOnOpen(send); };

    try {
        await voice.runCall(callId, chatId, { ...who, test: true }, deps, env, io);
    } catch (e: any) {
        console.error(`[voice] Grok test call ${callId}: ${e?.message || e}`);
    } finally {
        voice.releaseLine(chatId);
        try { browser.close(); } catch { /* gone */ }
    }
}

export default { GROK_VOICES, GROK_MODEL_NAME, WS_PATH, grokSession, GrokCaptions, mintTicket, spendTicket, configured, attachGrokTest };
