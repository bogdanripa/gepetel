// wa-gateway provider — https://wa-gateway-coolify.bogdanripa.com/docs.html
//
// A self-hosted WhatsApp gateway that speaks Meta's WhatsApp Cloud API shapes:
// every send is POST /<PHONE_NUMBER_ID>/messages with `messaging_product:
// "whatsapp"`, and inbound events arrive in Meta's `entry[].changes[]` envelope.
// The number's token is the only credential and it selects the number, so the
// PHONE_NUMBER_ID in the path is cosmetic (the gateway accepts it and ignores it).
//
// Differences from whapi that shaped the code below:
//   - typing is a *status* tied to a message id (Meta's model), not a presence
//     update aimed at a chat — so sendTypingIndicator needs the incoming id
//   - group participants come back as bare digits, already resolved from @lid
//   - polls send fine but votes never come back, so Gepetel can't read a tally
//     here (see observesPollVotes)
import axios from "axios";
import u from "./util.js";
import type { WaEvents, WaIncomingMessage, WaProvider } from "./watypes.js";

const DEFAULT_BASE = "https://wa-gateway-coolify.bogdanripa.com/api";

// Read config lazily: on Cloud Functions the secrets land in the environment
// after module load, so capturing them at import time would freeze in the blanks.
const baseUrl = () => String(process.env.WA_GATEWAY_URL || DEFAULT_BASE).replace(/\/+$/, "");
const token = () => String(process.env.WA_GATEWAY_TOKEN || "");
// Cosmetic path segment; the token is what actually routes. Kept configurable so
// an existing Cloud API URL can be reproduced verbatim.
const phoneNumberId = () => String(process.env.WA_GATEWAY_PHONE_NUMBER_ID || "gepetel");

function headers() {
    return {
        Authorization: `Bearer ${token()}`,
        "content-type": "application/json",
        accept: "application/json",
    };
}

// Meta's error envelope: { error: { message, type, code, error_data } }.
function describeError(error: any): string {
    const data = error?.response?.data;
    return JSON.stringify(data?.error || data || error?.message || error);
}

// A stored chat id can be a group jid, a whapi-style "40712…@s.whatsapp.net", or
// bare digits. Groups go through untouched; anything else is a phone number.
function recipient(to: unknown): { to: string; recipient_type: "group" | "individual" } {
    const id = String(to ?? "");
    if (id.endsWith("@g.us")) return { to: id, recipient_type: "group" };
    return { to: u.phoneDigits(id), recipient_type: "individual" };
}

async function postMessage(payload: Record<string, any>): Promise<any> {
    const res = await axios.post(
        `${baseUrl()}/${phoneNumberId()}/messages`,
        { messaging_product: "whatsapp", ...payload },
        { headers: headers() }
    );
    return res.data;
}

// Fetch a group's authoritative roster AND its subject.
// Returns { participants, name }; an empty result for non-group ids; null on error.
async function getGroupInfo(groupId: string): Promise<{ participants: string[]; name: string } | null> {
    if (!groupId.match(/^[\d-]{10,31}@g\.us$/)) return { participants: [], name: "" };

    try {
        const response = await axios.get(`${baseUrl()}/groups/${groupId}`, { headers: headers() });
        const participants = (response.data.participants || []).map((p: any) => p.id);
        console.log(`Group ${groupId} has ${response.data.participants_count ?? participants.length} members.`);
        const name = response.data.name || response.data.subject || "";
        return { participants, name };
    } catch (error: any) {
        console.error("Error retrieving group metadata for group " + groupId + ":", describeError(error));
        return null;
    }
}

async function sendWhatsAppMessage(to: String, message: String): Promise<boolean> {
    const body = u.cleanWhatsAppText(String(message));
    try {
        await postMessage({ ...recipient(to), type: "text", text: { body } });
        console.log("Message sent!");
        return true;
    } catch (error: any) {
        console.error("Error sending message:", describeError(error));
        return false;
    }
}

