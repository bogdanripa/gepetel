// Gmail and Calendar over Google's plain REST APIs, served as an MCP server of
// our own: POST /google-mcp/gmail and /google-mcp/calendar.
//
// Google's own MCP servers (gmailmcp / calendarmcp.googleapis.com) can refuse a
// Workspace account's token outright — "Request had invalid authentication
// credentials", 401 invalid_token — while the very same token reads the same
// mailbox through gmail.googleapis.com and www.googleapis.com/calendar without
// a complaint (genez.io, 2026-11-26: both work connectors dropped at once, and
// a fresh login was refused the same way). With nothing else to reach them by,
// he went to the person's computer and clicked through Gmail in a browser.
//
// So when Google's server refuses a token that the plain API accepts, the
// connector is pointed here instead (oai.ts, recoverConnector). Same tool
// names as Google's servers, so the prompts, playbooks and Pulse's read-only
// lists keep working; the token the hosted-MCP call carries is the person's own
// Google token, passed straight on to Google and never stored.

import { publicBaseUrl } from "./util.js";
import { buildMime } from "./gmail.js";

export type Service = "gmail" | "calendar";
type Fetch = typeof fetch;

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CAL = "https://www.googleapis.com/calendar/v3";
const MCP_HOST: Record<string, Service> = { "gmailmcp.googleapis.com": "gmail", "calendarmcp.googleapis.com": "calendar" };
const PROXY_PATH = "/google-mcp/";
const BODY_CHARS = 20_000;

/** Which Google service an MCP URL is: Google's own server or ours standing in for it. */
export function serviceOf(serverUrl: string): Service | null {
    try {
        const u = new URL(serverUrl);
        if (MCP_HOST[u.hostname]) return MCP_HOST[u.hostname];
        const m = u.pathname.match(/^\/google-mcp\/(gmail|calendar)$/);
        return m ? m[1] as Service : null;
    } catch { return null; }
}
export function isGoogleMcpHost(serverUrl: string): boolean {
    try { return !!MCP_HOST[new URL(serverUrl).hostname]; } catch { return false; }
}
export function proxyUrl(service: Service, base = publicBaseUrl()): string { return `${base}${PROXY_PATH}${service}`; }

// --- Which connectors go through here -------------------------------------
// Kept in memory: after a restart the first reply finds Google refusing again
// and recovers the same way. It expires so that a refusal Google lifts is
// noticed — the connector tries Google's own server again twice a day.
const FALLBACK_MS = 12 * 3600_000;
const routed = new Map<string, number>();
const keyOf = (chatId: string, label: string) => `${chatId}|${label}`;
export function routeHere(chatId: string, label: string, now = Date.now()): void { routed.set(keyOf(chatId, label), now + FALLBACK_MS); }
export function routedHere(chatId: string, label: string, now = Date.now()): boolean {
    const until = routed.get(keyOf(chatId, label));
    if (until === undefined) return false;
    if (until < now) { routed.delete(keyOf(chatId, label)); return false; }
    return true;
}
/** The hosted-MCP entry pointed here, when this connector is routed here. */
export function rerouted<T extends { server_url?: string; server_label?: string }>(chatId: string, entry: T): T {
    const service = entry?.server_url && isGoogleMcpHost(entry.server_url) ? serviceOf(entry.server_url) : null;
    return service && routedHere(chatId, String(entry.server_label || "")) ? { ...entry, server_url: proxyUrl(service) } : entry;
}

/** Does Google's MCP server refuse this token? One read-only call that needs no arguments. */
export async function mcpRefuses(serverUrl: string, token: string, fetchImpl: Fetch = fetch): Promise<boolean> {
    const service = serviceOf(serverUrl);
    if (!service) return false;
    const tool = service === "gmail" ? "list_labels" : "list_calendars";
    try {
        const r = await fetchImpl(serverUrl, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: {} } }),
        });
        if (r.status === 401 || r.status === 403) return true;
        const text = await r.text().catch(() => "");
        return /invalid authentication credentials|invalid_token|PERMISSION_DENIED|UNAUTHENTICATED/i.test(text);
    } catch { return false; }
}

