// Storage for Gepetel's OWN MCP server — the one a person points Claude Code at.
//
// Everything here is about one question: which WhatsApp account is holding this
// token? Gepetel already decides what someone may do from their chat (which
// groups they can post to, whose reminders they can touch), and the MCP tools
// reuse those same checks with the same TaskContext. So this file does not
// decide permissions at all. It only has to be sure of the person, and then
// hand their chat id to code that was already careful.
//
// Proof of identity is possession of the WhatsApp account: a six-digit code is
// sent to the number IN WHATSAPP and typed back into the browser. That is the
// whole reason the flow is worth having — nobody can add this server for
// someone else's number without holding their phone.
import mongoose from "mongoose";
import crypto from "node:crypto";
import { hashSecret, sameSecret, newToken, newPairingCode } from "../device/store.js";

/** How long a login-in-progress lives: entering a phone, getting a code in
 *  WhatsApp, typing it back. Generous for someone whose phone is in another
 *  room, short enough that an abandoned one is gone before it matters. */
const LOGIN_TTL_S = 15 * 60;
/** An authorization code is exchanged within seconds by the client that asked
 *  for it. Ten minutes is already luxurious; it also dies on first use. */
const AUTH_CODE_TTL_S = 10 * 60;
/** Access tokens expire; refresh tokens do the carrying. An hour means a stolen
 *  access token is worth little, and the client refreshes without the person. */
export const ACCESS_TTL_MS = 60 * 60 * 1000;
/** Wrong codes allowed before this login is dead. The code is six digits, so
 *  guessing is a real attack if you let it run. */
export const MAX_CODE_ATTEMPTS = 5;

// A client app that registered itself (RFC 7591). Claude Code registers once
// per machine and keeps its client_id; there is no secret, because a desktop
// client cannot keep one — PKCE is what makes that safe.
const clientSchema = new mongoose.Schema({
    client_id: { type: String, required: true, unique: true },
    client_name: { type: String, default: "" },
    redirect_uris: { type: [String], default: [] },
    created_at: { type: Date, default: Date.now },
});

// A login in progress, in a browser tab. Holds the OAuth request until the
// person has proved the number is theirs.
const loginSchema = new mongoose.Schema({
    login_id: { type: String, required: true, unique: true },
    client_id: { type: String, required: true },
    redirect_uri: { type: String, required: true },
    state: { type: String, default: "" },
    code_challenge: { type: String, required: true },
    // Set once they have entered a number and the code has gone out. Stored as
    // digits; the code itself is only ever kept as a hash.
    phone: { type: String, default: "" },
    code_hash: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    created_at: { type: Date, default: Date.now, expires: LOGIN_TTL_S },
});

// Issued once the number is proved, exchanged once for tokens.
const authCodeSchema = new mongoose.Schema({
    code_hash: { type: String, required: true, unique: true },
    client_id: { type: String, required: true },
    chat_id: { type: String, required: true },
    redirect_uri: { type: String, required: true },
    code_challenge: { type: String, required: true },
    used: { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now, expires: AUTH_CODE_TTL_S },
});

// Tokens are kept as hashes for the same reason passwords are: whoever reads
// this collection should not come away able to act as anybody.
const tokenSchema = new mongoose.Schema({
    access_hash: { type: String, required: true, unique: true },
    refresh_hash: { type: String, required: true, index: true },
    client_id: { type: String, required: true },
    chat_id: { type: String, required: true, index: true },
    expires_at: { type: Date, required: true },
    revoked: { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now },
});

const Client = mongoose.models.UserMcpClient || mongoose.model("UserMcpClient", clientSchema);
const Login = mongoose.models.UserMcpLogin || mongoose.model("UserMcpLogin", loginSchema);
const AuthCode = mongoose.models.UserMcpAuthCode || mongoose.model("UserMcpAuthCode", authCodeSchema);
const Token = mongoose.models.UserMcpToken || mongoose.model("UserMcpToken", tokenSchema);

