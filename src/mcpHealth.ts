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
    /** A login the provider refused to renew: someone should be told (reauth.ts). */
    onLapsed?(chatId: string, c: HealthConnector): void;
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
        try { deps.onLapsed?.(chatId, c); } catch { /* telling them is never what fails a reply */ }
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

/** The connector a failed call couldn't reach ("" when the failure is something else). */
export function unreachableLabel(e: any): string {
    const label = String(e?.error?.message || e?.message || "").match(/MCP server: '([^']+)'/)?.[1] || "";
    const isConnector = e?.error?.type === "external_connector_error" || e?.type === "external_connector_error" || e?.status === 424;
    return isConnector ? label : "";
}
/**
 * The same request without that connector, the model told it's unreachable
 * just now. The note goes into the conversation, last, where it is read with
 * the message being answered: added to the instructions it changed them, and
 * the prompt cache matches those whole or not at all (promptShape.ts) — a
 * connection down for a day cost every reply of that chat its cache.
 */
export function withoutServer(req: any, label: string, notice = ""): any {
    const out = { ...req, tools: (req.tools || []).filter((t: any) => !(t?.type === "mcp" && t.server_label === label)) };
    const note = (notice || `\n\n[Unreachable] Their "${label}" connection can't be reached right now. If what they asked needs it, say so in a line and that you'll try again in a moment; help with what you can.`);
    if (Array.isArray(out.input)) out.input = [...out.input, { role: "developer", content: note.trim() }];
    else if (typeof out.instructions === "string") out.instructions += note;
    return out;
}

// ---------------------------------------------------------------------------
// A connection that keeps failing is left out for a while.
//
// Every request asks each connector for its tool list before the model writes
// a word, and one that can't be reached fails the whole request: it is tried,
// its login refreshed, tried again, then dropped — about three seconds a try.
// That was paid again on every request and every tool round of every reply:
// two of one person's connections went down (2026-11-25) and each question on
// a phone call took 16 to 26 seconds, 12 to 15 of them these retries; their
// check-ins, which had no such handling, found nothing at all for a day.
//
// So a connection that failed is remembered, and requests go out without it
// until it is due another try: after 5 minutes, then 10, 20, at most 30 — or
// at once when its login has changed (they reconnected it, or the token was
// renewed). A try that works forgets it. Kept in memory: a restart tries all.

export const DOWN_FIRST_MS = 5 * 60_000;
export const DOWN_MAX_MS = 30 * 60_000;
/** After this long it isn't a blip, and the person should hear how to fix it. */
export const DOWN_LONG_MS = 60 * 60_000;

type Down = { since: number; until: number; forMs: number; fails: number; token: string; notice?: string };

export class DownList {
    private down = new Map<string, Down>();
    constructor(private now: () => number = Date.now) {}
    private key(entry: any): string { return `${entry?.server_label || ""}|${entry?.server_url || ""}`; }
    /** Has it failed lately, whether or not it is due another try. */
    failing(entry: any): boolean { return this.down.has(this.key(entry)); }
    /** Leave it out of this request? Its record when so. */
    out(entry: any): Down | null {
        const d = this.down.get(this.key(entry));
        if (!d || this.now() >= d.until) return null;
        if (String(entry?.authorization || "") !== d.token) return null;
        return d;
    }
    failed(entry: any, notice?: string): Down {
        const k = this.key(entry), was = this.down.get(k), now = this.now();
        const fails = (was?.fails || 0) + 1;
        const forMs = Math.min(DOWN_FIRST_MS * 2 ** (fails - 1), DOWN_MAX_MS);
        const d: Down = { since: was?.since ?? now, fails, forMs, until: now + forMs, token: String(entry?.authorization || ""), notice: notice ?? was?.notice };
        this.down.set(k, d);
        return d;
    }
    worked(entry: any): void { this.down.delete(this.key(entry)); }
    /** Found out why it fails (its login is refused): what the model is told from now on. */
    because(entry: any, notice: string): void { const d = this.down.get(this.key(entry)); if (d) d.notice = notice; }
    /** What the model is told about one left out. */
    notice(entry: any): string {
        const d = this.down.get(this.key(entry));
        if (d?.notice) return d.notice;
        const label = String(entry?.server_label || "");
        if (!d || this.now() - d.since < DOWN_LONG_MS) return "";
        const hours = Math.max(1, Math.round((this.now() - d.since) / 3_600_000));
        return `\n\n[Unreachable] Their "${label}" connection has not answered for about ${hours} hour${hours === 1 ? "" : "s"} — not a blip. It is NOT available in this reply. If what they asked needs it, say so in one short line and that connecting it again usually fixes it, and offer that (in their private chat: remove_mcp_connector then add_mcp_connector gives a fresh link). If what they asked doesn't need it, don't bring it up. Help with what you can.`;
    }
}
/** The one list the server keeps. */
export const connectorsDown = new DownList();

