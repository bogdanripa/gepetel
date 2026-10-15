// The MCP server OpenAI's hosted tool talks to, one URL per paired computer.
//
// It is Gepetel that answers `initialize` and `tools/list`, never the Mac. That
// matters more than it looks: the hosted tool re-lists on every single reply in
// a chat with a connector, so if listing needed the laptop to be awake, every
// message to a closed laptop would stall and then fail. Listing is a static
// answer here, filtered by what the device said it could do the last time it
// connected, and it costs nothing.
//
// Only `tools/call` goes down the wire, and only when the device is actually
// online.
import type { Request, Response } from "express";
import store from "./store.js";
import hub from "./hub.js";
import jobs, { type JobRow } from "./jobs.js";
import m from "../mongo.js";
import u from "../util.js";
import wa from "../wa.js";

/** What luna sees. Every word here is re-billed on every 1:1 reply. */
type ToolDef = { name: string; description: string; capability?: string; inputSchema: any };

const TOOLS: ToolDef[] = [
    {
        name: "computer_status",
        description: "Whether their computer is reachable now, and what it can do.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "fetch_url",
        // Both halves earn their tokens: what it is, and the one thing that
        // makes it cheaper than read_url. A model that omits `query` gets the
        // opening of a page instead of the answer — and pays for it again on
        // every reply for as long as it stays in the window.
        description: "Read a web page on their computer. With `query`, only the matching passages.",
        capability: "fetch",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string", description: "Full http(s) URL." },
                query: { type: "string", description: "What to look for." },
                max_chars: { type: "integer", description: "Default 3000, max 12000." },
            },
            required: ["url"],
            additionalProperties: false,
        },
    },
    {
        name: "shell",
        description: "Run a command in a sandbox on their computer; it cannot read their files, keys or browser.",
        capability: "shell",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string", description: "A bash command." },
                timeout_s: { type: "integer", description: "Default 60, max 14400." },
            },
            required: ["command"],
            additionalProperties: false,
        },
    },
    {
        name: "send_file",
        description: "Send a picture from the working folder into this chat.",
        capability: "send",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "In the working folder." },
                caption: { type: "string" },
            },
            required: ["path"],
            additionalProperties: false,
        },
    },
    {
        name: "browse",
        description: "Do something in their logged-in Chrome; the answer comes later.",
        capability: "browse",
        inputSchema: {
            type: "object",
            properties: {
                goal: { type: "string", description: "Their whole request as one job, sign-in included." },
                start_url: { type: "string", description: "The site's front page, never a guessed deep link." },
                may_submit: { type: "boolean", description: "They asked for it done, not just looked at." },
                then: { type: "string", description: "Your own step after it (e.g. calendar)." },
                language: { type: "string", description: "The language they write in now." },
            },
            required: ["goal"],
            additionalProperties: false,
        },
    },
    {
        name: "job",
        description: "Check on, answer, add to or cancel work on their computer; no job_id means the latest.",
        capability: "jobs",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["status", "reply", "cancel"] },
                job_id: { type: "string" },
                text: { type: "string", description: "For reply: their words." },
            },
            required: ["action"],
            additionalProperties: false,
        },
    },
    {
        // Phase 9: what the Mac remembers — notes about sites, and people's
        // details, whose values stay there (the reply lists which, never what).
        name: "memory",
        description: "What their computer keeps: notes on sites (how they sign in, where things are), people's details (values stay there).",
        capability: "memory",
        inputSchema: {
            type: "object",
            properties: {
                about: { type: "string", enum: ["site", "person"] },
                action: { type: "string", enum: ["list", "add", "forget"] },
                site: { type: "string" },
                person: { type: "string", description: "Name, or me." },
                label: { type: "string", description: "phone, passport…" },
                text: { type: "string", description: "Note or value." },
            },
            required: ["about", "action"],
            additionalProperties: false,
        },
    },
    {
        // Test-only: exists to exercise ask → reply → done end to end. Only
        // offered to an agent started with GEPETEL_TEST_TOOLS=1, which reports
        // "demo"; no real install does, so it costs no one a token.
        name: "ask_demo",
        description: "Test tool: asks them a question on the computer, then says hello with the answer.",
        capability: "demo",
        inputSchema: { type: "object", properties: { question: { type: "string" }, picture: { type: "boolean" } }, additionalProperties: false },
    },
];

