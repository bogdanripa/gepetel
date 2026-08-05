// whapi.cloud provider — https://whapi.cloud
//
// The original (and default) way Gepetel reaches WhatsApp. Selected with
// WA_PROVIDER=whapi; see wa.ts for the switch and watypes.ts for the shapes every
// provider has to speak.
import axios from "axios";
import u from "./util.js";
import type { WaEvents, WaIncomingMessage, WaProvider } from "./watypes.js";

// Fetch a group's authoritative roster AND its name/subject from whapi.
// Returns { participants, name }; an empty result for non-group ids; null on error.
async function getGroupInfo(groupId: string): Promise<{ participants: string[]; name: string } | null> {
    if (!groupId.match(/^[\d-]{10,31}@g\.us$/)) return { participants: [], name: "" };
    const url = `https://gate.whapi.cloud/groups/${groupId}`;

    try {
        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${process.env.WHAPI_TOKEN}`,
                "content-type": "application/json",
                accept: "application/json"
            }
        });

        console.log(`Group ${groupId} has ${response.data.participants_count} members.`);
        const participants = (response.data.participants || []).map((participant: any) => participant.id);
        // whapi exposes the group subject as `name` (older payloads use `subject`).
        const name = response.data.name || response.data.subject || "";
        return { participants, name };
    } catch (error: any) {
        console.error("Error retrieving group metadata for group " + groupId + ":", error.response?.data || error.message);
        return null;
    }
}

async function sendWhatsAppMessage(to: String, message: String) {
    message = u.cleanWhatsAppText(String(message));

    const url = `https://gate.whapi.cloud/messages/text`;

    try {
        await axios.post(
            url,
            {
                to,
                body: message
            },
            { 
                headers: { 
                    Authorization: `Bearer ${process.env.WHAPI_TOKEN}`,
                    "content-type": "application/json",
                    accept: "application/json"
                }
             }
        );
        console.log("Message sent!");
        return true;
    } catch (error:any) {
        console.error("Error sending message:", error.response?.data || error.message || error);
        return false;
    }
}

// `to` is accepted for interface parity with wa-gateway (which addresses a
// reaction to a chat); whapi identifies the target by message id alone.
async function reactToMessage(messageId: string, emoji: string, _to?: string) {
    const url = `https://gate.whapi.cloud/messages/${messageId}/reaction`;

    try {
        await axios.put(
            url,
            {
                emoji
            },
            { 
                headers: { 
                    Authorization: `Bearer ${process.env.WHAPI_TOKEN}`,
                    "content-type": "application/json",
                    accept: "application/json"
                }
             }
        );
        console.log("Reacted to message");
        return true;
    } catch (error:any) {
        console.error("Error emoji'ing message");
        return false;
    }    
}

// WhatsApp itself allows 2–12 poll options, and they must be unique.
const MAX_POLL_OPTIONS = 12;

async function sendWhatsAppPoll(to: string, question: string, options: string[], allowMultiple: boolean = false) {
    // De-duplicate: whapi rejects the whole poll if two options are identical.
    const cleanedOptions = [...new Set(
        (options || []).map(o => String(o || "").trim()).filter(Boolean)
    )].slice(0, MAX_POLL_OPTIONS);
    if (cleanedOptions.length < 2) {
        throw new Error("Need at least two options for a poll");
    }

    const url = `https://gate.whapi.cloud/messages/poll`;

    // `count` caps how many answers one person may select, and whapi refuses
    // anything above 1 ("/body/count must be <= 1"). It is NOT the number of
    // options — that mistake sent every multi-answer poll to the text fallback.
    //   count: 1  -> single answer
    //   count: 0  -> no cap, i.e. multi-select   (verified against a live send)
    // The retry with 1 stays as a safety net: if whapi ever tightens this, a
    // single-answer poll is still a real, tappable poll, and far better than a
    // plain-text list nobody can vote on.
    const attempts = allowMultiple ? [0, 1] : [1];

    for (let i = 0; i < attempts.length; i++) {
        const count = attempts[i];
        try {
            const res = await axios.post(url, { to, title: question, options: cleanedOptions, count }, {
                headers: {
                    Authorization: `Bearer ${process.env.WHAPI_TOKEN}`,
                    "content-type": "application/json",
                    accept: "application/json"
                }
            });
            if (allowMultiple && count === 1) {
                console.warn("Poll sent as SINGLE-answer: whapi refused count=0, so multi-select isn't available.");
            }
            console.log("Poll sent!", res.data);
            // Return the WhatsApp message id so votes can be correlated back to this poll.
            return res.data?.message?.id || res.data?.id || null;
        } catch (error: any) {
            const detail = JSON.stringify(error.response?.data || error.message || error);
            if (i < attempts.length - 1) {
                console.warn(`Poll with count=${count} rejected, retrying. whapi said: ${detail}`);
                continue;
            }
            // Out of options. The fallback still delivers the words, but it is NOT
            // a poll — nobody can tap an answer and no votes are tallied. Log
            // loudly: a silent degrade here hid a malformed payload for months.
            console.error("NATIVE POLL FAILED — sending a plain-text list instead. whapi said:", detail);
            const body = `Poll: ${question}\n${cleanedOptions.map((o, n) => `${n+1}. ${o}`).join("\n")}`;
            await sendWhatsAppMessage(to, body);
            return null;
        }
    }
    return null;
}

// How long WhatsApp shows "typing…". This used to be 0, which asks for zero
// milliseconds of typing — the indicator was sent and then immediately over, so
// in practice nobody ever saw it. A few seconds covers a normal reply.
const TYPING_MS = 3000;

// `messageId` is unused here (whapi types into a chat, not at a message) but is
// part of the shared interface: wa-gateway can only type in reply to a message.
async function sendTypingIndicator(to: String, _messageId?: string) {
    // The presences endpoint is fussier about the recipient than the messaging
    // ones: a group jid is fine, but a 1:1 "40712345678@s.whatsapp.net" is
    // rejected ("EntryID must match exactly one schema in oneOf") and wants bare
    // digits. That is why typing never showed in a 1:1 — only in groups.
    const entryId = String(to).endsWith("@g.us") ? to : String(to).replace(/\D/g, "");
    const url = `https://gate.whapi.cloud/presences/${entryId}`;
    try {
        await axios.put(url, {
            presence: "typing",
            delay: TYPING_MS
        }, {
            headers: { Authorization: `Bearer ${process.env.WHAPI_TOKEN}` }
        });
    } catch (error:any) {
        // Log what actually went wrong — a bare "it failed" told us nothing.
        console.error(`Error sending typing indicator to ${entryId}:`,
            JSON.stringify(error.response?.data || error.message || error));
        return false;
    }
}

// Send an image to a chat. Accepts a raw base64 PNG, a data-URI, or an http URL.
async function sendWhatsAppImage(to: String, image: string, caption: string = "") {
    const media = image.startsWith("data:") || image.startsWith("http")
        ? image
        : `data:image/png;name=gepetel.png;base64,${image}`;
    try {
        await axios.post(`https://gate.whapi.cloud/messages/image`, { to, media, caption }, {
            headers: { Authorization: `Bearer ${process.env.WHAPI_TOKEN}`, "content-type": "application/json" }
        });
        return true;
    } catch (error:any) {
        console.error("Error sending image:", error.response?.data || error.message);
        return false;
    }
}

// Mark an incoming message as read (blue ticks).
async function markAsRead(messageId: string) {
    if (!messageId) return false;
    const url = `https://gate.whapi.cloud/messages/${messageId}`;
    try {
        await axios.put(url, { status: "read" }, {
            headers: { Authorization: `Bearer ${process.env.WHAPI_TOKEN}`, "content-type": "application/json" }
        });
        return true;
    } catch (error:any) {
        console.error("Error marking message as read:", error.response?.data || error.message);
        return false;
    }
}

// --- Webhook ---

// whapi posts flat top-level arrays: messages, groups, contacts and (for poll
// votes) messages_updates. Translate them into the neutral shapes in watypes.ts.
function parseWebhook(body: any): WaEvents {
    const events: WaEvents = { groups: [], contacts: [], polls: [], messages: [] };

    for (const g of body?.groups || []) {
        events.groups.push({
            id: g.id,
            name: g.name || g.subject || "",
            participants: (g.participants || []).map((p: any) => ({ id: p.id, name: p.name || p.pushname || "" })),
        });
    }

    for (const c of body?.contacts || []) {
        if (c?.id) events.contacts.push({ id: c.id, name: c.name || c.pushname || "" });
    }

    // Poll votes arrive as message updates (requires "Messages PATCH" mode in the
    // whapi webhook settings). The updated poll message carries the full tally.
    for (const upd of body?.messages_updates || []) {
        const pollMsg = [upd?.after_update, upd?.message, upd].find(
            (c: any) => c && c.type === "poll" && c.poll && Array.isArray(c.poll.results)
        );
        if (pollMsg) events.polls.push({ id: pollMsg.id, poll: pollMsg.poll });
    }

    for (const msg of body?.messages || []) {
        if (msg.from_me) continue;   // our own sends echo back; never react to them
        const out: WaIncomingMessage = {
            id: msg.id,
            chatId: msg.chat_id,
            from: msg.from,
            fromName: msg.from_name || "",
            chatName: msg.chat_name || "",
            text: "",
            raw: msg,
        };
        if (msg.text?.body) {
            out.text = msg.text.body;
        } else if (msg.gif?.preview) {
            out.gif = { link: msg.gif.preview, caption: msg.gif.caption };
        } else if (msg.image?.link || msg.image?.preview) {
            // Prefer the full-res link (Auto Download) over the thumbnail.
            out.image = { link: msg.image.link || msg.image.preview, caption: msg.image.caption };
        } else if (msg.voice?.link || msg.audio?.link) {
            out.voice = { link: (msg.voice || msg.audio).link };
        } else if (msg.link_preview) {
            out.linkPreview = {
                title: msg.link_preview.title,
                description: msg.link_preview.description,
                preview: msg.link_preview.preview,
            };
        }
        events.messages.push(out);
    }

    return events;
}

const provider: WaProvider = {
    name: "whapi",
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
