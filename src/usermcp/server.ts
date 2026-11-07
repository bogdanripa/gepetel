// Gepetel's own MCP endpoint: POST /mcp.
//
// Same JSON-RPC shape as the per-computer server next door (device/mcp.ts), but
// a different question at the door. That one is authorised by a secret baked
// into one connector; this one is authorised by an OAuth token that stands for
// a WhatsApp account, because the person on the other end is a human adding
// Gepetel to their own client.
//
// The 401 here is load-bearing. A client that knows nothing about this server
// POSTs to it, gets 401 with a WWW-Authenticate naming the resource metadata,
// and the whole login follows from that one header. Get it wrong and the
// client simply reports that the server needs a token it cannot get.
import type { Express, Request, Response } from "express";
import store from "./store.js";
import tools from "./tools.js";
import oauth, { registerOAuthRoutes } from "./oauth.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "gepetel", version: "0.1.0" };

const rpcResult = (id: any, result: any) => ({ jsonrpc: "2.0", id, result });

function bearerOf(req: Request): string {
    const hdr = String(req.get("authorization") || "");
    return hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
}

/** The header that starts a login. Without `resource_metadata` a client has no
 *  way to find the authorization server, which is the difference between "log
 *  in" and "this server is broken". */
function unauthorized(res: Response, id: any, detail = "a Gepetel token is required"): void {
    res.set("WWW-Authenticate",
        `Bearer realm="gepetel", resource_metadata="${oauth.resourceUrl().replace(/\/mcp$/, "")}/.well-known/oauth-protected-resource/mcp"`);
    res.status(401).json({ jsonrpc: "2.0", id, error: { code: -32001, message: detail } });
}

export async function handleUserMcp(req: Request, res: Response): Promise<void> {
    const body: any = req.body || {};
    const id = body?.id ?? null;
    const method = String(body?.method || "");

    const owner = await store.tokenOwner(bearerOf(req)).catch(() => null);
    if (!owner) { unauthorized(res, id); return; }

    if (method === "initialize") {
        res.json(rpcResult(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
        }));
        return;
    }

    // Notifications carry no id and expect no body.
    if (method.startsWith("notifications/")) { res.status(202).end(); return; }

    if (method === "tools/list") {
        res.json(rpcResult(id, { tools: tools.TOOLS }));
        return;
    }

    if (method === "tools/call") {
        const name = String(body?.params?.name || "");
        const args = body?.params?.arguments || {};
        try {
            const result = await tools.callTool(name, args, { chatId: owner.chat_id });
            res.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result) }] }));
        } catch (e: any) {
            // A tool that refused is a RESULT with isError, not a JSON-RPC
            // error: the model should read "that group isn't one of yours" and
            // tell the person, not treat the connection as broken.
            const message = String(e?.message || e);
            console.error(`mcp ${name} for ${owner.chat_id}: ${message}`);
            res.json(rpcResult(id, { content: [{ type: "text", text: message }], isError: true }));
        }
        return;
    }

    res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
}

export function registerUserMcpRoutes(app: Express): void {
    registerOAuthRoutes(app);
    app.post("/mcp", handleUserMcp);
    // Some clients probe with GET before posting. Answer the same way, so the
    // login starts instead of the client deciding there is nothing here.
    app.get("/mcp", (req, res) => unauthorized(res, null, "POST JSON-RPC here with a Gepetel token"));
}

export default { registerUserMcpRoutes, handleUserMcp };