/** A picture from the computer, checked again before it reaches WhatsApp.
 *
 *  The agent already refuses anything that is not an image; this is the same
 *  rule on our side of the wire, because the agent runs on someone else's Mac
 *  and updates on its own schedule. The bytes must BE the type they claim, and
 *  no bigger than WhatsApp takes. Returns a data URL, or why not. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_MAGIC: Record<string, (b: Buffer) => boolean> = {
    "image/png": b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "image/jpeg": b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    "image/gif": b => /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1")),
    "image/webp": b => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};
export function checkedImage(image: unknown): { dataUrl: string; bytes: number } | { why: string } {
    const img = image as any;
    const mime = String(img?.mime || "");
    const b64 = String(img?.b64 || "");
    const looks = IMAGE_MAGIC[mime];
    if (!looks) return { why: "not an image type that can be sent" };
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { why: "not valid image data" };
    const bytes = Buffer.from(b64, "base64");
    if (!bytes.length || bytes.length > IMAGE_MAX_BYTES) return { why: "larger than 5 MB" };
    if (!looks(bytes)) return { why: `not actually ${mime}` };
    return { dataUrl: `data:${mime};base64,${b64}`, bytes: bytes.length };
}

/** The budget the agent already applied, applied again here.
 *
 *  Not belt-and-braces for its own sake: the agent is software on someone
 *  else's machine, it updates on its own schedule, and what it returns is
 *  billed to this chat on every reply for as long as it stays in the window. An
 *  agent with a bug — or an old one that never had the cap — must not be able to
 *  put 200 KB into a prompt. */
const HARD_MAX_CHARS = 12_000;
// shell clips its own output to a head and a tail (1,500 characters each) and
// adds a verdict line and a file list, so anything much past 4,000 means the
// agent is not doing that — an old one, or a broken one.
const SHELL_MAX_CHARS = 4_000;

function capped(name: string, args: Record<string, unknown>, text: string): string {
    let limit: number;
    if (name === "fetch_url") {
        const wanted = Number(args.max_chars);
        limit = Math.min(HARD_MAX_CHARS,
            Number.isFinite(wanted) && wanted > 0 ? Math.max(500, wanted) : 3000);
    } else if (name === "shell") {
        limit = SHELL_MAX_CHARS;
    } else {
        return text;
    }
    if (text.length <= limit) return text;
    console.warn(`device ${name} returned ${text.length} chars over a ${limit} budget — truncating`);
    return text.slice(0, limit - 14).trimEnd() + " …[truncated]";
}

/** The person's own words for a browse job: their last few lines in this
 *  chat, newest last, from the last two hours. Added here, never by the model
 *  — on 2026-10-14 "find accommodations in Madonna for my ski trip, 2 hotel
 *  rooms, use my booking account" reached the job as "sign in to Booking.com;
 *  do not search yet", and the job stopped there. */
export const ASKED_MAX_CHARS = 1000;
export function theirWords(history: { from: string; text: string; at?: Date }[], now = Date.now(), lines = 3): string {
    // This exchange only: back from the newest message to the first gap of
    // over 10 minutes. A question and its answers ("Which dates?" — "13–20
    // Dec") stay together; an unrelated message from before doesn't ride
    // along ("GCP billing" became part of a booking job's goal, 2026-10-14).
    let from = history.length;
    for (let i = history.length - 1; i >= 0; i--) {
        const t = history[i].at?.getTime(), next = i + 1 < history.length ? history[i + 1].at?.getTime() : now;
        if (t !== undefined && next !== undefined && next - t > 10 * 60_000) break;
        from = i;
    }
    const recent = history.slice(from).filter(h => h.from !== "Gepetel" && h.text.trim()
        && (!h.at || now - h.at.getTime() <= 2 * 60 * 60_000));
    const text = recent.slice(-lines).map(h => h.text.trim()).join("\n");
    // The newest words matter most: cut from the front.
    return text.length > ASKED_MAX_CHARS ? "…" + text.slice(-(ASKED_MAX_CHARS - 1)) : text;
}

function toolsFor(capabilities: string[]): ToolDef[] {
    return TOOLS.filter(t => !t.capability || capabilities.includes(t.capability));
}

const PROTOCOL_VERSION = "2025-06-18";

function rpcResult(id: any, result: any) {
    return { jsonrpc: "2.0", id, result };
}

/** A tool that failed is a RESULT with isError, not a JSON-RPC error: the model
 *  is meant to read it and say something sensible, not see the call break. */
function toolText(id: any, text: string, isError = false) {
    return rpcResult(id, { content: [{ type: "text", text }], isError });
}

function bearerOf(req: Request): string {
    const hdr = String(req.get("authorization") || "");
    return hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
}