export type ClientRow = { client_id: string; client_name: string; redirect_uris: string[] };
export type LoginRow = {
    login_id: string; client_id: string; redirect_uri: string; state: string;
    code_challenge: string; phone: string; attempts: number;
};

// ─── clients ────────────────────────────────────────────────────────────────

export async function registerClient(input: { client_name?: string; redirect_uris: string[] }): Promise<ClientRow> {
    const client_id = crypto.randomBytes(16).toString("hex");
    const row = await Client.create({
        client_id,
        client_name: String(input.client_name || "").slice(0, 120),
        redirect_uris: input.redirect_uris.map(String).slice(0, 10),
    });
    return { client_id: row.client_id, client_name: row.client_name, redirect_uris: row.redirect_uris };
}

export async function getClient(client_id: string): Promise<ClientRow | null> {
    const row: any = await Client.findOne({ client_id: String(client_id || "") }).lean();
    if (!row) return null;
    return { client_id: row.client_id, client_name: row.client_name || "", redirect_uris: row.redirect_uris || [] };
}

// ─── the login in the browser ───────────────────────────────────────────────

export async function startLogin(input: {
    client_id: string; redirect_uri: string; state: string; code_challenge: string;
}): Promise<string> {
    const login_id = newToken();
    await Login.create({
        login_id, client_id: input.client_id, redirect_uri: input.redirect_uri,
        state: String(input.state || ""), code_challenge: input.code_challenge,
    });
    return login_id;
}

export async function getLogin(login_id: string): Promise<LoginRow | null> {
    const row: any = await Login.findOne({ login_id: String(login_id || "") }).lean();
    if (!row) return null;
    return {
        login_id: row.login_id, client_id: row.client_id, redirect_uri: row.redirect_uri,
        state: row.state || "", code_challenge: row.code_challenge, phone: row.phone || "",
        attempts: row.attempts || 0,
    };
}

/** Record the number and the code we just sent to it. Replacing any previous
 *  one: asking again is how someone recovers from a code that never arrived,
 *  and two live codes for one login would double the guessing surface. */
export async function putLoginCode(login_id: string, phone: string, code: string): Promise<void> {
    await Login.updateOne(
        { login_id },
        { $set: { phone: String(phone), code_hash: hashSecret(code), attempts: 0 } },
    );
}

/** True when the code matches. A wrong one is counted, and the login dies once
 *  the count is spent — six digits is not enough entropy to let someone keep
 *  trying. */
export async function checkLoginCode(login_id: string, code: string): Promise<{ ok: boolean; dead: boolean }> {
    const row: any = await Login.findOne({ login_id }).lean();
    if (!row || !row.code_hash) return { ok: false, dead: true };
    if ((row.attempts || 0) >= MAX_CODE_ATTEMPTS) return { ok: false, dead: true };
    if (sameSecret(hashSecret(String(code || "")), row.code_hash)) return { ok: true, dead: false };
    const after = await Login.findOneAndUpdate({ login_id }, { $inc: { attempts: 1 } }, { new: true });
    return { ok: false, dead: (after?.attempts || 0) >= MAX_CODE_ATTEMPTS };
}

export async function dropLogin(login_id: string): Promise<void> {
    await Login.deleteOne({ login_id });
}

// ─── authorization codes ────────────────────────────────────────────────────

/** Returns the code itself, once. Only its hash is stored. */
export async function issueAuthCode(input: {
    client_id: string; chat_id: string; redirect_uri: string; code_challenge: string;
}): Promise<string> {
    const code = newToken();
    await AuthCode.create({
        code_hash: hashSecret(code), client_id: input.client_id, chat_id: input.chat_id,
        redirect_uri: input.redirect_uri, code_challenge: input.code_challenge,
    });
    return code;
}