/** Does the plain API take this token? */
export async function restWorks(service: Service, token: string, fetchImpl: Fetch = fetch): Promise<boolean> {
    const url = service === "gmail" ? `${GMAIL}/labels` : `${CAL}/calendars/primary/events?maxResults=1`;
    try { return (await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } })).status === 200; } catch { return false; }
}

// --- The tools ---------------------------------------------------------------

const str = (description: string) => ({ type: "string", description });
const strs = (description: string) => ({ type: "array", items: { type: "string" }, description });
const int = (description: string) => ({ type: "integer", description });
const tool = (name: string, description: string, properties: Record<string, any>, required: string[], readOnly: boolean) =>
    ({ name, description, inputSchema: { type: "object", properties, required }, annotations: { readOnlyHint: readOnly, destructiveHint: false, title: description.split(".")[0] } });

const NOTIFY = { type: "string", enum: ["NONE", "EXTERNAL_ONLY", "ALL"], description: "Who gets an email about the change. Default ALL." };

export const TOOLS: Record<Service, any[]> = {
    gmail: [
        tool("search_threads", "Lists email threads, newest first, filtered by a Gmail search query (from:, to:, subject:, is:unread, newer_than:2d, after:2026/11/01 …). Returns each thread's id, subject, people, date and snippet.",
            { query: str("Gmail search query; empty for the inbox"), pageSize: int("How many, 1-25 (default 10)"), pageToken: str("From a previous call's nextPageToken"), includeTrash: { type: "boolean", description: "Include Trash and Spam" } }, [], true),
        tool("get_thread", "Retrieves an email thread with all its messages: headers, plain-text body and attachment names.", { threadId: str("Thread id") }, ["threadId"], true),
        tool("get_message", "Retrieves one email message: headers, plain-text body and attachment names.", { messageId: str("Message id") }, ["messageId"], true),
        tool("list_labels", "Lists the mailbox's labels with their ids.", {}, [], true),
        tool("list_drafts", "Lists draft emails, optionally filtered by a Gmail search query.", { query: str("Gmail search query"), pageSize: int("How many, 1-25 (default 10)") }, [], true),
        tool("get_draft", "Retrieves one draft email.", { draftId: str("Draft id") }, ["draftId"], true),
        tool("create_draft", "Creates a draft email (it is not sent). With replyToMessageId it is a reply in that message's thread.",
            { to: strs("Recipients"), cc: strs("Cc"), bcc: strs("Bcc"), subject: str("Subject"), body: str("Plain-text body"), replyToMessageId: str("The message this answers") }, [], false),
        tool("label_thread", "Adds labels to every message in a thread.", { threadId: str("Thread id"), labelIds: strs("Label ids") }, ["threadId", "labelIds"], false),
        tool("unlabel_thread", "Removes labels from every message in a thread (remove INBOX to archive).", { threadId: str("Thread id"), labelIds: strs("Label ids") }, ["threadId", "labelIds"], false),
        tool("label_message", "Adds labels to one message.", { messageId: str("Message id"), labelIds: strs("Label ids") }, ["messageId", "labelIds"], false),
        tool("unlabel_message", "Removes labels from one message (UNREAD to mark it read).", { messageId: str("Message id"), labelIds: strs("Label ids") }, ["messageId", "labelIds"], false),
        tool("update_message_labels", "Adds and/or removes labels on one message.", { messageId: str("Message id"), addLabelIds: strs("Labels to add"), removeLabelIds: strs("Labels to remove") }, ["messageId"], false),
        tool("trash_thread", "Moves a thread to the Trash.", { threadId: str("Thread id") }, ["threadId"], false),
        tool("untrash_thread", "Takes a thread out of the Trash.", { threadId: str("Thread id") }, ["threadId"], false),
        tool("trash_message", "Moves one message to the Trash.", { messageId: str("Message id") }, ["messageId"], false),
        tool("untrash_message", "Takes one message out of the Trash.", { messageId: str("Message id") }, ["messageId"], false),
        tool("mark_thread_spam", "Marks a thread as spam.", { threadId: str("Thread id") }, ["threadId"], false),
        tool("unmark_thread_spam", "Takes a thread out of spam.", { threadId: str("Thread id") }, ["threadId"], false),
        tool("mark_message_spam", "Marks one message as spam.", { messageId: str("Message id") }, ["messageId"], false),
        tool("unmark_message_spam", "Takes one message out of spam.", { messageId: str("Message id") }, ["messageId"], false),
        tool("create_label", "Creates a label; a slash makes a nested one (Projects/Alpha).", { displayName: str("Label name") }, ["displayName"], false),
    ],
    calendar: [
        tool("list_calendars", "Returns the calendars this user owns or has subscribed to.", {}, [], true),
        tool("list_events", "Returns events on a calendar, soonest first. Times are RFC 3339 (2026-11-27T09:00:00+02:00). With no startTime, from now on.",
            { calendarId: str("Calendar id; default primary"), startTime: str("From (RFC 3339)"), endTime: str("Until (RFC 3339)"), fullText: str("Only events matching this text"), pageSize: int("How many, 1-100 (default 25)"), pageToken: str("From a previous call's nextPageToken"), timeZone: str("IANA zone for the times returned") }, [], true),
        tool("get_event", "Returns one event.", { calendarId: str("Calendar id; default primary"), eventId: str("Event id") }, ["eventId"], true),
        tool("search_events", "Finds events on the primary calendar whose text matches the query, past or future.", { query: str("Words to look for"), pageSize: int("How many (default 25)") }, ["query"], true),
        tool("create_event", "Creates an event. Times are RFC 3339; with allDay, only the dates count (endTime is the day after the last day).",
            { calendarId: str("Calendar id; default primary"), summary: str("Title"), startTime: str("Start"), endTime: str("End"), allDay: { type: "boolean" }, timeZone: str("IANA zone, when the times carry no offset"), description: str("Notes"), location: str("Where"), attendeeEmails: strs("Guests"), addGoogleMeetUrl: { type: "boolean", description: "Add a Google Meet link" }, recurrenceData: strs("RRULE lines"), notificationLevel: NOTIFY }, ["summary", "startTime", "endTime"], false),
        tool("update_event", "Updates an event: only the fields given change.",
            { calendarId: str("Calendar id; default primary"), eventId: str("Event id"), summary: str("Title"), startTime: str("Start"), endTime: str("End"), allDay: { type: "boolean" }, timeZone: str("IANA zone"), description: str("Notes"), location: str("Where"), addedAttendeeEmails: strs("Guests to add"), removedAttendeeEmails: strs("Guests to remove"), addGoogleMeetUrl: { type: "boolean" }, notificationLevel: NOTIFY }, ["eventId"], false),
        tool("delete_event", "Deletes an event.", { calendarId: str("Calendar id; default primary"), eventId: str("Event id"), notificationLevel: NOTIFY }, ["eventId"], false),
        tool("respond_to_event", "Answers an invitation: accepted, declined or tentative.", { calendarId: str("Calendar id; default primary"), eventId: str("Event id"), responseStatus: { type: "string", enum: ["accepted", "declined", "tentative"] }, responseComment: str("A note to the organiser"), notificationLevel: NOTIFY }, ["eventId", "responseStatus"], false),
    ],
};

