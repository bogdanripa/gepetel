// Sending mail — the one thing the Gmail connector cannot do.
//
// Google's hosted Gmail MCP server offers 23 tools and they stop at drafts:
// create_draft, list_drafts, get_draft, and no send, reply or forward at any
// scope (probed live against the server, not inferred). So "reply to him and
// say yes" ended with a draft sitting in a mailbox and a person being told to
// go and press the button themselves.
//
// This calls the Gmail API directly, with the token that same connector already
// holds. No new scope: gmail.modify — which is what the app requests, and what
// is submitted for verification — is one of the scopes users.messages.send
// accepts, alongside gmail.send and gmail.compose. Nothing here needs more
// access than reading and labelling already did.
import axios from "axios";
import m from "./mongo.js";
import mcp from "./mcp.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** A header value that cannot break out of its header.
 *
 *  Subject and recipients arrive from a model, which means ultimately from
 *  whatever someone wrote in a chat. A newline in any of them would start a new
 *  header, and the header after "To:" that an attacker would choose is "Bcc:".
 *  Nothing is escaped here — the characters that could do it are simply not
 *  allowed through. */
function headerSafe(value: unknown, max = 500): string {
    return String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

/** RFC 2047 for anything that is not plain ASCII, so "Întâlnire mâine" does not
 *  arrive as mojibake in someone's inbox. */
function encodeHeaderWord(value: string): string {
    if (!/[^\x20-\x7E]/.test(value)) return value;
    return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export type MailInput = {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    /** Set when this is a reply: the thread it belongs to and what it answers. */
    inReplyTo?: string;
    references?: string;
    /** Files that go with it: a proof of payment, a photo they sent. */
    attachments?: MailFile[];
};

export type MailFile = { filename: string; mimetype: string; data: Buffer };

/** The message itself, as RFC 2822 text. Kept pure and exported because this is
 *  the part worth testing: everything else is one HTTP call. */
export function buildMime(input: MailInput): string {
    const to = headerSafe(input.to);
    const cc = headerSafe(input.cc || "");
    const subject = encodeHeaderWord(headerSafe(input.subject, 300));
    // The body is base64'd, so it cannot inject anything and does not need
    // line-ending surgery; UTF-8 is declared rather than hoped for.
    const body = Buffer.from(String(input.body ?? ""), "utf8").toString("base64");
    const files = (input.attachments || []).filter(f => f && f.data && f.data.length);
    const top = [
        `To: ${to}`,
        cc ? `Cc: ${cc}` : "",
        `Subject: ${subject}`,
        "MIME-Version: 1.0",
        input.inReplyTo ? `In-Reply-To: ${headerSafe(input.inReplyTo)}` : "",
        input.references ? `References: ${headerSafe(input.references)}` : "",
    ].filter(Boolean);
    const text = ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64"];
    // CRLF between headers, a blank line, then the body: the wire format, not
    // whatever the platform's newline happens to be.
    if (!files.length) return `${[...top, ...text].join("\r\n")}\r\n\r\n${body}`;
    // With files: the text, then each file, between boundaries. A file's name
    // and type are ours to write, never the file's own bytes: both go through
    // headerSafe, and the bytes are base64 in lines of 76.
    const boundary = `gepetel_${Buffer.from(`${to}|${body.length}|${files.map(f => f.data.length).join(",")}`).toString("hex").slice(0, 24)}_${files.length}`;
    const wrap = (b64: string) => (b64.match(/.{1,76}/g) || []).join("\r\n");
    const parts = [
        `--${boundary}\r\n${text.join("\r\n")}\r\n\r\n${wrap(body)}`,
        ...files.map(f => {
            const name = headerSafe(f.filename, 120).replace(/["\\\/]/g, "_") || "file";
            const type = /^[\w.+-]+\/[\w.+-]+$/.test(f.mimetype) ? f.mimetype : "application/octet-stream";
            return `--${boundary}\r\nContent-Type: ${type}; name="${encodeHeaderWord(name)}"\r\nContent-Disposition: attachment; filename="${encodeHeaderWord(name)}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(f.data.toString("base64"))}`;
        }),
    ];
    return `${[...top, `Content-Type: multipart/mixed; boundary="${boundary}"`].join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n--${boundary}--\r\n`;
}

const rawFor = (mime: string) => Buffer.from(mime, "utf8").toString("base64url");

/** A usable access token for this chat's Gmail connector, refreshed if it has
 *  expired. Returns null when they have not connected Gmail, which the caller
 *  turns into "connect it first" rather than an error. */
/** The address inside "Gmail (ana@firma.ro)", or the label itself. */
export function mailboxOf(label: unknown): string {
    const m = /\(([^)]+)\)\s*$/.exec(String(label || ""));
    return (m ? m[1] : String(label || "")).trim();
}

export type GmailPick = { ok: true; connector: any } | { ok: false; reason: string };

/** Which mailbox to send from.
 *
 *  Two Gmail accounts in one chat is a case the prompt invites ("add my work
 *  Gmail too"), and the old code took whichever came back first. A send from
 *  the wrong address is not a small thing: it is the wrong name on a message
 *  to someone else, and nobody finds out until the reply comes back. So when
 *  it is ambiguous this refuses and says what to choose between, rather than
 *  picking. Kept pure so the choosing is testable. */
/** Is this connection a mailbox? By its server, or a label that IS Gmail's —
 *  not one that merely mentions it: "Google Calendar (ana@gmail.com)" has
 *  "gmail" in its address, and was counted as a second mailbox. With the
 *  owner's calendar connected under his gmail.com address, "send it from my
 *  personal one" matched two connections and he was asked "the first or the
 *  second?" three times running (2026-11-24). */
export function isGmailConnector(c: any): boolean {
    return /gmailmcp\.googleapis\.com/i.test(String(c?.server_url || "")) || /^\s*gmail\b/i.test(String(c?.label || ""));
}

/** The connected mailboxes, in the order they were connected. */
export function gmailsOf(connectors: any[]): any[] {
    return (connectors || []).filter(isGmailConnector);
}

export function pickGmail(connectors: any[], account?: string): GmailPick {
    const gmails = gmailsOf(connectors);
    if (!gmails.length) return { ok: false, reason: "no Gmail connected in this chat" };

    const hint = String(account || "").trim().toLowerCase();
    const list = () => gmails.map(c => mailboxOf(c.label)).join(" / ");
    if (!hint) {
        return gmails.length === 1
            ? { ok: true, connector: gmails[0] }
            : { ok: false, reason: `two mailboxes are connected here (${list()}) — ask which one it goes from` };
    }

    // By address or by a word of the label — or by the tool label the model
    // sees for it ("gmail_ana_firma_ro"), which is the same text with its
    // punctuation flattened.
    const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const hits = gmails.filter(c => { const l = String(c.label || "").toLowerCase(); return l.includes(hint) || (flat(hint).length > 3 && flat(l).includes(flat(hint))); });
    if (hits.length === 1) return { ok: true, connector: hits[0] };
    if (hits.length > 1) return { ok: false, reason: `"${account}" matches more than one of ${list()} — ask which` };
    return { ok: false, reason: `no mailbox here matches "${account}" — what is connected is ${list()}` };
}

async function gmailToken(chatId: string, account?: string): Promise<{ token: string; connector: any } | { token: null; reason: string }> {
    const connectors = await m.getMcpConnectorsForGroup(chatId);
    const picked = pickGmail(connectors, account);
    if (!picked.ok) return { token: null, reason: picked.reason };
    return tokenOf(chatId, picked.connector);
}

/** A mailbox's token, refreshed when it is about to lapse. */
async function tokenOf(chatId: string, gmail: any): Promise<{ token: string; connector: any } | { token: null; reason: string }> {
    if (!gmail.oauth?.access_token) return { token: null, reason: "my Gmail login has lapsed — reconnect Gmail" };
    const o: any = gmail.oauth;
    const expiring = o.expires_at && o.expires_at < Date.now() + 60_000;
    if (!expiring || !o.refresh_token) return { token: o.access_token, connector: gmail };
    try {
        const fresh = await mcp.refreshTokens(o.token_endpoint, { client_id: o.client_id, client_secret: o.client_secret }, o.refresh_token, o.resource);
        await m.updateMcpOAuthTokens(gmail.connector_id, fresh);
        return { token: fresh.access_token, connector: gmail };
    } catch (e) {
        console.error(`gmail token refresh for ${chatId} failed:`, e);
        return { token: o.access_token, connector: gmail };   // try the old one; a 401 is a clearer error than a silent nothing
    }
}

/** What a reply has to quote: who it goes to, what it answers, and which
 *  thread it belongs to. Read from Gmail rather than from the model, so a reply
 *  cannot be aimed somewhere the original never was. */
async function replyContext(token: string, messageId: string): Promise<{
    to: string; subject: string; inReplyTo: string; references: string; threadId: string;
}> {
    const { data } = await axios.get(`${GMAIL_API}/messages/${encodeURIComponent(messageId)}`, {
        params: { format: "metadata", metadataHeaders: ["Message-ID", "Subject", "From", "References", "Reply-To"] },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 20_000,
    });
    const headers: any[] = data?.payload?.headers || [];
    const pick = (name: string) => String(headers.find(h => String(h.name).toLowerCase() === name.toLowerCase())?.value || "");
    const messageHeader = pick("Message-ID");
    const subject = pick("Subject");
    return {
        // Reply-To wins over From when the sender asked for it, which is the
        // whole point of that header.
        to: pick("Reply-To") || pick("From"),
        subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
        inReplyTo: messageHeader,
        references: [pick("References"), messageHeader].filter(Boolean).join(" "),
        threadId: String(data?.threadId || ""),
    };
}

export type SendResult = { sent: true; to: string; subject: string; id: string; from: string } | { sent: false; reason: string };

/** Why it did not go, in words worth putting in a chat.
 *
 *  Gmail's own refusals are written for whoever runs the Cloud project, not
 *  for the person waiting on their phone: "Gmail API has not been used in
 *  project 168374214147 before or it is disabled" is true and useless. The
 *  detail still goes to the log; this is what the person hears. Anything
 *  unrecognised is passed through rather than smoothed over — a vague "it
 *  didn't work" is worse than Google's own wording. */
function humanFailure(detail: string): string {
    const d = String(detail || "");
    if (/has not been used in project|accessNotConfigured|API .* is disabled/i.test(d))
        return "sending from Gmail is not switched on on my side yet — Bogdan has to flip it, I cannot";
    if (/insufficient (authentication|permission)|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i.test(d))
        return "my Gmail login does not cover sending — reconnect Gmail and I will have it";
    if (/invalid_grant|invalid credentials|unauthorized|401/i.test(d))
        return "my Gmail login has lapsed — reconnect Gmail";
    if (/rate ?limit|quota|429|user-rate/i.test(d))
        return "Gmail is rate-limiting me right now; worth another go in a minute";
    if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|socket hang up|timeout/i.test(d))
        return "I could not reach Gmail just now";
    return d.slice(0, 300);
}

/** Send a new message. */
export async function sendEmail(chatId: string, input: { to: string; subject: string; body: string; cc?: string; account?: string; attachments?: MailFile[] }): Promise<SendResult> {
    const auth = await gmailToken(chatId, input.account);
    if (auth.token === null) return { sent: false, reason: auth.reason };
    const token = auth.token;
    const to = headerSafe(input.to);
    if (!to || !/@/.test(to)) return { sent: false, reason: "no recipient address" };
    if (!String(input.body || "").trim()) return { sent: false, reason: "the message is empty" };
    const mime = buildMime({ to, cc: input.cc, subject: input.subject, body: input.body, attachments: input.attachments });
    try {
        const { data } = await axios.post(`${GMAIL_API}/messages/send`, { raw: rawFor(mime) },
            { headers: { Authorization: `Bearer ${token}` }, timeout: 25_000 });
        return { sent: true, to, subject: headerSafe(input.subject, 300), id: String(data?.id || ""), from: mailboxOf(auth.connector?.label) };
    } catch (e: any) {
        const detail = e?.response?.data?.error?.message || e?.message || String(e);
        console.error(`gmail send for ${chatId} failed:`, detail);
        return { sent: false, reason: humanFailure(detail) };
    }
}

/** Reply to a message, on its own thread. */
/** Which mailbox a reply leaves from: the one the message is IN. With two
 *  mailboxes connected nobody should be asked — a message id exists in one
 *  account only, and a reply from any other would not be a reply. `order`
 *  puts the one that was named first. Kept apart from the network so the
 *  choosing is testable: `has` says whether a mailbox holds the message. */
export async function mailboxHolding<T>(gmails: any[], named: any | null, has: (connector: any) => Promise<T | null>): Promise<{ connector: any; found: T } | null> {
    const order = named ? [named, ...gmails.filter(g => g !== named)] : gmails;
    for (const g of order) {
        const found = await has(g).catch(() => null);
        if (found) return { connector: g, found };
    }
    return null;
}

export async function replyToEmail(chatId: string, input: { message_id: string; body: string; account?: string; attachments?: MailFile[] }): Promise<SendResult> {
    if (!String(input.body || "").trim()) return { sent: false, reason: "the reply is empty" };
    const connectors = await m.getMcpConnectorsForGroup(chatId);
    const gmails = gmailsOf(connectors);
    if (!gmails.length) return { sent: false, reason: "no Gmail connected in this chat" };
    const picked = pickGmail(connectors, input.account);
    type Ctx = Awaited<ReturnType<typeof replyContext>>;
    let lapsed = "";
    const held = await mailboxHolding<{ token: string; ctx: Ctx }>(gmails, picked.ok ? picked.connector : null, async g => {
        const a = await tokenOf(chatId, g);
        if (a.token === null) { lapsed = a.reason; return null; }
        const ctx = await replyContext(a.token, String(input.message_id || ""));
        return { token: a.token, ctx };
    });
    if (!held) return { sent: false, reason: lapsed || "that message is not in any mailbox connected here — find it again with the Gmail connector and use its id" };
    const auth = { connector: held.connector };
    const token = held.found.token;
    try {
        const ctx = held.found.ctx;
        if (!ctx.to) return { sent: false, reason: "could not tell who that message was from" };
        const mime = buildMime({
            to: ctx.to, subject: ctx.subject, body: input.body,
            inReplyTo: ctx.inReplyTo, references: ctx.references, attachments: input.attachments,
        });
        // threadId keeps it in the conversation rather than starting a new one.
        const { data } = await axios.post(`${GMAIL_API}/messages/send`,
            { raw: rawFor(mime), threadId: ctx.threadId || undefined },
            { headers: { Authorization: `Bearer ${token}` }, timeout: 25_000 });
        return { sent: true, to: ctx.to, subject: ctx.subject, id: String(data?.id || ""), from: mailboxOf(auth.connector?.label) };
    } catch (e: any) {
        const detail = e?.response?.data?.error?.message || e?.message || String(e);
        console.error(`gmail reply for ${chatId} failed:`, detail);
        return { sent: false, reason: humanFailure(detail) };
    }
}

export default { buildMime, sendEmail, replyToEmail, humanFailure, pickGmail, mailboxOf, isGmailConnector, gmailsOf, mailboxHolding };