function describeStatus(device: { name: string; os: string; arch: string; agent_version: string; capabilities: string[]; last_seen_at: Date | null }, online: boolean): string {
    if (!online) {
        const seen = device.last_seen_at ? u.timeAgo(device.last_seen_at) : "never";
        return `Offline. Last seen ${seen}.`;
    }
    const bits = [device.name || "the computer", device.os, device.arch].filter(Boolean).join(", ");
    const can = device.capabilities.length ? ` Can: ${device.capabilities.join(", ")}.` : "";
    return `Online — ${bits}. Agent ${device.agent_version || "?"}.${can}`;
}

/**
 * POST /device/:connectorId/mcp
 *
 * The connector's bearer secret authorises it, and the connector's chat must be
 * the device's chat: the same check as everywhere else, re-done here because
 * this entry point is reachable from the public internet by anything holding
 * the secret.
 */
export async function handleDeviceMcp(req: Request, res: Response): Promise<void> {
    const connectorId = String(req.params.connectorId || "");
    const body: any = req.body || {};
    const id = body?.id ?? null;

    const connector = await m.getMcpConnectorById(connectorId).catch(() => null);
    const device = await store.deviceForConnector(connectorId).catch(() => null);
    const secret = connector?.headers?.["Authorization"]?.replace(/^Bearer\s+/i, "") || "";
    const presented = bearerOf(req);

    if (!connector || !device || !secret || !store.sameSecret(store.hashSecret(presented), store.hashSecret(secret))) {
        res.status(401).json({ jsonrpc: "2.0", id, error: { code: -32001, message: "unauthorized" } });
        return;
    }
    // A device belongs to exactly one chat, and its connector to that same chat.
    // If those ever disagree, something is wrong — refuse rather than guess.
    if (connector.chat_id !== device.chat_id) {
        console.error(`device ${device.device_id}: connector chat ${connector.chat_id} != device chat ${device.chat_id}`);
        res.status(403).json({ jsonrpc: "2.0", id, error: { code: -32002, message: "forbidden" } });
        return;
    }

    const method = String(body?.method || "");

    if (method === "initialize") {
        res.json(rpcResult(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "gepetel-computer", version: "0.1.0" },
        }));
        return;
    }

    // Notifications carry no id and expect no body.
    if (method.startsWith("notifications/")) { res.status(202).end(); return; }

    if (method === "tools/list") {
        res.json(rpcResult(id, {
            tools: toolsFor(device.capabilities).map(t => ({
                name: t.name, description: t.description, inputSchema: t.inputSchema,
            })),
        }));
        return;
    }

    if (method === "tools/call") {
        const name = String(body?.params?.name || "");
        const args = (body?.params?.arguments || {}) as Record<string, unknown>;
        const known = toolsFor(device.capabilities).find(t => t.name === name);
        if (!known) { res.json(toolText(id, `This computer has no "${name}".`, true)); return; }

        const online = hub.isOnline(device.device_id);

        // computer_status is the one tool that must answer while the Mac sleeps —
        // "is my computer on?" is exactly the question asked when it is not.
        if (name === "computer_status") {
            res.json(toolText(id, describeStatus(device, online)));
            return;
        }

        if (name === "job") {
            res.json(await handleJob(id, device, online, args));
            return;
        }

        if (!online) {
            const seen = device.last_seen_at ? u.timeAgo(device.last_seen_at) : "never";
            res.json(toolText(id, `The computer is offline (last seen ${seen}), so this can't run now.`, true));
            return;
        }

        try {
            // The person's words go with a browse job, so it can tell the goal
            // it was given from what they asked. Whatever the model put there
            // is replaced: these come from the chat, not from it.
            // Never worth holding the job for: a second at most, else none.
            const callArgs = name === "browse"
                ? { ...args, asked: theirWords(await Promise.race([
                    m.getRecentMessages(device.chat_id, 10).catch(() => []),
                    new Promise<[]>(r => setTimeout(() => r([]), 1000).unref()),
                ])),
                    // The last digits of their number: a code texted to "•••• 34"
                    // is sent and asked for only when it's theirs (Phase 10).
                    their_phone_end: device.chat_id.split("@")[0].replace(/\D/g, "").slice(-4) }
                : args;
            // More of the same request while its job runs ("…and confirm it"):
            // added to that job, not a new one that stops it (the owner,
            // 2026-10-15). Not when it waits on a question: that's an answer.
            if (name === "browse") {
                const open = (await jobs.openJobs(device.chat_id).catch(() => [] as JobRow[]))
                    .find(j => j.tool === "browse" && j.status === "running" && Date.now() - new Date(j.created_at).getTime() < 3 * 60_000);
                if (open && hub.sendToJob(device.device_id, { t: "reply", job: open.job_id, text: `The request now: ${String(args.goal ?? "").slice(0, 1500)}`, ...(args.may_submit === true ? { may_submit: true } : {}) })) {
                    if (typeof args.then === "string" && args.then.trim()) await jobs.setThen(open.job_id, args.then.trim());
                    console.log(`device ${device.device_id}: a browse added to the running ${open.job_id}, not a new job`);
                    res.json(toolText(id, JSON.stringify({ job: open.job_id, status: "running", note: "Added to the job already running for this request — it carries on with all of it. Don't start another." })));
                    return;
                }
            }
            // browse always takes longer than a reply should wait: hand back
            // the job almost at once rather than holding the reply for 20s.
            const out = await hub.callTool(device.device_id, name, callArgs, {
                // The language they're writing in now, as the model sees the
                // conversation; the phone number's country only as a fallback
                // (it made a +40 number's jobs answer in Romanian while the
                // person wrote, and asked for, English).
                chatLang: String(args.language || "").trim().slice(0, 40) || u.inferLanguage([device.chat_id]),
                ...(name === "browse" ? { timeoutMs: 1500 } : {}),
            });
            if ("job" in out) {
                if (name === "browse" && typeof args.then === "string" && args.then.trim()) await jobs.setThen(out.job, args.then.trim());
                res.json(toolText(id, JSON.stringify(out.question
                    ? {
                        job: out.job, status: "waiting",
                        note: "The computer asked them a question, and it has been sent to them already — don't repeat it. Their next message is almost certainly the answer: pass it on with job reply.",
                    }
                    : {
                        job: out.job, status: "running",
                        note: "Still going. The result will arrive as a separate message when it is done.",
                    })));
                return;
            }
            // A picture goes to the chat, not to the model: the model is told
            // it was sent and nothing else, so no image is ever billed as
            // tokens. It goes to this device's own chat — the only one it has.
            if (name === "send_file") {
                if (!out.ok) { res.json(toolText(id, capped("shell", args, out.content || "Not sent."), true)); return; }
                const img = checkedImage((out as any).image);
                if ("why" in img) {
                    console.warn(`device ${device.device_id} send_file refused on the relay: ${img.why}`);
                    res.json(toolText(id, `Not sent: ${img.why}.`, true));
                    return;
                }
                const caption = String(args.caption ?? "").slice(0, 1000);
                const sent = await wa.sendWhatsAppImage(device.chat_id, img.dataUrl, caption);
                console.log(`device ${device.device_id} send_file -> ${img.bytes} bytes ${sent ? "sent" : "FAILED"}`);
                res.json(sent
                    ? toolText(id, "Sent to the chat. They can see it now; don't describe the file.")
                    : toolText(id, "WhatsApp did not accept the picture.", true));
                return;
            }
            const content = capped(name, args, out.content || "(no output)");
            // The cost line the spec asks for, and the comparison that decides
            // whether this phase was worth building: what the model is about to
            // be billed, against what the whole page would have cost it through
            // read_url. The page's own size is only knowable on the Mac, so the
            // agent sends it along in `meta` — which never reaches the model.
            const raw = Number((out as any).meta?.raw_chars) || 0;
            const saving = raw > content.length ? `, ${(raw / content.length).toFixed(1)}x smaller than the page (${raw})` : "";
            console.log(`device ${device.device_id} ${name} -> ${content.length} chars${saving}${out.ok ? "" : " (failed)"}`);
            res.json(toolText(id, content, !out.ok));
        } catch (e: any) {
            if (String(e?.message) === "offline") {
                res.json(toolText(id, "The computer went offline just now.", true));
                return;
            }
            console.error(`device ${device.device_id} tool ${name} failed:`, e?.message || e);
            res.json(toolText(id, "The computer could not run that.", true));
        }
        return;
    }

    res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
}

