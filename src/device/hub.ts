// The socket a paired Mac holds open.
//
// The agent dials out — no tunnel, no port forwarding, nothing listening on the
// person's machine — and that connection is how every tool call reaches it. One
// instance runs on the Pi, so the registry is a plain in-memory Map; if the
// process restarts, agents reconnect on their own backoff.
//
// Two rules shape everything here:
//
//  - **Offline is an answer, not a wait.** A call to a sleeping Mac fails at once
//    with when it was last seen, rather than holding a WhatsApp reply open.
//  - **Slow is a job, not a timeout.** Past CALL_TIMEOUT_MS the caller is handed
//    a job id and the reply goes out; the agent keeps working and its result
//    arrives later as an event. One rule for every tool, so nothing has to guess
//    how long a thing should take.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import store from "./store.js";

export const WS_PATH = "/device/ws";
/** Past this, a call becomes a job and the reply stops waiting. */
export const CALL_TIMEOUT_MS = 20_000;
const PING_MS = 20_000;
/** Two missed pings and the socket is considered dead. */
const MISSED_PINGS = 2;

type Pending = {
    resolve: (value: { ok: boolean; content: string; meta?: Record<string, unknown> }) => void;
    timer: NodeJS.Timeout;
};

type Live = {
    socket: WebSocket;
    deviceId: string;
    chatId: string;
    missedPings: number;
    pending: Map<string, Pending>;
};

const live = new Map<string, Live>();   // device_id -> connection
let seq = 0;

/** Close whatever socket a chat's computer holds — used when it is unpaired. */
export function dropDevice(chatId: string): void {
    for (const [deviceId, conn] of live) {
        if (conn.chatId === chatId) drop(deviceId, "unpaired");
    }
}

export function isOnline(deviceId: string): boolean {
    const conn = live.get(deviceId);
    return !!conn && conn.socket.readyState === WebSocket.OPEN;
}

export function onlineCount(): number {
    return [...live.values()].filter(c => c.socket.readyState === WebSocket.OPEN).length;
}

function drop(deviceId: string, why: string) {
    const conn = live.get(deviceId);
    if (!conn) return;
    live.delete(deviceId);
    // Anything still waiting gets a straight answer rather than hanging until
    // its own timeout: the computer went away, and that is knowable now.
    for (const [, p] of conn.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, content: "The computer disconnected before it finished." });
    }
    conn.pending.clear();
    try { conn.socket.terminate(); } catch { /* already gone */ }
    console.log(`device ${deviceId} disconnected (${why})`);
}

/**
 * Ask the Mac to run a tool.
 *
 * Resolves with the agent's result, or with `{ job }` once CALL_TIMEOUT_MS has
 * passed — in which case the agent is still working and will report back through
 * an event. Never rejects for slowness; only for a device that is not there.
 */
