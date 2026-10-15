// Messages/dedup: which incoming message ids have been taken, by which run of
// the server, and whether that run finished them. Split out of mongo.ts
// (2026-10-15), which still re-exports all of it.
import crypto from "node:crypto";
import mongoose from "mongoose";

// Idempotency guard: every incoming WhatsApp message id we've already handled.
// whapi redelivers webhooks on any timeout/5xx, which would otherwise make
// Gepetel reply (and count mentions) twice. Unique index => second insert fails.
// TTL auto-expires entries after a day (whapi won't redeliver that late).
const processedMessageSchema = new mongoose.Schema({
    messageId: { type: String, required: true, unique: true },
    // Which run of the server took it, and whether it finished: a retry of a
    // message a server took and died with (a deploy) is handled, not skipped.
    owner: { type: String, default: "" },
    done: { type: Boolean, default: true },
    /** When `owner` took it. Another run takes it over only once this is old
     *  enough that the owner is plainly gone, not merely still working. */
    claimedAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 },
});

const ProcessedMessage = mongoose.model("ProcessedMessage", processedMessageSchema);

// Atomically claim an incoming message id. Returns true the FIRST time we see it
// (caller should process it), false on any redelivery (caller should skip).
/** This run of the server: a message taken by another run and never
 *  finished was lost with it. */
const SERVER_RUN = crypto.randomBytes(8).toString("hex");

/** How long a run may hold a message unfinished before another run may
 *  assume it died with it. Longer than a slow reply (a minute of tools, an
 *  "On it…"), shorter than the gateway gives up redelivering. */
export const TAKEOVER_AFTER_MS = 2 * 60_000;

/** Take a message to handle. False: it's handled, or being handled here.
 *  A message another run took and didn't finish is taken over: during a
 *  deploy (2026-10-15) the old server took one, died, and the new one skipped
 *  the redelivery as a duplicate — the person got no reply. Only once the
 *  claim is TAKEOVER_AFTER_MS old: while the old run is still alive (both
 *  running during a deploy) taking it at once answered it twice. */
export async function markMessageProcessed(messageId: string, now = new Date()): Promise<boolean> {
    if (!messageId) return true; // no id to dedup on -> process it
    try {
        await ProcessedMessage.create({ messageId, owner: SERVER_RUN, done: false, claimedAt: now });
        return true;
    } catch (e: any) {
        if (e?.code !== 11000) throw e;
        const stale = new Date(now.getTime() - TAKEOVER_AFTER_MS);
        const took = await ProcessedMessage.findOneAndUpdate(
            {
                messageId, done: false, owner: { $ne: SERVER_RUN },
                // Rows from before claimedAt existed: their creation is the claim.
                $or: [{ claimedAt: { $lte: stale } }, { claimedAt: { $exists: false }, createdAt: { $lte: stale } }],
            },
            { $set: { owner: SERVER_RUN, claimedAt: now } }).lean();
        if (took) console.log(`message ${messageId}: taken by a server run that didn't finish it; handling it here`);
        return !!took;
    }
}

/** The message was handled to the end. */
export async function markMessageDone(messageId: string): Promise<void> {
    if (!messageId) return;
    await ProcessedMessage.updateOne({ messageId }, { $set: { done: true } }).catch(() => {});
}

export default { markMessageProcessed, markMessageDone, TAKEOVER_AFTER_MS };