/**
 * `job`: status, reply, cancel — against the job rows, which outlive the call.
 *
 * Status answers from the row, so "is it still going?" works while the Mac
 * sleeps. Every action is confined to this device and this chat: a job id from
 * anywhere else is "no such job", whatever it is.
 */
async function handleJob(id: any, device: { device_id: string; chat_id: string }, online: boolean, args: Record<string, unknown>) {
    const action = String(args.action || "status");
    const asked = String(args.job_id || "").trim();
    const mine = (j: JobRow | null) => j && j.device_id === device.device_id && j.chat_id === device.chat_id ? j : null;

    let job: JobRow | null = null;
    if (asked) {
        job = mine(await jobs.getJob(asked));
        if (!job) return toolText(id, "There is no such job on this computer.", true);
    } else if (action === "reply") {
        // A question waiting first; otherwise the work still going (the person
        // adds to it: "for 4 guests", "two rooms").
        const open = await jobs.openJobs(device.chat_id);
        job = open.find(j => j.status === "waiting") || open.find(j => j.status === "running") || null;
        if (!job) return toolText(id, "Nothing is running on the computer.", true);
    } else if (action === "cancel") {
        job = (await jobs.openJobs(device.chat_id))[0] || null;
        if (!job) return toolText(id, "Nothing is running on the computer.", true);
    }

    if (action === "status") {
        if (job) {
            const result = (job.status === "done" || job.status === "failed") && job.result ? `\n${job.result.slice(0, 600)}` : "";
            return toolText(id, jobs.describeJob(job) + result);
        }
        const open = await jobs.openJobs(device.chat_id);
        if (open.length) return toolText(id, open.map(j => jobs.describeJob(j)).join("\n"));
        const last = await jobs.latestJob(device.chat_id);
        return toolText(id, last ? `Nothing is running. Last: ${jobs.describeJob(last)}` : "Nothing is running on the computer.");
    }

    if (!job) return toolText(id, `Unknown action "${action}".`, true);
    if (job.status !== "running" && job.status !== "waiting") {
        return toolText(id, `That has already finished (${job.status}).`, true);
    }

    if (action === "reply") {
        const text = String(args.text ?? "").trim();
        if (!text) return toolText(id, "Say what to pass on.", true);
        if (!online || !hub.sendToJob(device.device_id, { t: "reply", job: job.job_id, text: text.slice(0, 2000) })) {
            return toolText(id, "The computer is offline, so this can't reach it now.", true);
        }
        if (job.status === "waiting") {
            await jobs.setStatus(job.job_id, "running", { question: "" });
            console.log(`device ${device.device_id} job ${job.job_id} answered (${text.length} chars)`);
            return toolText(id, "Passed on. The computer carries on, and reports back when it's done.");
        }
        console.log(`device ${device.device_id} job ${job.job_id} added to (${text.length} chars)`);
        return toolText(id, "Added to the work in progress; it takes it into account and carries on.");
    }

    if (action === "cancel") {
        const told = online && hub.sendToJob(device.device_id, { t: "cancel", job: job.job_id });
        // Marked cancelled either way: whatever the Mac reports for it later
        // is recorded and not delivered (hub.handleEvent).
        await jobs.setStatus(job.job_id, "cancelled", { question: "" });
        const { default: takeover } = await import("./takeover.js");
        await takeover.endJob(job.job_id).catch(() => {});
        console.log(`device ${device.device_id} job ${job.job_id} cancelled${told ? "" : " (offline — the Mac was not told)"}`);
        return toolText(id, told ? "Cancelled." : "Cancelled here. The computer is offline, so it will only stop when it is back — nothing more will be reported from it.");
    }
    return toolText(id, `Unknown action "${action}".`, true);
}

