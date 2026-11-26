// When a connection's login stops being accepted, the person is told — once —
// with a link that signs it in again.
//
// Until now nobody was told. A login the provider refused was mentioned only
// if the person happened to ask for something that needed it; one the service
// itself stopped accepting (two of one person's Google connections, for a day,
// 2026-11-25, with tokens Google's own token check called valid) wasn't
// mentioned at all — it was just retried, slowly, on every reply, and their
// check-ins found nothing. The owner: "you should automatically prompt me to
// re-auth when a connection expires".
//
// Two things lead here:
//   - "lapsed": the provider refused to renew the login (mcpHealth.ts).
//   - "failing": the connection couldn't be reached twice in a row, minutes
//     apart, a renewed login in between. That alone could be the service
//     being down, and nobody can fix that by signing in — so the server is
//     asked directly, and only a refusal of the login (401/403) counts.
//
// The link (/r/<token>) is not a login link: those die in 20 minutes, and a
// message like this is read hours later. It starts the login when it is
// opened, and the new login takes the old connection's place and name.
//
// Free of I/O imports: everything it touches is handed in.

/** While it stays broken, how often they're reminded. */
export const REASK_MS = 3 * 24 * 3600_000;
/** How long a reconnect link opens. */
export const LINK_TTL_MS = 7 * 24 * 3600_000;
/** Not at night: it will still be broken in the morning. */
export const WAKING_FROM = 8, WAKING_UNTIL = 22;

export type ReauthConnector = {
    connector_id: string; chat_id: string; label: string; server_url: string;
    auth_kind: "headers" | "oauth" | "device"; added_by: string; headers: Record<string, string>;
};
export type Probe = "refused" | "answers" | "unclear";
export type ReauthDeps = {
    connector(chatId: string, serverLabel: string): Promise<ReauthConnector | null>;
    /** Ask the server directly, with the login as stored now. */
    probe(c: ReauthConnector): Promise<Probe>;
    /** The hour where the person is, 0–23. */
    localHour(chat: string): number;
    language(chat: string): Promise<string>;
    groupName(chatId: string): Promise<string>;
    /** True when this caller gets to tell them (once per connection per REASK_MS). */
    claim(connectorId: string, everyMs: number): Promise<boolean>;
    release(connectorId: string): Promise<void>;
    link(c: ReauthConnector): Promise<string>;
    say(chat: string, text: string): Promise<boolean>;
    log?(s: string): void;
};

/** True when the outcome means the login is what's wrong, whether or not they were told just now. */
export function loginIsTheProblem(o: Outcome): boolean { return o === "asked" || o === "asked already" || o === "night" || o === "not sent"; }

export type Outcome = "asked" | "no such connection" | "not a login" | "not a login problem" | "night" | "asked already" | "not sent" | "busy";

/** What they're sent. A key can't be renewed from a link: they're asked for a new one. */
export function reauthMessage(language: string, x: { label: string; link: string; group?: string; why: "lapsed" | "failing" }): string {
    if (language === "Romanian") {
        const what = x.group ? `Conexiunea ${x.label} din grupul „${x.group}”` : `Conexiunea ta ${x.label}`;
        const why = x.why === "lapsed" ? "autentificarea a expirat" : "serviciul nu-mi mai acceptă autentificarea";
        return x.link
            ? `${what} nu mai merge: ${why}. Până o refaci, nu văd nimic de acolo.\n\nO reconectezi de aici, durează un minut:\n${x.link}`
            : `${what} nu mai merge: ${why}. Până o refaci, nu văd nimic de acolo. Trimite-mi aici o cheie nouă și o pun la loc.`;
    }
    const what = x.group ? `The ${x.label} connection in the group "${x.group}"` : `Your ${x.label} connection`;
    const why = x.why === "lapsed" ? "its login has expired" : "the service no longer accepts my login";
    return x.link
        ? `${what} has stopped working: ${why}. Until it's signed in again I can't see anything there.\n\nReconnect it here, it takes a minute:\n${x.link}`
        : `${what} has stopped working: ${why}. Until it's redone I can't see anything there. Send me a new key here and I'll put it back.`;
}

/** Whose private chat hears about it: their own, or whoever connected it to the group. */
export function whoToTell(c: ReauthConnector): string {
    if (/@s\.whatsapp\.net$/.test(c.chat_id)) return c.chat_id;
    const digits = String(c.added_by || "").replace(/\D/g, "");
    return digits ? `${digits}@s.whatsapp.net` : "";
}

const inFlight = new Set<string>();

export async function askToReconnect(chatId: string, serverLabel: string, why: "lapsed" | "failing", deps: ReauthDeps): Promise<Outcome> {
    const key = `${chatId}|${serverLabel}`;
    if (inFlight.has(key)) return "busy";
    inFlight.add(key);
    try {
        const c = await deps.connector(chatId, serverLabel);
        if (!c) return "no such connection";
        // Their own computer goes offline and comes back by itself.
        if (c.auth_kind === "device" || /\/device\//.test(c.server_url)) return "not a login";
        const chat = whoToTell(c);
        if (!chat) return "no such connection";
        if (why === "failing" && await deps.probe(c) !== "refused") return "not a login problem";
        const hour = deps.localHour(chat);
        if (hour < WAKING_FROM || hour >= WAKING_UNTIL) return "night";
        if (!await deps.claim(c.connector_id, REASK_MS)) return "asked already";
        let sent = false;
        try {
            const link = c.auth_kind === "oauth" ? await deps.link(c) : "";
            const group = chat === c.chat_id ? "" : await deps.groupName(c.chat_id).catch(() => "");
            sent = await deps.say(chat, reauthMessage(await deps.language(chat), { label: c.label, link, group, why }));
        } finally {
            if (!sent) await deps.release(c.connector_id).catch(() => {});
        }
        (deps.log || console.log)(`[reauth] ${c.label} in …${chatId.split("@")[0].slice(-4)}: ${why} — ${sent ? "asked them to reconnect" : "could not tell them"}`);
        return sent ? "asked" : "not sent";
    } finally {
        inFlight.delete(key);
    }
}

export default { askToReconnect, reauthMessage, whoToTell, loginIsTheProblem, REASK_MS, LINK_TTL_MS, WAKING_FROM, WAKING_UNTIL };