// Reactions need the chat as well as the message id — Meta models a reaction as
// a message sent *to* a chat. whapi's endpoint didn't, hence the optional arg.
async function reactToMessage(messageId: string, emoji: string, to?: string): Promise<boolean> {
    if (!to) {
        console.error("wa-gateway needs the chat id to react to a message; none given.");
        return false;
    }
    try {
        await postMessage({ ...recipient(to), type: "reaction", reaction: { message_id: messageId, emoji } });
        console.log("Reacted to message");
        return true;
    } catch (error: any) {
        console.error("Error emoji'ing message:", describeError(error));
        return false;
    }
}

// WhatsApp itself allows 2–12 poll options, and they must be unique.
const MAX_POLL_OPTIONS = 12;

// Polls go to the ordinary send endpoint with `type: "poll"` — no separate route,
// unlike whapi's /messages/poll. Verified against a live send on 2026-08-05: this
// exact body was rejected at first by a gateway-side bug (since fixed), which the
// text fallback below surfaced verbatim. That is what the fallback is for; keep it.
async function sendWhatsAppPoll(to: string, question: string, options: string[], allowMultiple: boolean = false): Promise<string | null> {
    const cleanedOptions = [...new Set(
        (options || []).map(o => String(o || "").trim()).filter(Boolean)
    )].slice(0, MAX_POLL_OPTIONS);
    if (cleanedOptions.length < 2) {
        throw new Error("Need at least two options for a poll");
    }

    // selectable_count: how many answers one person may pick. 1 = single answer,
    // the option count = free multi-select (WhatsApp's own encoding). Deliberately
    // NOT whapi's inverted `count: 0` for multi-select — the gateways disagree here.
    const selectableCount = allowMultiple ? cleanedOptions.length : 1;
    try {
        const data = await postMessage({
            ...recipient(to),
            type: "poll",
            poll: { name: question, options: cleanedOptions, selectable_count: selectableCount },
        });
        const id = data?.messages?.[0]?.id || data?.id || null;
        console.log("Poll sent!", JSON.stringify(data));
        return id;
    } catch (error: any) {
        // The fallback still delivers the words, but it is NOT a poll — nobody can
        // tap an answer and no votes are tallied. Log loudly: a silent degrade here
        // hid a malformed payload for months on the whapi path.
        console.error("NATIVE POLL FAILED — sending a plain-text list instead. wa-gateway said:", describeError(error));
        const body = `Poll: ${question}\n${cleanedOptions.map((o, n) => `${n + 1}. ${o}`).join("\n")}`;
        await sendWhatsAppMessage(to, body);
        return null;
    }
}

// Typing here is Meta-shaped: a read receipt for a specific message, with a
// typing indicator riding along. There is no "start typing in this chat" call, so
// without the incoming message id there is nothing to send.
async function sendTypingIndicator(to: String, messageId?: string): Promise<boolean> {
    if (!messageId) {
        console.log("No message id — wa-gateway can't show a typing indicator for this chat.");
        return false;
    }
    try {
        await postMessage({ status: "read", message_id: messageId, typing_indicator: { type: "text" } });
        return true;
    } catch (error: any) {
        console.error(`Error sending typing indicator for message ${messageId}:`, describeError(error));
        return false;
    }
}

// Send an image to a chat. Accepts a raw base64 PNG, a data-URI, or an http URL —
// wa-gateway's `link` takes all three.
async function sendWhatsAppImage(to: String, image: string, caption: string = ""): Promise<boolean> {
    const link = image.startsWith("data:") || image.startsWith("http")
        ? image
        : `data:image/png;name=gepetel.png;base64,${image}`;
    try {
        await postMessage({ ...recipient(to), type: "image", image: { link, caption } });
        return true;
    } catch (error: any) {
        console.error("Error sending image:", describeError(error));
        return false;
    }
}

