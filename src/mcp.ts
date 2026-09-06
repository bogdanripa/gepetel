// The smallest possible MCP client: enough to ask a remote server what it
// offers, and nothing more.
//
// Gepetel does not run MCP tools himself — the hosted `mcp` tool on the
// Responses API does, server-side, per group (see getMcpToolsForGroup). What
// he does need is to CHECK a connector the moment someone hands him a URL and a
// key in a 1:1: a wrong key should fail there, privately, not days later in the
// group as "the Trello thing doesn't work". So this speaks just the opening of
// the Streamable HTTP transport — initialize, initialized, tools/list — and
// reports the tool names back.
import axios from "axios";
import u from "./util.js";

export type McpTool = { name: string; description: string };
export type McpProbe = { serverName: string; tools: McpTool[] };

const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = 20_000;

async function rpc(url: string, headers: Record<string, string>, body: any, sessionId?: string) {
    const res = await axios.post(url, body, {
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
            ...headers,
        },
        timeout: TIMEOUT_MS,
        responseType: "text",
        transformResponse: [(d: any) => d],
        validateStatus: () => true,
    });
    const newSession = res.headers?.["mcp-session-id"] || sessionId;
    if (res.status === 401 || res.status === 403) {
        throw new Error(`the server refused the credentials (HTTP ${res.status}) — check the key/token`);
    }
    if (res.status === 404 || res.status === 405) {
        throw new Error(`nothing answers MCP at that URL (HTTP ${res.status}) — check the address, it usually ends in /mcp`);
    }
    if (res.status >= 400) {
        throw new Error(`the server answered HTTP ${res.status}`);
    }
    const messages = u.parseJsonRpcResponse(String(res.data ?? ""), String(res.headers?.["content-type"] || ""));
    const reply = messages.find(m => m && m.id !== undefined && m.id === body.id);
    return { reply, sessionId: newSession };
}

// Ask the server who it is and what it can do. Throws with a message meant to
// be read back to the person, since it comes straight from a tool result.
export async function probeMcpServer(serverUrl: string, headers: Record<string, string> = {}): Promise<McpProbe> {
    const url = String(serverUrl || "").trim();
    if (!/^https:\/\//i.test(url)) throw new Error("the MCP server URL must start with https://");

    const init = await rpc(url, headers, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "gepetel", version: "1.0" },
        },
    });
    if (!init.reply) throw new Error("the server did not answer the MCP handshake — is this an MCP endpoint?");
    if (init.reply.error) throw new Error(`the server rejected the handshake: ${init.reply.error.message || "unknown error"}`);
    const serverName = String(init.reply.result?.serverInfo?.name || "");

    // A notification, no reply expected; a server may answer 202 or 200.
    try {
        await axios.post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, {
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                ...(init.sessionId ? { "Mcp-Session-Id": init.sessionId } : {}),
                ...headers,
            },
            timeout: TIMEOUT_MS, validateStatus: () => true,
        });
    } catch { /* not load-bearing */ }

    const list = await rpc(url, headers, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, init.sessionId);
    if (!list.reply) throw new Error("the server did not list its tools");
    if (list.reply.error) throw new Error(`tools/list failed: ${list.reply.error.message || "unknown error"}`);
    const tools: McpTool[] = (list.reply.result?.tools || []).map((t: any) => ({
        name: String(t?.name || ""),
        description: String(t?.description || "").slice(0, 200),
    })).filter((t: McpTool) => t.name);
    if (!tools.length) throw new Error("the server connected but offers no tools");
    return { serverName, tools };
}

export default { probeMcpServer };
