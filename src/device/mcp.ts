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
        description: "Whether the person's computer is reachable right now, and what it can do.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "fetch_url",
        // Both halves earn their tokens: what it is, and the one thing that
        // makes it cheaper than read_url. A model that omits `query` gets the
        // opening of a page instead of the answer — and pays for it again on
        // every reply for as long as it stays in the window.
        description: "Read a web page on the person's own computer. With `query` it returns just the matching passages, not the page — best for long pages and precise questions.",
        capability: "fetch",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string", description: "The full http(s) URL." },
                query: { type: "string", description: "What to look for, in the page's own words." },
                max_chars: { type: "integer", description: "Reply cap. Default 3000, max 12000." },
            },
            required: ["url"],
            additionalProperties: false,
        },
    },
    {
        name: "shell",
        description: "Run a command in a sandbox on the person's computer. It starts in a working folder and cannot read anything else of theirs — not their files, keys or browser.",
        capability: "shell",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string", description: "The command, as you would type it in bash." },
                timeout_s: { type: "integer", description: "Kill it after this long. Default 60, max 14400." },
            },
            required: ["command"],
            additionalProperties: false,
        },
    },
    {
        name: "send_file",
        description: "Send a picture from the computer's working folder into this chat (PNG, JPEG, GIF, WebP or SVG). How to show them a chart or image you made.",
        capability: "send",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "The file, in the working folder." },
                caption: { type: "string", description: "Optional caption under the picture." },
            },
            required: ["path"],
            additionalProperties: false,
        },
    },
    {
        name: "job",
        description: "Check on, answer or cancel work still going on their computer. Leave job_id out to mean the latest one.",
        capability: "jobs",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["status", "reply", "cancel"] },
                job_id: { type: "string" },
                text: { type: "string", description: "For reply: their answer, in their words." },
            },
            required: ["action"],
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
        inputSchema: { type: "object", properties: { question: { type: "string" } }, additionalProperties: false },
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
            const out = await hub.callTool(device.device_id, name, args, { chatLang: u.inferLanguage([device.chat_id]) });
            if ("job" in out) {
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
        job = (await jobs.openJobs(device.chat_id)).find(j => j.status === "waiting") || null;
        if (!job) return toolText(id, "Nothing on the computer is waiting for an answer.", true);
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
        if (job.status !== "waiting") return toolText(id, "That job is not waiting for an answer.", true);
        if (!online || !hub.sendToJob(device.device_id, { t: "reply", job: job.job_id, text: text.slice(0, 2000) })) {
            return toolText(id, "The computer is offline, so the answer can't reach it now.", true);
        }
        await jobs.setStatus(job.job_id, "running", { question: "" });
        console.log(`device ${device.device_id} job ${job.job_id} answered (${text.length} chars)`);
        return toolText(id, "Passed on. The computer carries on, and reports back when it's done.");
    }

    if (action === "cancel") {
        const told = online && hub.sendToJob(device.device_id, { t: "cancel", job: job.job_id });
        // Marked cancelled either way: whatever the Mac reports for it later
        // is recorded and not delivered (hub.handleEvent).
        await jobs.setStatus(job.job_id, "cancelled", { question: "" });
        console.log(`device ${device.device_id} job ${job.job_id} cancelled${told ? "" : " (offline — the Mac was not told)"}`);
        return toolText(id, told ? "Cancelled." : "Cancelled here. The computer is offline, so it will only stop when it is back — nothing more will be reported from it.");
    }
    return toolText(id, `Unknown action "${action}".`, true);
}

export default { handleDeviceMcp, TOOLS, checkedImage };
