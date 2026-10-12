// Devices: a person's own computer, paired to their 1:1 chat.
//
// Two secrets live here and neither is ever recoverable:
//
//  - the **device token**, which the agent presents on every WebSocket dial;
//  - the **pairing code**, the six digits a person types once.
//
// Both are stored as SHA-256 hashes rather than sealed ciphertext. Sealing is for
// values we must read back (an OAuth token we have to replay to a provider); a
// secret we only ever *verify* is better off as a hash, because a database dump
// then yields nothing usable at all. The connector's bearer secret is the
// opposite case — OpenAI's servers must receive it — so that one stays sealed,
// in the connector row, through the existing machinery.
//
// Comparisons are constant-time. A six-digit code is only 20 bits, so it leans on
// the TTL, single use, and the per-source attempt lock below rather than on
// entropy.
import mongoose from "mongoose";
import crypto from "node:crypto";

const deviceSchema = new mongoose.Schema({
    device_id: { type: String, required: true, unique: true },
    // The 1:1 this computer belongs to. Every entry point re-checks it; a device
    // is never reachable from a group, or from anyone else's chat.
    chat_id: { type: String, required: true, index: true },
    connector_id: { type: String, default: "" },
    token_hash: { type: String, required: true, index: true },
    name: { type: String, default: "" },
    os: { type: String, default: "" },
    arch: { type: String, default: "" },
    agent_version: { type: String, default: "" },
    capabilities: { type: [String], default: [] },
    last_seen_at: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
});

const pairingCodeSchema = new mongoose.Schema({
    code_hash: { type: String, required: true, index: true },
    chat_id: { type: String, required: true, index: true },
    used_at: { type: Date, default: null },
    // Mongo removes the row on its own; the explicit expiry check below is what
    // the logic relies on, since the TTL monitor only runs every 60s.
    expires_at: { type: Date, required: true, expires: 0 },
    createdAt: { type: Date, default: Date.now },
});

const Device = mongoose.model("Device", deviceSchema);
const PairingCode = mongoose.model("PairingCode", pairingCodeSchema);

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const MAX_PAIR_ATTEMPTS = 5;
const ATTEMPT_LOCK_MS = 15 * 60 * 1000;

