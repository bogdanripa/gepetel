// An email's attachments, fetched for the person and sent to them on WhatsApp.
//
// Google's Gmail MCP server reads mail as text and has no tool for an
// attachment (2026-11-09: 23 tools, none of them a file), so "send me the
// slides from Andrei's email" went to their computer's browser instead. The
// connector's own sign-in reaches the Gmail API, so the file is fetched here,
// with that token, and never passes through a model.
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const MAX_BYTES = 15 * 1024 * 1024;   // one file; base64 must fit the gateway's 25 MB body
const MAX_FILES = 5;

export type Attachment = { filename: string; mimetype: string; data: Buffer };
export type Found = { files: Attachment[]; skipped: string[]; error?: string };

/** Is this connector Google's Gmail server? */
export function isGmailServer(serverUrl: string): boolean {
    try { return new URL(serverUrl).hostname === "gmailmcp.googleapis.com"; } catch { return false; }
}

// Every part of a message that is a file, depth first.
export function attachmentParts(payload: any): { filename: string; mimetype: string; attachmentId?: string; data?: string; size: number }[] {
    const out: any[] = [];
    const walk = (p: any) => {
        if (!p) return;
        if (p.filename && (p.body?.attachmentId || p.body?.data)) {
            out.push({ filename: String(p.filename), mimetype: String(p.mimeType || "application/octet-stream"), attachmentId: p.body.attachmentId, data: p.body.data, size: Number(p.body.size || 0) });
        }
        for (const q of p.parts || []) walk(q);
    };
    walk(payload);
    return out;
}

/** Which of the files they meant: a name (any part of it, any case), or all of them. */
export function pick<T extends { filename: string }>(parts: T[], name: string): T[] {
    const want = name.trim().toLowerCase();
    if (!want) return parts;
    const exact = parts.filter(p => p.filename.toLowerCase() === want);
    if (exact.length) return exact;
    const words = want.split(/[\s._-]+/).filter(w => w.length > 2);
    return parts.filter(p => {
        const f = p.filename.toLowerCase();
        return f.includes(want) || (words.length > 0 && words.every(w => f.includes(w)));
    });
}

async function get(token: string, path: string, fetchImpl: typeof fetch): Promise<{ status: number; body: any }> {
    const r = await fetchImpl(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json().catch(() => ({})) };
}

function apiError(r: { status: number; body: any }): string {
    const reason = r.body?.error?.details?.find?.((d: any) => d?.reason)?.reason || r.body?.error?.status || "";
    if (reason === "SERVICE_DISABLED") return "service_disabled";
    if (r.status === 401) return "auth";
    if (r.status === 404) return "not_found";
    return `gmail ${r.status}${reason ? ` ${reason}` : ""}`;
}

/**
 * The files attached to a message, or to the newest message in a thread that
 * has them. `id` is either; `name` narrows to one file.
 */
export async function fetchAttachments(token: string, id: string, name = "", fetchImpl: typeof fetch = fetch): Promise<Found> {
    const safe = encodeURIComponent(id.trim());
    let messages: any[] = [];
    const asMessage = await get(token, `/messages/${safe}?format=full`, fetchImpl);
    if (asMessage.status === 200) messages = [asMessage.body];
    else {
        const asThread = await get(token, `/threads/${safe}?format=full`, fetchImpl);
        if (asThread.status !== 200) return { files: [], skipped: [], error: apiError(asThread.status === 404 ? asMessage : asThread) };
        messages = [...(asThread.body.messages || [])].reverse();   // newest first
    }
    for (const msg of messages) {
        const parts = pick(attachmentParts(msg.payload), name);
        if (!parts.length) continue;
        const files: Attachment[] = [], skipped: string[] = [];
        for (const p of parts.slice(0, MAX_FILES)) {
            if (p.size > MAX_BYTES) { skipped.push(`${p.filename} (too large to send on WhatsApp from here)`); continue; }
            let data = p.data;
            if (!data && p.attachmentId) {
                const a = await get(token, `/messages/${encodeURIComponent(msg.id)}/attachments/${encodeURIComponent(p.attachmentId)}`, fetchImpl);
                if (a.status !== 200) return { files, skipped, error: apiError(a) };
                data = a.body.data;
            }
            const buf = Buffer.from(String(data || ""), "base64url");
            if (buf.length > MAX_BYTES) { skipped.push(`${p.filename} (too large to send on WhatsApp from here)`); continue; }
            files.push({ filename: p.filename, mimetype: p.mimetype, data: buf });
        }
        for (const p of parts.slice(MAX_FILES)) skipped.push(`${p.filename} (more than ${MAX_FILES} at once)`);
        return { files, skipped };
    }
    return { files: [], skipped: [], error: name ? "no_such_file" : "no_attachments" };
}

export default { isGmailServer, attachmentParts, pick, fetchAttachments, MAX_BYTES };
