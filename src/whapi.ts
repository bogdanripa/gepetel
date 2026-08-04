import axios from "axios";
import u from "./util.js";

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

async function reactToMessage(messageId: string, emoji: string) {
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

    // `count` is how many answers one person may select, and whapi rejects
    // anything above 1 ("/body/count must be <= 1"). So the only lever for a
    // multi-answer poll is 0, which reads as "no limit". That isn't documented,
    // so try it and fall back to 1 rather than betting the whole send on it —
    // a single-answer poll is still a real, tappable poll, and infinitely better
    // than the plain-text list people can't vote on.
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

async function sendTypingIndicator(to: String) {
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

// Send a private WhatsApp message to Gepetel's creator (CREATOR_PHONE).
async function notifyCreator(message: string): Promise<boolean> {
    const to = String(process.env.CREATOR_PHONE || "").replace(/\D/g, "");
    if (!to) { console.error("CREATOR_PHONE not set; cannot notify creator."); return false; }
    return await sendWhatsAppMessage(to, message);
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

// Fetch a URL and return its readable text (powers the read_url tool).
async function readUrl(url: string): Promise<string> {
    try {
        const res = await axios.get(url, {
            timeout: 15000,
            maxContentLength: 5_000_000,
            responseType: "text",
            transformResponse: [(d) => d],
            headers: { "User-Agent": "Mozilla/5.0 (compatible; GepetelBot/1.0)" },
        });
        const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
        return u.htmlToText(body);
    } catch (error:any) {
        return `Could not read the URL: ${error.response?.status || ""} ${error.message || error}`.trim();
    }
}

export default { getGroupInfo, sendWhatsAppMessage, reactToMessage, sendTypingIndicator, sendWhatsAppPoll, markAsRead, readUrl, sendWhatsAppImage, notifyCreator };
