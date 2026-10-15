// What the two one-time links (takeover.ts: the live tab; signin.ts: the
// password form) have in common: how a token is made, kept and checked, and
// the headers their pages go out with. Kept in one place so the two don't
// drift apart — they had already, by a header (2026-10-15).
import crypto from "node:crypto";
import type { Response } from "express";

/** 32 random bytes; only the hash is ever kept. */
export function newToken(): { token: string; hash: string } {
    const token = crypto.randomBytes(32).toString("base64url");
    return { token, hash: hashToken(token) };
}

export const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

/** A string that could be one of our tokens at all — checked before any lookup. */
export const tokenShaped = (t: string) => /^[A-Za-z0-9_-]{40,60}$/.test(t);

/** Not cached, not framed, no referrer, nothing loaded from anywhere; the
 *  page may talk only to its own address. `images`: frames come as data: URLs. */
export function linkHeaders(res: Response, opts: { images?: boolean } = {}): void {
    res.set({
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": `default-src 'none'; ${opts.images ? "img-src data:; " : ""}style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    });
}

export default { newToken, hashToken, tokenShaped, linkHeaders };
