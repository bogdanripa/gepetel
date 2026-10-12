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
import m from "../mongo.js";
import u from "../util.js";

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
];

/** The budget the agent already applied, applied again here.
 *
 *  Not belt-and-braces for its own sake: the agent is software on someone
 *  else's machine, it updates on its own schedule, and what it returns is
 *  billed to this chat on every reply for as long as it stays in the window. An
 *  agent with a bug — or an old one that never had the cap — must not be able to
 *  put 200 KB into a prompt. */
const HARD_MAX_CHARS = 12_000;

function capped(name: string, args: Record<string, unknown>, text: string): string {
    if (name !== "fetch_url") return text;
    const wanted = Number(args.max_chars);
    const limit = Math.min(HARD_MAX_CHARS,
        Number.isFinite(wanted) && wanted > 0 ? Math.max(500, wanted) : 3000);
    if (text.length <= limit) return text;
    console.warn(`device fetch_url returned ${text.length} chars over a ${limit} budget — truncating`);
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

        if (!online) {
            const seen = device.last_seen_at ? u.timeAgo(device.last_seen_at) : "never";
            res.json(toolText(id, `The computer is offline (last seen ${seen}), so this can't run now.`, true));
            return;
        }

        try {
            const out = await hub.callTool(device.device_id, name, args, { chatLang: u.inferLanguage([device.chat_id]) });
            if ("job" in out) {
                res.json(toolText(id, JSON.stringify({
                    job: out.job, status: "running",
                    note: "Still going. The result will arrive as a separate message when it is done.",
                })));
                return;
            }
            const content = capped(name, args, out.content || "(no output)");
            // The cost line the spec asks for: what the model is about to be
            // billed for, per call, next to which tool produced it.
            console.log(`device ${device.device_id} ${name} -> ${content.length} chars${out.ok ? "" : " (failed)"}`);
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

export default { handleDeviceMcp, TOOLS };
