// The WhatsApp provider switch.
//
// Gepetel can reach WhatsApp through whapi.cloud or through wa-gateway (a
// self-hosted gateway that speaks Meta's Cloud API shapes). Everything else in
// the codebase imports THIS module, never a provider directly, so swapping one
// for the other is an environment variable:
//
//     WA_PROVIDER=whapi        (default — whapi.cloud, WHAPI_TOKEN)
//     WA_PROVIDER=wa-gateway   (WA_GATEWAY_URL + WA_GATEWAY_TOKEN)
//
// Outbound calls go to whichever provider is configured. INBOUND events do not:
// parseWebhook picks the parser from the payload's own shape, so a webhook that
// is still pointed at the old provider keeps working while you flip the switch,
// and pointing both at Gepetel at once is harmless.
import axios from "axios";
import u from "./util.js";
import whapi from "./whapi.js";
import wagateway from "./wagateway.js";
import type { WaEvents, WaProvider } from "./watypes.js";

const PROVIDERS: Record<string, WaProvider> = {
    "whapi": whapi,
    "wa-gateway": wagateway,
    // tolerated spellings, so a typo in the env doesn't silently fall back
    "wagateway": wagateway,
    "gateway": wagateway,
};

let warnedUnknown = false;
let warnedUncredentialed = false;

export function provider(): WaProvider {
    const name = String(process.env.WA_PROVIDER || "whapi").trim().toLowerCase();
    const p = PROVIDERS[name];
    if (!p) {
        if (!warnedUnknown) {
            console.error(`Unknown WA_PROVIDER "${name}" — falling back to whapi. Valid: ${Object.keys(PROVIDERS).join(", ")}.`);
            warnedUnknown = true;
        }
        return whapi;
    }

    // A provider with no credential can't send anything — every call would 401 and
    // Gepetel would go silent in every group. That is a worse failure than using
    // the gateway we still have a token for, so fall back and say so loudly.
    // This is what makes the cutover a one-step change: point WA_PROVIDER at
    // wa-gateway whenever you like, and it takes effect the moment the token lands.
    if (p === wagateway && !process.env.WA_GATEWAY_TOKEN) {
        if (!warnedUncredentialed) {
            console.error("WA_PROVIDER=wa-gateway but WA_GATEWAY_TOKEN is empty — still sending through whapi. Set the token to complete the switch.");
            warnedUncredentialed = true;
        }
        return whapi;
    }
    return p;
}

export function providerName(): string {
    return provider().name;
}

// Can Gepetel see how a poll is going? Only if the gateway reports votes back.
// wa-gateway doesn't, so the vote-reading tool is withheld from the model there —
// a poll he can't read is fine; a tally he invents is not.
export function observesPollVotes(): boolean {
    return provider().observesPollVotes;
}

// Can Gepetel tag people? Only if the gateway will turn `@<digits>` into a real
// mention — otherwise names stay names (see tagMembers in util.ts).
export function supportsMentions(): boolean {
    return provider().supportsMentions();
}

// --- Outbound (delegated to the configured provider) ---
// Wrapped rather than re-exported: several call sites pass these as callbacks
// (`m.fireDueReminders(wa.sendWhatsAppMessage)`), and the provider must be
// resolved at call time, not at import time.

const getGroupInfo = (groupId: string) => provider().getGroupInfo(groupId);
const sendWhatsAppMessage = (to: String, message: String, mentions: string[] = []) => provider().sendWhatsAppMessage(to, message, mentions);
const reactToMessage = (messageId: string, emoji: string, to?: string) => provider().reactToMessage(messageId, emoji, to);
const sendWhatsAppPoll = (to: string, question: string, options: string[], allowMultiple: boolean = false) =>
    provider().sendWhatsAppPoll(to, question, options, allowMultiple);
// `messageId` lets wa-gateway show "typing…" (it types in reply to a message);
// whapi ignores it and types into the chat.
const sendTypingIndicator = (to: String, messageId?: string) => provider().sendTypingIndicator(to, messageId);
const sendWhatsAppImage = (to: String, image: string, caption: string = "") => provider().sendWhatsAppImage(to, image, caption);
const markAsRead = (messageId: string) => provider().markAsRead(messageId);

// --- Inbound ---

// Is this Meta's envelope (wa-gateway) rather than whapi's flat payload?
function isGatewayPayload(body: any): boolean {
    return body?.object === "whatsapp_business_account" || Array.isArray(body?.entry);
}

// Normalize an incoming webhook body, whoever sent it.
function parseWebhook(body: any): WaEvents {
    return isGatewayPayload(body) ? wagateway.parseWebhook(body) : whapi.parseWebhook(body);
}

// wa-gateway signs its deliveries with the number's token in X-Wa-Gateway-Token
// (not Authorization — that header is often claimed by the receiving service).
// Reject a mismatch; accept a missing header, since whapi sends none.
function webhookAuthOk(req: any): boolean {
    const sent = req?.get?.("x-wa-gateway-token") || "";
    if (!sent) return true;
    const expected = String(process.env.WA_GATEWAY_TOKEN || "");
    if (!expected) return true;   // nothing to check against
    return sent === expected;
}

// --- Provider-independent helpers ---

// Send a private WhatsApp message to Gepetel's creator (CREATOR_PHONE).
async function notifyCreator(message: string): Promise<boolean> {
    const to = u.phoneDigits(process.env.CREATOR_PHONE);
    if (!to) { console.error("CREATOR_PHONE not set; cannot notify creator."); return false; }
    return !!(await sendWhatsAppMessage(to, message));   // callers here only care that it went
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
    } catch (error: any) {
        return `Could not read the URL: ${error.response?.status || ""} ${error.message || error}`.trim();
    }
}

export default {
    provider, providerName, observesPollVotes,
    supportsMentions,
    getGroupInfo, sendWhatsAppMessage, reactToMessage, sendWhatsAppPoll,
    sendTypingIndicator, sendWhatsAppImage, markAsRead,
    parseWebhook, isGatewayPayload, webhookAuthOk,
    notifyCreator, readUrl,
};
