// Connector health: decides, for each OAuth connector, whether its token can be
// used, needs refreshing, or has lapsed for good. Deliberately free of I/O
// imports — the database and the token endpoint are injected — so the
// classification and the refresh-and-retry rules are unit-testable.

/** Thrown by the token endpoint call. `status` is absent for network errors/timeouts. */
export class OAuthRefreshError extends Error {
    status?: number;
    code?: string;
    constructor(message: string, status?: number, code?: string) {
        super(message);
        this.name = "OAuthRefreshError";
        this.status = status;
        this.code = code;
    }
}

const DEFINITIVE_CODES = new Set(["invalid_grant", "invalid_client", "unauthorized_client", "invalid_token", "access_denied"]);
const TRANSIENT_CODES = new Set(["temporarily_unavailable", "server_error"]);

/**
 * Definitive: the provider answered and said this login is dead (invalid_grant,
 * invalid_client, 400/401). Transient: network error, timeout, 5xx, 429 — the
 * login may be fine, so never send the user to reconnect over it.
 */
export function classifyRefreshFailure(e: any): "definitive" | "transient" {
    const status: number | undefined = typeof e?.status === "number" ? e.status : undefined;
    const code = String(e?.code || "").toLowerCase();
    if (TRANSIENT_CODES.has(code)) return "transient";
    if (DEFINITIVE_CODES.has(code)) return "definitive";
    if (status === undefined) return "transient";
    if (status === 429 || status >= 500) return "transient";
    if (status === 400 || status === 401) return "definitive";
    return "transient";
}

/**
 * True for a tool-call/list-tools failure that means "the credential was rejected".
 * Prefers the structured status/code on the error object; free text only counts
 * when it names a rejection as a phrase, never a bare "403" or "authentication"
 * ("Rate limit: 403 items exceeded", "Authentication service timeout" are not one).
 */
export function isAuthFailureText(err: unknown): boolean {
    if (!err) return false;
    if (typeof err === "object") {
        const e: any = err;
        const status = Number(e.status ?? e.status_code ?? e.code);
        if (status === 401 || status === 403) return true;
        const code = String(e.code ?? e.type ?? "").toLowerCase();
        if (code === "invalid_token" || code === "unauthorized" || code === "401" || code === "403") return true;
        const msg = e.message ?? e.error;
        if (typeof msg === "string") return isAuthFailureText(msg);
        return false;
    }
    const s = String(err);
    return /\b(?:http|status|status code|error|code)[\s:=]*(?:40[13])\b|\b40[13]\s+(?:unauthori[sz]ed|forbidden)\b|invalid[_ ]token|unauthori[sz]ed|www-authenticate|authentication (?:failed|required)|expired token|token (?:has )?expired/i.test(s);
}

/** Server labels of hosted-MCP output items that failed with an auth error. */
export function authFailedLabels(items: any[]): string[] {
    const out = new Set<string>();
    for (const it of items || []) {
        if ((it?.type === "mcp_list_tools" || it?.type === "mcp_call") && it.server_label && isAuthFailureText(it.error)) {
            out.add(String(it.server_label));
        }
    }
    return [...out];
}

export type HealthConnector = {
    connector_id: string; label: string; server_label: string; server_url: string; description: string;
    auth_kind: "headers" | "oauth"; headers?: Record<string, string>; needs_reconnect?: boolean;
    oauth?: {
        client_id: string; client_secret?: string; token_endpoint: string; resource: string;
        access_token: string; refresh_token?: string; expires_at?: number;
    };
};

export type HealthDeps = {
    list(chatId: string): Promise<HealthConnector[]>;
    refresh(o: NonNullable<HealthConnector["oauth"]>): Promise<any>;
    saveTokens(connectorId: string, tokens: any): Promise<void>;
    setNeedsReconnect(connectorId: string, value: boolean): Promise<void>;
    now?: () => number;
};

export type McpContext = {
    tools: any[];
    /** Labels of connectors whose login is revoked/expired and must be redone. */
    lapsed: string[];
};

/**
 * The hosted-MCP tool entries for one chat, plus the connectors whose login has
 * lapsed. `forceRefresh` names server labels whose token was just rejected by
 * the provider: those are refreshed even though `expires_at` says they're fine.
 */
export async function buildMcpContext(chatId: string, deps: HealthDeps, forceRefresh: Set<string> = new Set()): Promise<McpContext> {
    const now = deps.now ?? Date.now;
    const rows = await deps.list(chatId);
    const tools: any[] = [];
    const lapsed: string[] = [];

    const lapse = async (c: HealthConnector, why: string) => {
        console.error(`connector ${c.label} in ${chatId}: ${why} — needs reconnect`);
        lapsed.push(c.label);
        if (!c.needs_reconnect) await deps.setNeedsReconnect(c.connector_id, true).catch(() => {});
    };

    for (const c of rows) {
        const entry: any = {
            type: "mcp",
            server_label: c.server_label,
            server_url: c.server_url,
            require_approval: "never",
            server_description: `${c.label}${c.description ? ` — ${c.description}` : ""}`,
        };
        if (c.auth_kind === "oauth") {
            let o = c.oauth;
            if (!o?.access_token) { console.error(`connector ${c.label}: no access token`); continue; }
            const expiring = o.expires_at !== undefined && o.expires_at - now() < 60_000;
            const rejected = forceRefresh.has(c.server_label);
            if ((expiring || rejected) && o.refresh_token) {
                try {
                    const fresh = await deps.refresh(o!);
                    await deps.saveTokens(c.connector_id, fresh);
                    if (c.needs_reconnect) await deps.setNeedsReconnect(c.connector_id, false).catch(() => {});
                    o = { ...o, ...fresh };
                } catch (e: any) {
                    if (classifyRefreshFailure(e) === "definitive") {
                        await lapse(c, `token refresh refused (${e?.code || e?.status || "rejected"})`);
                    } else {
                        // Transient: skip this reply, try again next time. No flag, no link.
                        console.error(`connector ${c.label} in ${chatId}: token refresh failed (transient) — ${e?.message}`);
                    }
                    continue;
                }
            } else if (expiring || rejected) {
                await lapse(c, rejected ? "token rejected and no refresh token" : "token expired and no refresh token");
                continue;
            } else if (c.needs_reconnect) {
                // Flagged earlier but the token now looks usable again (e.g. reconnected): let it through.
                await deps.setNeedsReconnect(c.connector_id, false).catch(() => {});
            }
            entry.authorization = o!.access_token;
        } else if (c.headers && Object.keys(c.headers).length) {
            entry.headers = c.headers;
        }
        tools.push(entry);
    }
    return { tools, lapsed };
}

/** The line appended to the model's instructions when connectors have lapsed. */
export function lapsedNotice(lapsed: string[], isGroup: boolean): string {
    if (!lapsed.length) return "";
    const names = lapsed.join(", ");
    return isGroup
        ? `\n\n[Login lapsed] The login for ${names} was revoked or has expired, so ${lapsed.length > 1 ? "those services are" : "that service is"} NOT available in this reply. In your first reply on the topic, say so in one short line and point the person to their private chat with you to reconnect it (as your rules describe). Do not ask whether they want that — just do it.`
        : `\n\n[Login lapsed] The login for ${names} was revoked or has expired, so ${lapsed.length > 1 ? "those services are" : "that service is"} NOT available in this reply. In your first reply on the topic, say so in one short line and IN THE SAME REPLY reconnect it: remove_mcp_connector then add_mcp_connector, and give the fresh link. Do not ask "want me to reconnect?" and do not wait for the person to ask.`;
}
