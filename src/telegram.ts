import axios from "axios";

// Operator notifications over Telegram — for things Bogdan wants to know about
// as they happen, without watching the logs. Nothing user-facing goes through
// here; Gepetel talks to people on WhatsApp.

const API = "https://api.telegram.org";
const MAX_LEN = 4096;   // Telegram rejects anything longer

export function isConfigured(): boolean {
    return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

// Send a note to the operator. Never throws and never blocks the caller's real
// work: a missing token or a Telegram outage must not stop Gepetel greeting a
// group. Returns whether it actually went out.
async function notify(text: string, { silent = false }: { silent?: boolean } = {}): Promise<boolean> {
    if (!isConfigured()) {
        // Not an error — the integration is optional, so say so once and move on.
        console.log("Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID); skipping notification.");
        return false;
    }
    const body = String(text || "").slice(0, MAX_LEN);
    if (!body.trim()) return false;

    try {
        const res = await axios.post(
            `${API}/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                chat_id: process.env.TELEGRAM_CHAT_ID,
                text: body,
                parse_mode: "Markdown",
                disable_notification: silent,
            },
            { headers: { "content-type": "application/json" }, timeout: 10000 }
        );
        // Telegram answers 200 with ok:false for application-level failures.
        if (res.data?.ok === false) {
            console.error("Telegram refused the message:", res.data?.description);
            return false;
        }
        return true;
    } catch (error: any) {
        console.error("Telegram notification failed:", JSON.stringify(error.response?.data || error.message || error));
        return false;
    }
}

// Markdown is on, so anything interpolated into a message has to be defused —
// a group called "Vila *18*" would otherwise break the formatting or the send.
export function escapeMarkdown(text: string): string {
    return String(text ?? "").replace(/([_*`\[\]])/g, "\\$1");
}

export default { notify, isConfigured, escapeMarkdown };