/** Exchange a code for the person it belongs to, or null.
 *
 *  Everything is checked together because each piece alone is not enough: the
 *  code could have leaked from a log or a redirect, so PKCE proves the holder
 *  is the client that started the flow; the client_id and redirect_uri stop a
 *  code being replayed through a different app. The row is marked used first,
 *  so two simultaneous exchanges cannot both win. */
export async function consumeAuthCode(code: string, input: {
    client_id: string; redirect_uri: string; code_verifier: string;
}): Promise<{ chat_id: string } | null> {
    const claimed: any = await AuthCode.findOneAndUpdate(
        { code_hash: hashSecret(String(code || "")), used: false },
        { $set: { used: true } },
    ).lean();
    if (!claimed) return null;
    if (claimed.client_id !== input.client_id) return null;
    if (claimed.redirect_uri !== input.redirect_uri) return null;
    if (!verifyPkce(String(input.code_verifier || ""), claimed.code_challenge)) return null;
    return { chat_id: claimed.chat_id };
}

/** S256 only. The plain method exists in the spec and is worth nothing: it
 *  proves the holder read the challenge, which anyone who saw the request did. */
export function verifyPkce(verifier: string, challenge: string): boolean {
    if (!verifier || !challenge) return false;
    // RFC 7636: 43–128 characters of unreserved alphabet. A short verifier is
    // not a typo to be forgiven, it is a weak proof.
    if (verifier.length < 43 || verifier.length > 128) return false;
    if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;
    const computed = crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
    return sameSecret(computed, String(challenge));
}

// ─── tokens ─────────────────────────────────────────────────────────────────

export async function issueTokens(input: { client_id: string; chat_id: string }): Promise<{
    access_token: string; refresh_token: string; expires_in: number;
}> {
    const access_token = newToken();
    const refresh_token = newToken();
    await Token.create({
        access_hash: hashSecret(access_token), refresh_hash: hashSecret(refresh_token),
        client_id: input.client_id, chat_id: input.chat_id,
        expires_at: new Date(Date.now() + ACCESS_TTL_MS),
    });
    return { access_token, refresh_token, expires_in: Math.floor(ACCESS_TTL_MS / 1000) };
}

/** Whose token is this? Null for unknown, expired or revoked. */
export async function tokenOwner(access_token: string): Promise<{ chat_id: string; client_id: string } | null> {
    const t = String(access_token || "");
    if (!t) return null;
    const row: any = await Token.findOne({ access_hash: hashSecret(t), revoked: false }).lean();
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    return { chat_id: row.chat_id, client_id: row.client_id };
}

/** Rotate on refresh: the old pair is revoked as the new one is issued, so a
 *  stolen refresh token stops working the moment the real client uses theirs
 *  (and vice versa, which is the signal that something is wrong). */
export async function refreshTokens(refresh_token: string, client_id: string): Promise<{
    access_token: string; refresh_token: string; expires_in: number;
} | null> {
    const row: any = await Token.findOneAndUpdate(
        { refresh_hash: hashSecret(String(refresh_token || "")), revoked: false, client_id },
        { $set: { revoked: true } },
    ).lean();
    if (!row) return null;
    return issueTokens({ client_id: row.client_id, chat_id: row.chat_id });
}

/** Everything this person has handed out, for when they want it all gone. */
export async function revokeAllFor(chat_id: string): Promise<number> {
    const r = await Token.updateMany({ chat_id, revoked: false }, { $set: { revoked: true } });
    return r.modifiedCount || 0;
}

export { newPairingCode as newLoginCode };
export default {
    registerClient, getClient,
    startLogin, getLogin, putLoginCode, checkLoginCode, dropLogin,
    issueAuthCode, consumeAuthCode, verifyPkce,
    issueTokens, tokenOwner, refreshTokens, revokeAllFor,
    newLoginCode: newPairingCode,
    ACCESS_TTL_MS, MAX_CODE_ATTEMPTS,
};