/** "stop", "cancel", "oprește"… — the whole message, nothing else in it. */
export const STOP_WORDS = /^\s*(stop|stop it|stop that|cancel|cancel it|cancel that|abort|halt|enough|never ?mind|forget it|opre[sș]te|opre[sș]te-te|stai|anuleaz[aă]|las[aă]|renun[tț][aă])\s*[.!]*\s*$/i;

/**
 * "Stop" in the chat while computer work is open: cancelled here, at once,
 * without a model. On 2026-10-14 the model answered "Stopped" and called
 * nothing, and the job went on. Returns the jobs cancelled (none: not ours).
 */
export async function stopOpenWork(chatId: string): Promise<string[]> {
    const device = await store.deviceForChat(chatId).catch(() => null);
    if (!device) return [];
    const open = await jobs.openJobs(chatId).catch(() => [] as JobRow[]);
    const done: string[] = [];
    for (const job of open) {
        if (job.device_id !== device.device_id) continue;
        hub.sendToJob(device.device_id, { t: "cancel", job: job.job_id });
        await jobs.setStatus(job.job_id, "cancelled", { question: "" });
        const { default: takeover } = await import("./takeover.js");
        await takeover.endJob(job.job_id).catch(() => {});
        console.log(`device ${device.device_id} job ${job.job_id} cancelled — "stop" in the chat`);
        done.push(job.job_id);
    }
    return done;
}

export default { handleDeviceMcp, TOOLS, checkedImage, stopOpenWork, STOP_WORDS, theirWords };
