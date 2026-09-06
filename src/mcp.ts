// The smallest possible MCP client: enough to ask a remote server what it
// offers, find out how it wants to be authorised, and run the OAuth dance for
// the servers that want a login instead of a key. Nothing more.
//
// Gepetel does not run MCP tools himself — the hosted `mcp` tool on the
// Responses API does, server-side, per group (see getMcpToolsForGroup). What
// he does need is to CHECK a connector the moment someone hands him a URL in a
// 1:1: a wrong key should fail there, privately, not days later in the group
// as "the Trello thing doesn't work". So this speaks just the opening of the
// Streamable HTTP transport — initialize, initialized, tools/list — and reports
// the tool names back.
//
// OAuth (MCP authorization spec, 2025-06-18): a server that wants a login
// answers the handshake with 401 and a WWW-Authenticate pointing at its
// protected-resource metadata; that names the authorization server, whose own
// metadata names the endpoints. Gepetel registers himself as a public client
// (dynamic registration, or a client-id metadata document where the server
// prefers that), sends the person an authorize link with PKCE, and swaps the
// code for tokens at /oauth/callback. Atlassian's Trello server is the first
// real user of this path.
import axios from "axios";
import crypto from "node:crypto";
import u from "./util.js";

export type McpTool = { name: string; description: string };
export type McpProbe = { serverName: string; tools: McpTool[] };

export type AuthServerMeta = {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
    code_challenge_methods_supported?: string[];
    client_id_metadata_document_supported?: boolean;
    token_endpoint_auth_methods_supported?: string[];
};

export type OAuthRequirement = {
    resource: string;                 // what the token must be minted for (RFC 8707)
    scopes: string[];                 // the resource's scopes_supported, if any
    as: AuthServerMeta;
};

export type OAuthClient = { client_id: string; client_secret?: string };

export type OAuthTokens = {
    access_token: string;
    refresh_token?: string;
    expires_at?: number;              // epoch ms; undefined = never told
    scope?: string;
};

const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = 20_000;

function baseHeaders(headers: Record<string, string>, sessionId?: string) {
    return {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
        ...headers,
    };
}

async function post(url: string, headers: Record<string, string>, body: any, sessionId?: string) {
    return axios.post(url, body, {
        headers: baseHeaders(headers, sessionId),
        timeout: TIMEOUT_MS,
        responseType: "text",
        transformResponse: [(d: any) => d],
        validateStatus: () => true,
    });
}

class HttpError extends Error {
    constructor(public status: number, message: string, public wwwAuthenticate = "") { super(message); }
}

async function rpc(url: string, headers: Record<string, string>, body: any, sessionId?: string) {
    const res = await post(url, headers, body, sessionId);
    const newSession = res.headers?.["mcp-session-id"] || sessionId;
    if (res.status === 401 || res.status === 403) {
        throw new HttpError(res.status, `the server refused the credentials (HTTP ${res.status}) — check the key/token`, String(res.headers?.["www-authenticate"] || ""));
    }
    if (res.status === 404 || res.status === 405) {
        throw new HttpError(res.status, `nothing answers MCP at that URL (HTTP ${res.status}) — check the address, it usually ends in /mcp`);
    }
    if (res.status >= 400) {
        throw new HttpError(res.status, `the server answered HTTP ${res.status}`);
    }
    const messages = u.parseJsonRpcResponse(String(res.data ?? ""), String(res.headers?.["content-type"] || ""));
    const reply = messages.find(m => m && m.id !== undefined && m.id === body.id);
    return { reply, sessionId: newSession };
}

function initializeBody() {
    return {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "gepetel", version: "1.0" },
        },
    };
}