export class GoogleError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

async function call(fetchImpl: Fetch, token: string, method: string, url: string, body?: any): Promise<any> {
    const r = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (r.status === 204) return {};
    const data: any = await r.json().catch(() => ({}));
    if (r.status >= 400) throw new GoogleError(r.status, `Google answered ${r.status}: ${String(data?.error?.message || data?.error_description || "error").slice(0, 300)}`);
    return data;
}
const qs = (o: Record<string, any>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) {
        if (v === undefined || v === null || v === "") continue;
        if (Array.isArray(v)) v.forEach(x => p.append(k, String(x))); else p.set(k, String(v));
    }
    const s = p.toString();
    return s ? `?${s}` : "";
};
const enc = encodeURIComponent;
const clamp = (n: any, lo: number, hi: number, d: number) => { const x = Math.floor(Number(n)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };

// --- Gmail --------------------------------------------------------------------

const header = (m: any, name: string) => String((m?.payload?.headers || []).find((h: any) => String(h.name).toLowerCase() === name.toLowerCase())?.value || "");
const b64 = (s: string) => Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** The readable text of a message: its text/plain part, else its HTML with the tags taken out. */
export function bodyText(payload: any): string {
    let plain = "", html = "";
    const walk = (p: any) => {
        if (!p) return;
        if (!p.filename && p.body?.data) {
            if (p.mimeType === "text/plain" && !plain) plain = b64(p.body.data);
            else if (p.mimeType === "text/html" && !html) html = b64(p.body.data);
        }
        for (const q of p.parts || []) walk(q);
    };
    walk(payload);
    const text = plain || html
        .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
        .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
    const t = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    return t.length > BODY_CHARS ? `${t.slice(0, BODY_CHARS)}\n[… cut at ${BODY_CHARS} characters]` : t;
}
function files(payload: any): { filename: string; mimeType: string; size: number }[] {
    const out: any[] = [];
    const walk = (p: any) => { if (!p) return; if (p.filename) out.push({ filename: p.filename, mimeType: p.mimeType, size: Number(p.body?.size || 0) }); (p.parts || []).forEach(walk); };
    walk(payload);
    return out;
}
export function messageView(m: any, full = true): any {
    const v: any = {
        id: m.id, threadId: m.threadId,
        from: header(m, "From"), to: header(m, "To"), cc: header(m, "Cc") || undefined,
        date: header(m, "Date"), subject: header(m, "Subject"),
        labelIds: m.labelIds, snippet: m.snippet,
        viewUrl: `https://mail.google.com/mail/#all/${m.threadId || m.id}`,
    };
    if (full) {
        v.body = bodyText(m.payload);
        const f = files(m.payload);
        if (f.length) v.attachments = f;
    }
    return v;
}
const META = { format: "metadata", metadataHeaders: ["From", "To", "Cc", "Date", "Subject"] };

async function gmailTool(name: string, a: any, token: string, f: Fetch): Promise<any> {
    const get = (path: string) => call(f, token, "GET", `${GMAIL}${path}`);
    const post = (path: string, body: any = {}) => call(f, token, "POST", `${GMAIL}${path}`, body);
    const modify = (kind: "threads" | "messages", id: string, add: string[] = [], remove: string[] = []) =>
        post(`/${kind}/${enc(id)}/modify`, { addLabelIds: add, removeLabelIds: remove }).then(r => ({ ok: true, id: r.id || id, labelIds: r.labelIds }));
    const need = (k: string) => { const v = String(a?.[k] || "").trim(); if (!v) throw new GoogleError(400, `${k} is required`); return v; };
    switch (name) {
        case "search_threads": {
            const list = await get(`/threads${qs({ q: a.query, maxResults: clamp(a.pageSize, 1, 25, 10), pageToken: a.pageToken, includeSpamTrash: a.includeTrash ? "true" : undefined })}`);
            const threads = await Promise.all((list.threads || []).map(async (t: any) => {
                const th = await get(`/threads/${enc(t.id)}${qs(META)}`).catch(() => null);
                const msgs = th?.messages || [];
                const first = msgs[0], last = msgs[msgs.length - 1];
                return { id: t.id, subject: header(first, "Subject"), from: header(first, "From"), to: header(first, "To"), lastFrom: header(last, "From"), date: header(last, "Date"), messages: msgs.length, unread: msgs.some((m: any) => (m.labelIds || []).includes("UNREAD")), labelIds: last?.labelIds, snippet: last?.snippet || t.snippet };
            }));
            return { threads, nextPageToken: list.nextPageToken };
        }
        case "get_thread": {
            const th = await get(`/threads/${enc(need("threadId"))}?format=full`);
            return { id: th.id, viewUrl: `https://mail.google.com/mail/#all/${th.id}`, messages: (th.messages || []).map((m: any) => messageView(m)) };
        }
        case "get_message": return messageView(await get(`/messages/${enc(need("messageId"))}?format=full`));
        case "list_labels": return { labels: ((await get("/labels")).labels || []).map((l: any) => ({ id: l.id, name: l.name, type: l.type })) };
        case "list_drafts": {
            const list = await get(`/drafts${qs({ q: a.query, maxResults: clamp(a.pageSize, 1, 25, 10) })}`);
            const drafts = await Promise.all((list.drafts || []).map(async (d: any) => {
                const full = await get(`/drafts/${enc(d.id)}${qs(META)}`).catch(() => null);
                return { id: d.id, ...(full?.message ? messageView(full.message, false) : {}) };
            }));
            return { drafts };
        }
        case "get_draft": {
            const d = await get(`/drafts/${enc(need("draftId"))}?format=full`);
            return { id: d.id, ...messageView(d.message) };
        }
        case "create_draft": {
            const list = (v: any) => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean).join(", ");
            let to = list(a.to), subject = String(a.subject || ""), inReplyTo = "", references = "", threadId = "";
            if (a.replyToMessageId) {
                const orig = await get(`/messages/${enc(String(a.replyToMessageId))}${qs({ format: "metadata", metadataHeaders: ["Message-ID", "Subject", "From", "Reply-To", "References"] })}`);
                const id = header(orig, "Message-ID");
                to = to || header(orig, "Reply-To") || header(orig, "From");
                const s = header(orig, "Subject");
                subject = subject || (/^re:/i.test(s) ? s : `Re: ${s}`);
                inReplyTo = id; references = [header(orig, "References"), id].filter(Boolean).join(" ");
                threadId = orig.threadId;
            }
            const mime = buildMime({ to, cc: list(a.cc) || undefined, bcc: list(a.bcc) || undefined, subject, body: String(a.body || ""), inReplyTo: inReplyTo || undefined, references: references || undefined });
            const d = await post("/drafts", { message: { raw: Buffer.from(mime, "utf8").toString("base64url"), ...(threadId ? { threadId } : {}) } });
            return { id: d.id, messageId: d.message?.id, threadId: d.message?.threadId, to, subject, viewUrl: `https://mail.google.com/mail/#drafts?compose=${d.message?.id || ""}` };
        }
        case "label_thread": return modify("threads", need("threadId"), a.labelIds);
        case "unlabel_thread": return modify("threads", need("threadId"), [], a.labelIds);
        case "label_message": return modify("messages", need("messageId"), a.labelIds);
        case "unlabel_message": return modify("messages", need("messageId"), [], a.labelIds);
        case "update_message_labels": return modify("messages", need("messageId"), a.addLabelIds || [], a.removeLabelIds || []);
        case "trash_thread": await post(`/threads/${enc(need("threadId"))}/trash`); return { ok: true };
        case "untrash_thread": await post(`/threads/${enc(need("threadId"))}/untrash`); return { ok: true };
        case "trash_message": await post(`/messages/${enc(need("messageId"))}/trash`); return { ok: true };
        case "untrash_message": await post(`/messages/${enc(need("messageId"))}/untrash`); return { ok: true };
        case "mark_thread_spam": return modify("threads", need("threadId"), ["SPAM"], ["INBOX"]);
        case "unmark_thread_spam": return modify("threads", need("threadId"), [], ["SPAM"]);
        case "mark_message_spam": return modify("messages", need("messageId"), ["SPAM"], ["INBOX"]);
        case "unmark_message_spam": return modify("messages", need("messageId"), [], ["SPAM"]);
        case "create_label": {
            const l = await post("/labels", { name: need("displayName"), labelListVisibility: "labelShow", messageListVisibility: "show" });
            return { id: l.id, name: l.name };
        }
    }
    throw new GoogleError(400, `unknown tool: ${name}`);
}