/** What a connector that couldn't be reached turned out to be, once its login was checked. */
export type Recovered = { entry?: any; notice?: string };

/**
 * Make the call; for every connection that can't be reached, drop it and try
 * again. One down (their computer reconnecting, a service out) used to fail
 * the whole reply (2026-10-16); two down at once — Gmail and Calendar,
 * 2026-11-12 — failed it on the second one.
 *
 * A login revoked at the provider (Google's "remove access") looks the same
 * from here: the tool list can't be fetched, 424. So before dropping one,
 * `recover` gets a chance to check its login: a refreshed token is tried once
 * in its place; a refresh the provider refuses comes back as a notice (login
 * lapsed, reconnect now) instead of "try again in a moment".
 */
export async function createDroppingUnreachable(
    create: (req: any) => Promise<any>, req: any,
    log: (s: string) => void = console.warn,
    recover?: (label: string, entry: any) => Promise<Recovered>,
    opts: { downList?: DownList; quiet?: boolean; onFailed?: (entry: any, fails: number) => void } = {},
): Promise<{ res: any; req: any }> {
    const { downList } = opts;
    // Nobody is being answered (a check-in looking through their things): the
    // connection is just left out, with nothing said about it.
    const without = (r: any, label: string, notice: string) => opts.quiet ? { ...r, tools: withoutServer(r, label).tools } : withoutServer(r, label, notice);
    const dropped: string[] = [];
    const checked = new Set<string>();
    const mcpOf = (r: any): any[] => Array.isArray(r?.tools) ? r.tools.filter((t: any) => t?.type === "mcp" && t.server_label) : [];
    // Those that failed a moment ago aren't asked again yet.
    if (downList) for (const t of mcpOf(req)) {
        if (!downList.out(t)) continue;
        dropped.push(t.server_label);
        req = without(req, t.server_label, downList.notice(t));
    }
    for (;;) {
        try {
            const res = await create(req);
            if (downList) for (const t of mcpOf(req)) if (downList.failing(t)) { downList.worked(t); log(`[mcp] ${t.server_label} answers again`); }
            return { res, req };
        }
        catch (e: any) {
            const label = unreachableLabel(e);
            const entry = Array.isArray(req?.tools) ? req.tools.find((t: any) => t?.type === "mcp" && t.server_label === label) : null;
            if (!label || dropped.includes(label) || !entry) throw e;
            let got: Recovered = {};
            // Its login is checked on the first failure of a run of them, not on
            // every later try: a refresh that didn't help then won't now.
            if (recover && !checked.has(label) && !downList?.failing(entry)) {
                checked.add(label);
                got = await recover(label, entry).catch(() => ({}));
                if (got.entry) {
                    log(`[mcp] ${label} couldn't be reached (${e?.status || "?"}) — trying once more with a refreshed login`);
                    req = { ...req, tools: req.tools.map((t: any) => t === entry ? got.entry : t) };
                    continue;
                }
            }
            dropped.push(label);
            const d = downList?.failed(entry, got.notice);
            // Failing again, minutes after the first time and a renewed login:
            // worth finding out whether it is the login (reauth.ts).
            if (d) try { opts.onFailed?.(entry, d.fails); } catch { /* never what fails a reply */ }
            log(`[mcp] ${label} couldn't be reached (${e?.status || "?"})${got.notice ? " — login lapsed" : ""} — answering without it${d ? `, and leaving it out for ${Math.round(d.forMs / 60_000)} min` : ""}`);
            req = without(req, label, got.notice || (downList ? downList.notice(entry) : ""));
        }
    }
}