export function hashSecret(value: string): string {
    return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

/** Constant-time compare of two hex digests. Length differing is not secret. */
export function sameSecret(a: string, b: string): boolean {
    const x = Buffer.from(String(a || ""), "utf8");
    const y = Buffer.from(String(b || ""), "utf8");
    if (x.length !== y.length) return false;
    return crypto.timingSafeEqual(x, y);
}

export function newToken(): string {
    return crypto.randomBytes(32).toString("base64url");
}

export function newPairingCode(): string {
    // Uniform over 000000-999999: the modulo bias of a plain random byte run
    // would make some codes likelier, and with only a million of them that is
    // not a rounding error.
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

// Failed attempts, per source. In memory on purpose: one instance, and a
// restart clearing it is not a weakness when the code itself expires in ten
// minutes and dies on first use.
const failures = new Map<string, { count: number; until: number }>();

export function attemptsLocked(source: string, now = Date.now()): boolean {
    const row = failures.get(source);
    if (!row) return false;
    if (row.until <= now) { failures.delete(source); return false; }
    return row.count >= MAX_PAIR_ATTEMPTS;
}

export function noteFailedAttempt(source: string, now = Date.now()): void {
    const row = failures.get(source);
    if (!row || row.until <= now) { failures.set(source, { count: 1, until: now + ATTEMPT_LOCK_MS }); return; }
    row.count++;
    row.until = now + ATTEMPT_LOCK_MS;
}

export function clearAttempts(source: string): void {
    failures.delete(source);
}

/** One live code per chat: asking again replaces the previous one. */
export async function createPairingCode(chatId: string): Promise<{ code: string; expiresAt: Date }> {
    await PairingCode.deleteMany({ chat_id: chatId, used_at: null });
    const code = newPairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    await PairingCode.create({ code_hash: hashSecret(code), chat_id: chatId, expires_at: expiresAt });
    return { code, expiresAt };
}

/**
 * Spend a pairing code. Returns the chat it belonged to, or null for anything
 * wrong — expired, already used, or simply not a code we issued. The caller
 * cannot tell those apart, which is the point.
 */
export async function redeemPairingCode(code: string, now = new Date()): Promise<{ chatId: string } | null> {
    const clean = String(code || "").replace(/\D/g, "");
    if (clean.length !== 6) return null;
    // Claimed in one update, so two agents racing the same code cannot both win.
    const row: any = await PairingCode.findOneAndUpdate(
        { code_hash: hashSecret(clean), used_at: null, expires_at: { $gt: now } },
        { $set: { used_at: now } },
    ).lean();
    return row ? { chatId: row.chat_id } : null;
}

/**
 * Register the computer for a chat. One device per person for now, so pairing
 * again replaces the old row and the previous token stops working immediately.
 */
export async function registerDevice(chatId: string, info: {
    name?: string; os?: string; arch?: string; agent_version?: string; capabilities?: string[];
}): Promise<{ deviceId: string; token: string }> {
    await Device.deleteMany({ chat_id: chatId });
    const deviceId = `d_${crypto.randomBytes(8).toString("hex")}`;
    const token = newToken();
    await Device.create({
        device_id: deviceId,
        chat_id: chatId,
        token_hash: hashSecret(token),
        name: String(info.name || "").slice(0, 80),
        os: String(info.os || "").slice(0, 40),
        arch: String(info.arch || "").slice(0, 20),
        agent_version: String(info.agent_version || "").slice(0, 20),
        capabilities: (info.capabilities || []).map(String).slice(0, 20),
    });
    return { deviceId, token };
}

export async function setDeviceConnector(deviceId: string, connectorId: string): Promise<void> {
    await Device.updateOne({ device_id: deviceId }, { $set: { connector_id: connectorId } });
}

export type DeviceRow = {
    device_id: string; chat_id: string; connector_id: string; name: string; os: string;
    arch: string; agent_version: string; capabilities: string[]; last_seen_at: Date | null;
};

function asRow(d: any): DeviceRow | null {
    if (!d) return null;
    return {
        device_id: d.device_id, chat_id: d.chat_id, connector_id: d.connector_id || "",
        name: d.name || "", os: d.os || "", arch: d.arch || "", agent_version: d.agent_version || "",
        capabilities: d.capabilities || [], last_seen_at: d.last_seen_at || null,
    };
}

/** The device a bearer token belongs to, or null. */
export async function deviceForToken(token: string): Promise<DeviceRow | null> {
    const hash = hashSecret(String(token || ""));
    if (!String(token || "").trim()) return null;
    const rows: any[] = await Device.find({ token_hash: hash }).limit(2).lean();
    // The index narrows it to one row; the compare is what actually decides.
    for (const r of rows) if (sameSecret(r.token_hash, hash)) return asRow(r);
    return null;
}

export async function deviceForChat(chatId: string): Promise<DeviceRow | null> {
    return asRow(await Device.findOne({ chat_id: chatId }).lean());
}

export async function deviceForConnector(connectorId: string): Promise<DeviceRow | null> {
    if (!String(connectorId || "").trim()) return null;
    return asRow(await Device.findOne({ connector_id: connectorId }).lean());
}

export async function noteSeen(deviceId: string, hello?: { agent_version?: string; capabilities?: string[] }): Promise<void> {
    const set: any = { last_seen_at: new Date() };
    if (hello?.agent_version) set.agent_version = String(hello.agent_version).slice(0, 20);
    if (hello?.capabilities) set.capabilities = hello.capabilities.map(String).slice(0, 20);
    await Device.updateOne({ device_id: deviceId }, { $set: set });
}

export async function unpairDevice(chatId: string): Promise<boolean> {
    const res = await Device.deleteMany({ chat_id: chatId });
    return (res.deletedCount || 0) > 0;
}

export default {
    createPairingCode, redeemPairingCode, registerDevice, setDeviceConnector,
    deviceForToken, deviceForChat, deviceForConnector, noteSeen, unpairDevice,
    hashSecret, sameSecret, newToken, newPairingCode,
    attemptsLocked, noteFailedAttempt, clearAttempts,
    PAIRING_TTL_MS, MAX_PAIR_ATTEMPTS,
};
