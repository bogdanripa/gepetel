// Signed links to a group's settings page.
//
// There are no accounts. The 1:1 chat is the login: Gepetel only hands a link to
// someone the database says is in that group, and the link itself carries the
// group id plus an expiry, signed with a server secret. The page sends the token
// back on every read and write, and the backend trusts nothing else.
//
// The token format is <base64url payload>.<base64url hmac>. Pure functions take
// the secret and the clock as arguments so they can be unit-tested; the two
// wrappers at the bottom read the environment.
import crypto from "node:crypto";
import { publicBaseUrl } from "./util.js";

export const SETTINGS_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // a week: long enough to keep, short enough to leak

export type TokenCheck =
    | { ok: true; chatId: string }
    | { ok: false; reason: "no-secret" | "malformed" | "bad-signature" | "expired" };

function hmac(payload: string, secret: string): string {
    return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signSettingsToken(chatId: string, secret: string, now: number = Date.now(), ttlMs: number = SETTINGS_LINK_TTL_MS): string {
    if (!secret) throw new Error("settings link secret is not set");
    const payload = Buffer.from(JSON.stringify({ c: chatId, e: now + ttlMs })).toString("base64url");
    return `${payload}.${hmac(payload, secret)}`;
}

export function verifySettingsToken(token: unknown, secret: string, now: number = Date.now()): TokenCheck {
    if (!secret) return { ok: false, reason: "no-secret" };
    if (typeof token !== "string") return { ok: false, reason: "malformed" };
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
    const [payload, sig] = parts;
    const expected = hmac(payload, secret);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad-signature" };
    let parsed: any;
    try { parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return { ok: false, reason: "malformed" }; }
    if (!parsed || typeof parsed.c !== "string" || typeof parsed.e !== "number") return { ok: false, reason: "malformed" };
    if (parsed.e < now) return { ok: false, reason: "expired" };
    return { ok: true, chatId: parsed.c };
}

// A dedicated secret, falling back to the one that seals connector credentials
// so a deployment that already has that set needs nothing new.
export function secretFromEnv(): string {
    return String(process.env.SETTINGS_LINK_SECRET || process.env.MCP_SECRET_KEY || "").trim();
}

// The full URL to hand someone, or null when no secret is configured — a link
// that can never be verified is worse than none.
export function settingsLinkFor(chatId: string): string | null {
    const secret = secretFromEnv();
    if (!secret) {
        console.error("SETTINGS_LINK_SECRET / MCP_SECRET_KEY not set — cannot issue a settings link.");
        return null;
    }
    // ".html" spelled out: the static host has no clean-URL rule (see pay.html).
    return `${publicBaseUrl()}/settings.html?t=${encodeURIComponent(signSettingsToken(chatId, secret))}`;
}

export function verifyFromEnv(token: unknown): TokenCheck {
    return verifySettingsToken(token, secretFromEnv());
}

export default { signSettingsToken, verifySettingsToken, secretFromEnv, settingsLinkFor, verifyFromEnv, SETTINGS_LINK_TTL_MS };
