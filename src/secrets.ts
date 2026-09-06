// Sealing for credentials at rest — the API keys and tokens people hand Gepetel
// in a 1:1 so a group can use a connected service.
//
// A connector's headers are the only secrets Gepetel stores on behalf of
// someone else, and the database is shared with everything else he knows. So
// they are sealed with AES-256-GCM under a key derived from MCP_SECRET_KEY,
// and stay sealed until the moment a request to that service is built. Without
// the variable they are stored as they are, with one loud warning at startup:
// refusing to work would just move the key into a chat message instead.
//
// The format is self-describing ("gcm:" / "plain:") so rotating in a key later
// re-seals on the next write and never fails to read what is already stored.
import crypto from "node:crypto";

const PREFIX_SEALED = "gcm:";
const PREFIX_PLAIN = "plain:";

let warned = false;

function key(): Buffer | null {
    const raw = String(process.env.MCP_SECRET_KEY || "").trim();
    if (!raw) {
        if (!warned) {
            console.error("MCP_SECRET_KEY is not set — connector credentials will be stored unsealed. Set it to seal them at rest.");
            warned = true;
        }
        return null;
    }
    return crypto.createHash("sha256").update(raw).digest();
}

export function seal(value: unknown): string {
    const plain = JSON.stringify(value ?? null);
    const k = key();
    if (!k) return PREFIX_PLAIN + plain;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX_SEALED + Buffer.concat([iv, tag, body]).toString("base64");
}

export function open<T = any>(stored: string | null | undefined): T | null {
    const s = String(stored ?? "");
    if (!s) return null;
    if (s.startsWith(PREFIX_PLAIN)) return JSON.parse(s.slice(PREFIX_PLAIN.length));
    if (!s.startsWith(PREFIX_SEALED)) return null;
    const k = key();
    if (!k) throw new Error("credentials are sealed but MCP_SECRET_KEY is not set");
    const buf = Buffer.from(s.slice(PREFIX_SEALED.length), "base64");
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), body = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", k, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    return JSON.parse(plain);
}

export default { seal, open };