// --- Calendar -------------------------------------------------------------------

const SEND: Record<string, string> = { NONE: "none", EXTERNAL_ONLY: "externalOnly", ALL: "all" };
function eventView(e: any): any {
    return {
        id: e.id, summary: e.summary, start: e.start, end: e.end, location: e.location, description: e.description ? String(e.description).slice(0, 4000) : undefined,
        status: e.status, organizer: e.organizer?.email, attendees: (e.attendees || []).map((x: any) => ({ email: x.email, responseStatus: x.responseStatus, self: x.self || undefined })),
        meetUrl: e.hangoutLink, recurrence: e.recurrence, recurringEventId: e.recurringEventId, htmlLink: e.htmlLink,
    };
}
/** Start/end as Google wants them: a date for an all-day event, else a time with a zone. */
export function when(t: string, allDay: boolean, timeZone: string): any {
    const s = String(t || "").trim();
    if (allDay || /^\d{4}-\d{2}-\d{2}$/.test(s)) return { date: s.slice(0, 10) };
    const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
    return { dateTime: s.length === 16 ? `${s}:00` : s, ...(hasOffset ? {} : { timeZone }) };
}

async function calendarTool(name: string, a: any, token: string, f: Fetch): Promise<any> {
    const cal = enc(String(a.calendarId || "primary"));
    const go = (method: string, path: string, body?: any) => call(f, token, method, `${CAL}${path}`, body);
    const need = (k: string) => { const v = String(a?.[k] || "").trim(); if (!v) throw new GoogleError(400, `${k} is required`); return v; };
    // The calendar's own zone, for times given without an offset.
    const zone = async () => String(a.timeZone || (await go("GET", `/calendars/${cal}/events?maxResults=1`).catch(() => ({})))?.timeZone || "UTC");
    const send = SEND[String(a.notificationLevel || "ALL")] || "all";
    switch (name) {
        case "list_calendars": {
            try {
                const l = await go("GET", "/users/me/calendarList");
                return { calendars: (l.items || []).map((c: any) => ({ id: c.id, summary: c.summary, primary: c.primary || undefined, timeZone: c.timeZone, accessRole: c.accessRole })) };
            } catch (e: any) {
                // The sign-in may cover events only, not the list of calendars.
                if (e?.status === 403) return { calendars: [{ id: "primary", summary: "primary", primary: true }], note: "only the primary calendar is reachable with this sign-in" };
                throw e;
            }
        }
        case "list_events": {
            const l = await go("GET", `/calendars/${cal}/events${qs({
                singleEvents: "true", orderBy: "startTime", timeMin: a.startTime || new Date().toISOString(), timeMax: a.endTime,
                q: a.fullText, maxResults: clamp(a.pageSize, 1, 100, 25), pageToken: a.pageToken, timeZone: a.timeZone,
            })}`);
            return { timeZone: l.timeZone, events: (l.items || []).map(eventView), nextPageToken: l.nextPageToken };
        }
        case "get_event": return eventView(await go("GET", `/calendars/${cal}/events/${enc(need("eventId"))}`));
        case "search_events": {
            const l = await go("GET", `/calendars/primary/events${qs({ q: need("query"), singleEvents: "true", maxResults: clamp(a.pageSize, 1, 100, 25) })}`);
            return { timeZone: l.timeZone, events: (l.items || []).map(eventView) };
        }
        case "create_event": {
            const tz = await zone();
            const body: any = {
                summary: need("summary"), description: a.description, location: a.location,
                start: when(need("startTime"), !!a.allDay, tz), end: when(need("endTime"), !!a.allDay, tz),
                ...(Array.isArray(a.attendeeEmails) && a.attendeeEmails.length ? { attendees: a.attendeeEmails.map((email: string) => ({ email })) } : {}),
                ...(Array.isArray(a.recurrenceData) && a.recurrenceData.length ? { recurrence: a.recurrenceData } : {}),
                ...(a.addGoogleMeetUrl ? { conferenceData: { createRequest: { requestId: `gep-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
            };
            return eventView(await go("POST", `/calendars/${cal}/events${qs({ sendUpdates: send, conferenceDataVersion: a.addGoogleMeetUrl ? 1 : undefined })}`, body));
        }
        case "update_event": {
            const id = enc(need("eventId"));
            const body: any = {};
            for (const k of ["summary", "description", "location"]) if (a[k] !== undefined) body[k] = a[k];
            if (a.startTime || a.endTime) {
                const tz = await zone();
                if (a.startTime) body.start = when(a.startTime, !!a.allDay, tz);
                if (a.endTime) body.end = when(a.endTime, !!a.allDay, tz);
            }
            const add: string[] = a.addedAttendeeEmails || [], drop: string[] = (a.removedAttendeeEmails || []).map((x: string) => x.toLowerCase());
            if (add.length || drop.length) {
                const cur = await go("GET", `/calendars/${cal}/events/${id}`);
                const kept = (cur.attendees || []).filter((x: any) => !drop.includes(String(x.email).toLowerCase()));
                body.attendees = [...kept, ...add.filter(e => !kept.some((x: any) => String(x.email).toLowerCase() === e.toLowerCase())).map(email => ({ email }))];
            }
            if (a.addGoogleMeetUrl) body.conferenceData = { createRequest: { requestId: `gep-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } } };
            return eventView(await go("PATCH", `/calendars/${cal}/events/${id}${qs({ sendUpdates: send, conferenceDataVersion: a.addGoogleMeetUrl ? 1 : undefined })}`, body));
        }
        case "delete_event": await go("DELETE", `/calendars/${cal}/events/${enc(need("eventId"))}${qs({ sendUpdates: send })}`); return { ok: true, deleted: a.eventId };
        case "respond_to_event": {
            const id = enc(need("eventId"));
            const status = String(a.responseStatus || "").toLowerCase();
            if (!["accepted", "declined", "tentative"].includes(status)) throw new GoogleError(400, "responseStatus must be accepted, declined or tentative");
            const cur = await go("GET", `/calendars/${cal}/events/${id}`);
            const attendees = cur.attendees || [];
            const me = attendees.find((x: any) => x.self);
            if (!me) throw new GoogleError(400, "you are not on this event's guest list, so there is nothing to answer");
            me.responseStatus = status;
            if (a.responseComment) me.comment = String(a.responseComment);
            return eventView(await go("PATCH", `/calendars/${cal}/events/${id}${qs({ sendUpdates: send })}`, { attendees }));
        }
    }
    throw new GoogleError(400, `unknown tool: ${name}`);
}

export async function callTool(service: Service, name: string, args: any, token: string, fetchImpl: Fetch = fetch): Promise<any> {
    if (!TOOLS[service].some(t => t.name === name)) throw new GoogleError(400, `unknown tool: ${name}`);
    return service === "gmail" ? gmailTool(name, args || {}, token, fetchImpl) : calendarTool(name, args || {}, token, fetchImpl);
}

// --- The MCP endpoint -----------------------------------------------------------

const PROTOCOL_VERSION = "2025-06-18";
const rpc = (id: any, result: any) => ({ jsonrpc: "2.0", id, result });

/** One JSON-RPC request. Returns [HTTP status, body] — body null for a notification. */
export async function handle(service: Service, authorization: string, body: any, fetchImpl: Fetch = fetch): Promise<[number, any]> {
    const id = body?.id ?? null;
    const method = String(body?.method || "");
    const token = /^Bearer\s+/i.test(authorization) ? authorization.replace(/^Bearer\s+/i, "").trim() : "";
    if (!token) return [401, { jsonrpc: "2.0", id, error: { code: -32001, message: "a Google access token is required" } }];
    if (method === "initialize") return [200, rpc(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: `gepetel-google-${service}`, version: "1" } })];
    if (method.startsWith("notifications/")) return [202, null];
    if (method === "tools/list") return [200, rpc(id, { tools: TOOLS[service] })];
    if (method === "tools/call") {
        const name = String(body?.params?.name || "");
        try {
            const out = await callTool(service, name, body?.params?.arguments || {}, token, fetchImpl);
            return [200, rpc(id, { content: [{ type: "text", text: JSON.stringify(out) }] })];
        } catch (e: any) {
            // A login Google refuses is the connection's failure (401), so the
            // hosted call reports it and the login is refreshed; anything else
            // is the tool's answer, for the model to read.
            if (e?.status === 401) return [401, { jsonrpc: "2.0", id, error: { code: -32001, message: String(e.message) } }];
            console.error(`[google-rest] ${service}.${name}: ${String(e?.message || e).slice(0, 300)}`);
            return [200, rpc(id, { content: [{ type: "text", text: String(e?.message || e) }], isError: true })];
        }
    }
    if (method === "ping") return [200, rpc(id, {})];
    return [200, { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } }];
}

export default { serviceOf, isGoogleMcpHost, proxyUrl, routeHere, routedHere, rerouted, mcpRefuses, restWorks, callTool, handle, TOOLS, bodyText, messageView, when };
