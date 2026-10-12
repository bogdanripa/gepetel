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
];

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
            const out = await hub.callTool(device.device_id, name, args);
            if ("job" in out) {
                res.json(toolText(id, JSON.stringify({
                    job: out.job, status: "running",
                    note: "Still going. The result will arrive as a separate message when it is done.",
                })));
                return;
            }
            res.json(toolText(id, out.content || "(no output)", !out.ok));
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