// Ask the server who it is and what it can do. Throws with a message meant to
// be read back to the person, since it comes straight from a tool result.
export async function probeMcpServer(serverUrl: string, headers: Record<string, string> = {}): Promise<McpProbe> {
    const url = String(serverUrl || "").trim();
    if (!/^https:\/\//i.test(url)) throw new Error("the MCP server URL must start with https://");

    const init = await rpc(url, headers, initializeBody());
    if (!init.reply) throw new Error("the server did not answer the MCP handshake — is this an MCP endpoint?");
    if (init.reply.error) throw new Error(`the server rejected the handshake: ${init.reply.error.message || "unknown error"}`);
    const serverName = String(init.reply.result?.serverInfo?.name || "");

    // A notification, no reply expected; a server may answer 202 or 200.
    try { await post(url, headers, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId); } catch { /* not load-bearing */ }

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

// --- OAuth discovery ---

async function getJson(url: string): Promise<any | null> {
    try {
        const res = await axios.get(url, { timeout: TIMEOUT_MS, validateStatus: () => true, headers: { Accept: "application/json" } });
        if (res.status !== 200) return null;
        return typeof res.data === "object" ? res.data : JSON.parse(String(res.data));
    } catch { return null; }
}

// Does this server want a login rather than a key? Answers with what it takes,
// or null when a plain (or no) header will do. Only a 401 on the handshake that
// points at protected-resource metadata counts: anything else is just a server
// that is unhappy about something else.
export async function discoverOAuth(serverUrl: string): Promise<OAuthRequirement | null> {
    const url = String(serverUrl || "").trim();
    if (!/^https:\/\//i.test(url)) throw new Error("the MCP server URL must start with https://");
    let www = "";
    try {
        await rpc(url, {}, initializeBody());
        return null;                                   // it answered without auth
    } catch (e: any) {
        if (!(e instanceof HttpError) || e.status !== 401) {
            if (e instanceof HttpError && e.status === 403) return null;
            throw e;
        }
        www = e.wwwAuthenticate;
    }
    const metaUrls = [
        u.resourceMetadataUrlFrom(www),
        ...u.protectedResourceMetadataUrls(url),
    ].filter(Boolean) as string[];
    let resourceMeta: any = null;
    for (const m of metaUrls) { resourceMeta = await getJson(m); if (resourceMeta?.authorization_servers?.length) break; resourceMeta = null; }
    if (!resourceMeta) throw new Error("the server wants a login but doesn't say where — it answered 401 without usable OAuth metadata");

    const issuer = String(resourceMeta.authorization_servers[0]);
    let as: any = null;
    for (const m of u.authServerMetadataUrls(issuer)) { as = await getJson(m); if (as?.authorization_endpoint && as?.token_endpoint) break; as = null; }
    if (!as) throw new Error("the server's login provider publishes no usable OAuth metadata");
    if (Array.isArray(as.code_challenge_methods_supported) && !as.code_challenge_methods_supported.includes("S256")) {
        throw new Error("the login provider doesn't support PKCE (S256), which is required");
    }
    return {
        resource: String(resourceMeta.resource || url),
        scopes: Array.isArray(resourceMeta.scopes_supported) ? resourceMeta.scopes_supported.map(String) : [],
        as: {
            issuer: String(as.issuer || issuer),
            authorization_endpoint: String(as.authorization_endpoint),
            token_endpoint: String(as.token_endpoint),
            registration_endpoint: as.registration_endpoint ? String(as.registration_endpoint) : undefined,
            code_challenge_methods_supported: as.code_challenge_methods_supported,
            client_id_metadata_document_supported: !!as.client_id_metadata_document_supported,
            token_endpoint_auth_methods_supported: as.token_endpoint_auth_methods_supported,
        },
    };
}

// The client metadata Gepetel presents about himself — the body of a dynamic
// registration, and the document served at /oauth/client-metadata.json for
// providers that take a URL as the client id instead.
export function clientMetadata(redirectUri: string, clientMetadataUrl?: string) {
    return {
        ...(clientMetadataUrl ? { client_id: clientMetadataUrl } : {}),
        client_name: "Gepetel",
        client_uri: u.publicBaseUrl(),
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
    };
}

// Become a client of the login provider. Dynamic registration first (the MCP
// spec's default); a client-id metadata document where that is what the
// provider supports; otherwise there is no way in without a pre-registered id.
export async function registerClient(as: AuthServerMeta, redirectUri: string, clientMetadataUrl: string): Promise<OAuthClient> {
    if (as.registration_endpoint) {
        const res = await axios.post(as.registration_endpoint, clientMetadata(redirectUri), {
            timeout: TIMEOUT_MS, validateStatus: () => true, headers: { "Content-Type": "application/json", Accept: "application/json" },
        });
        if (res.status >= 200 && res.status < 300 && res.data?.client_id) {
            return { client_id: String(res.data.client_id), client_secret: res.data.client_secret ? String(res.data.client_secret) : undefined };
        }
        if (!as.client_id_metadata_document_supported) {
            const why = res.data?.error_description || res.data?.error || `HTTP ${res.status}`;
            throw new Error(`the login provider refused to register Gepetel as a client (${why})`);
        }
    }
    if (as.client_id_metadata_document_supported) return { client_id: clientMetadataUrl };
    throw new Error("the login provider doesn't let apps register themselves, so Gepetel would need a client id set up by hand");
}

// --- The authorization-code flow, with PKCE ---

export function pkcePair(): { verifier: string; challenge: string } {
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
}

export function newState(): string {
    return crypto.randomBytes(24).toString("base64url");
}

export function authorizeUrl(req: OAuthRequirement, client: OAuthClient, redirectUri: string, state: string, codeChallenge: string): string {
    const url = new URL(req.as.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.client_id);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", req.resource);
    if (req.scopes.length) url.searchParams.set("scope", req.scopes.join(" "));
    return url.toString();
}

async function tokenRequest(tokenEndpoint: string, client: OAuthClient, form: Record<string, string>): Promise<OAuthTokens> {
    const body = new URLSearchParams({ ...form, client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}) });
    const res = await axios.post(tokenEndpoint, body.toString(), {
        timeout: TIMEOUT_MS, validateStatus: () => true,
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    });
    const data = typeof res.data === "object" ? res.data : (() => { try { return JSON.parse(String(res.data)); } catch { return {}; } })();
    if (res.status >= 400 || !data?.access_token) {
        const why = data?.error_description || data?.error || `HTTP ${res.status}`;
        throw new Error(`the login provider refused to issue a token (${why})`);
    }
    return {
        access_token: String(data.access_token),
        refresh_token: data.refresh_token ? String(data.refresh_token) : undefined,
        expires_at: Number.isFinite(Number(data.expires_in)) ? Date.now() + Number(data.expires_in) * 1000 : undefined,
        scope: data.scope ? String(data.scope) : undefined,
    };
}

export async function exchangeCode(tokenEndpoint: string, client: OAuthClient, code: string, redirectUri: string, codeVerifier: string, resource: string): Promise<OAuthTokens> {
    return tokenRequest(tokenEndpoint, client, {
        grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier, resource,
    });
}

export async function refreshTokens(tokenEndpoint: string, client: OAuthClient, refreshToken: string, resource: string): Promise<OAuthTokens> {
    const fresh = await tokenRequest(tokenEndpoint, client, { grant_type: "refresh_token", refresh_token: refreshToken, resource });
    // A provider that rotates refresh tokens sends a new one; one that doesn't
    // sends none, and the old one stays valid.
    if (!fresh.refresh_token) fresh.refresh_token = refreshToken;
    return fresh;
}

export default { probeMcpServer, discoverOAuth, registerClient, clientMetadata, pkcePair, newState, authorizeUrl, exchangeCode, refreshTokens };