export async function callTool(
    deviceId: string,
    tool: string,
    args: Record<string, unknown>,
    opts: { chatLang?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; content: string; meta?: Record<string, unknown> } | { job: string }> {
    const conn = live.get(deviceId);
    if (!conn || conn.socket.readyState !== WebSocket.OPEN) {
        throw new Error("offline");
    }
    const id = `c_${++seq}`;
    const jobId = `j_${id.slice(2)}`;
    return await new Promise(resolve => {
        const timer = setTimeout(() => {
            // Not an error: the work goes on, the caller just stops waiting for it.
            conn.pending.delete(id);
            console.log(`device ${deviceId} call ${id} (${tool}) exceeded ${CALL_TIMEOUT_MS}ms — promoted to ${jobId}`);
            resolve({ job: jobId });
        }, opts.timeoutMs ?? CALL_TIMEOUT_MS);

        conn.pending.set(id, { resolve: r => resolve(r), timer });
        try {
            conn.socket.send(JSON.stringify({ t: "call", id, job: jobId, tool, args, chat_lang: opts.chatLang || "" }));
        } catch (e: any) {
            clearTimeout(timer);
            conn.pending.delete(id);
            resolve({ ok: false, content: `Could not reach the computer (${e?.message || "send failed"}).` });
        }
    });
}

export function cancelCall(deviceId: string, callId: string): void {
    const conn = live.get(deviceId);
    if (conn?.socket.readyState === WebSocket.OPEN) {
        try { conn.socket.send(JSON.stringify({ t: "cancel", id: callId })); } catch { /* best effort */ }
    }
}

/**
 * Put a finished job's result into the chat.
 *
 * This is the smallest useful slice of Phase 3, brought forward for one reason:
 * a call that outlives CALL_TIMEOUT_MS is handed back as `{job, status:
 * "running"}` and the reply goes out — so without this, the answer to anything
 * that takes more than twenty seconds exists only in the agent's log. A `shell`
 * tool that can only be used for commands under twenty seconds is not the tool
 * the spec describes.
 *
 * What Phase 3 still owes: the `device_jobs` collection, the `job` tool
 * (status/reply/cancel), questions from the agent, and the agent-side outbox
 * that survives a reconnect. Here, an event that arrives while the socket is
 * down is simply lost, and `progress` and `question` are still only logged.
 *
 * The text is the AGENT's, sent verbatim with a 🖥️ in front so the window shows
 * where it came from. No model call happens on delivery, so it costs nothing —
 * and `sayAndRemember` archives it, so the model sees it as its own earlier
 * message on the next turn rather than being surprised by it.
 */
async function deliverEvent(device: { device_id: string; chat_id: string }, msg: any): Promise<void> {
    const kind = String(msg?.kind || "");
    const text = String(msg?.text ?? "").trim();
    console.log(`device ${device.device_id} event (${kind || "?"}) for job ${msg?.job || "-"}` +
        `${text ? ` — ${text.length} chars` : ""}`);
    if (kind !== "done" && kind !== "failed") return;   // progress/question: Phase 3
    if (!text) return;
    try {
        // Unpaired between starting the work and finishing it: the chat no
        // longer has a computer, so nothing from one belongs in it.
        const still = await store.deviceForChat(device.chat_id);
        if (!still || still.device_id !== device.device_id) {
            console.log(`device ${device.device_id} event dropped — ${device.chat_id} has no such computer now`);
            return;
        }
        const { sayAndRemember } = await import("../say.js");
        await sayAndRemember(device.chat_id, `🖥️ ${text.slice(0, 3000)}`);
    } catch (e: any) {
        console.error(`device ${device.device_id} event delivery failed:`, e?.message || e);
    }
}

function bearerOf(req: IncomingMessage): string {
    const hdr = String(req.headers["authorization"] || "");
    return hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
}

/**
 * Attach the hub to the HTTP server. Authentication happens during the upgrade,
 * so an unauthenticated socket is never established in the first place.
 */
export function attachDeviceHub(server: Server): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        let path = "";
        try { path = new URL(req.url || "", "http://localhost").pathname; } catch { path = ""; }
        if (path !== WS_PATH) return;   // not ours: leave it for anything else listening

        const device = await store.deviceForToken(bearerOf(req)).catch(() => null);
        if (!device) {
            // No detail: a bad token and an unknown device look identical.
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, ws => {
            // One socket per device. A reconnect supersedes whatever was there,
            // which is also how a half-dead connection gets cleaned up.
            drop(device.device_id, "replaced by a new connection");
            const conn: Live = { socket: ws, deviceId: device.device_id, chatId: device.chat_id, missedPings: 0, pending: new Map() };
            live.set(device.device_id, conn);
            void store.noteSeen(device.device_id).catch(() => {});
            console.log(`device ${device.device_id} connected (${device.name || "unnamed"})`);

            ws.on("message", raw => {
                let msg: any;
                try { msg = JSON.parse(String(raw)); } catch { return; }
                conn.missedPings = 0;
                void store.noteSeen(device.device_id, msg?.t === "hello" ? msg : undefined).catch(() => {});

                if (msg?.t === "result" && msg.id) {
                    const p = conn.pending.get(String(msg.id));
                    if (!p) return;   // already promoted to a job; the event carries it instead
                    clearTimeout(p.timer);
                    conn.pending.delete(String(msg.id));
                    p.resolve({ ok: msg.ok !== false, content: String(msg.content ?? ""),
                                meta: msg.meta && typeof msg.meta === "object" ? msg.meta : undefined });
                    return;
                }
                if (msg?.t === "event") {
                    void deliverEvent(device, msg);
                    return;
                }
            });

            ws.on("pong", () => { conn.missedPings = 0; });
            ws.on("close", () => { if (live.get(device.device_id) === conn) drop(device.device_id, "closed"); });
            ws.on("error", () => { if (live.get(device.device_id) === conn) drop(device.device_id, "socket error"); });
        });
    });

    const heartbeat = setInterval(() => {
        for (const [deviceId, conn] of live) {
            if (conn.socket.readyState !== WebSocket.OPEN) { drop(deviceId, "not open"); continue; }
            if (conn.missedPings >= MISSED_PINGS) { drop(deviceId, "no pong"); continue; }
            conn.missedPings++;
            try { conn.socket.ping(); } catch { drop(deviceId, "ping failed"); }
        }
    }, PING_MS);
    heartbeat.unref?.();

    return wss;
}

export default { attachDeviceHub, callTool, cancelCall, dropDevice, isOnline, onlineCount, WS_PATH, CALL_TIMEOUT_MS };