// Mark an incoming message as read (blue ticks).
async function markAsRead(messageId: string): Promise<boolean> {
    if (!messageId) return false;
    try {
        await postMessage({ status: "read", message_id: messageId });
        return true;
    } catch (error: any) {
        console.error("Error marking message as read:", describeError(error));
        return false;
    }
}

// A 1:1 chat id, in the same shape whapi uses. wa-gateway reports the sender as
// bare digits; storing that as the chat id would open a second, empty history for
// everyone Gepetel already knows, so we keep the established form.
function dmChatId(from: unknown): string {
    const digits = u.phoneDigits(from);
    return digits ? `${digits}@s.whatsapp.net` : "";
}

// --- Webhook ---

// Meta's envelope: { object, entry: [ { changes: [ { field, value } ] } ] }.
// Fields we act on: messages, group_participants_update, contacts, message_polls.
function parseWebhook(body: any): WaEvents {
    const events: WaEvents = { groups: [], contacts: [], polls: [], messages: [] };

    for (const entry of body?.entry || []) {
        for (const change of entry?.changes || []) {
            const value = change?.value || {};
            switch (change?.field) {
                case "messages": {
                    // The sender's display name rides in `contacts`, keyed by wa_id.
                    const nameByWaId = new Map<string, string>();
                    for (const c of value.contacts || []) {
                        if (c?.wa_id) nameByWaId.set(u.phoneDigits(c.wa_id), c?.profile?.name || "");
                    }
                    for (const msg of value.messages || []) {
                        events.messages.push(normalizeMessage(msg, nameByWaId));
                    }
                    break;
                }
                case "group_participants_update": {
                    for (const g of value.groups || []) {
                        events.groups.push({
                            id: g.group_id || g.id,
                            name: g.subject || g.name || "",
                            participants: (g.participants || []).map((p: any) => ({
                                id: p.wa_id || p.id,
                                name: p?.name || p?.profile?.name || "",
                            })),
                        });
                    }
                    break;
                }
                case "contacts": {
                    for (const c of value.contacts || []) {
                        if (c?.wa_id) events.contacts.push({ id: c.wa_id, name: c?.profile?.name || c?.name || "" });
                    }
                    break;
                }
                case "message_polls": {
                    for (const p of value.polls || []) {
                        if (p?.id && Array.isArray(p.results)) {
                            events.polls.push({ id: p.id, poll: { total: p.total, results: p.results } });
                        }
                    }
                    break;
                }
                default:
                    // Unknown field (delivery statuses, future additions) — ignore.
                    break;
            }
        }
    }

    return events;
}

function normalizeMessage(msg: any, nameByWaId: Map<string, string>): WaIncomingMessage {
    const out: WaIncomingMessage = {
        id: msg.id,
        chatId: msg.group_id || dmChatId(msg.from),
        from: msg.from,
        fromName: nameByWaId.get(u.phoneDigits(msg.from)) || "",
        // wa-gateway doesn't put the group subject on a message; the stored group
        // record (refreshed from getGroupInfo) is the source of truth for that.
        chatName: "",
        text: "",
        raw: msg,
    };

    if (msg.type === "text" && msg.text?.body) {
        out.text = msg.text.body;
    } else if (msg.type === "image" && msg.image?.link) {
        out.image = { link: msg.image.link, caption: msg.image.caption };
    } else if (msg.type === "video" && msg.video?.link) {
        // GIFs arrive as video here, as they do on WhatsApp itself.
        out.gif = { link: msg.video.link, caption: msg.video.caption };
    } else if (msg.type === "audio" && msg.audio?.link) {
        out.voice = { link: msg.audio.link };
    }
    return out;
}

const provider: WaProvider = {
    name: "wa-gateway",
    observesPollVotes: false,
    getGroupInfo,
    sendWhatsAppMessage,
    reactToMessage,
    sendWhatsAppPoll,
    sendTypingIndicator,
    sendWhatsAppImage,
    markAsRead,
    parseWebhook,
};

export default provider;
