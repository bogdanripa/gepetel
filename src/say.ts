// Send something as Gepetel AND record it, so the conversation window that gets
// sent to the model next turn contains his side too. Every outbound path goes
// through here — a greeting or a scheduled post missing from the window would
// leave him reading a conversation where he apparently never spoke.
//
// In a group, anyone he names gets a real tag (util.tagMembers) — a name in plain
// text doesn't reach the person, a tag does — and the archived copy carries their
// full name rather than a number, so he reads his own line back the way he reads
// everyone else's mentions. In a 1:1 there is nobody to tag.
//
// Anything he says in a group also opens the 5-minute follow-up window: a
// greeting, a reminder, a payment announcement, a gossip line — someone answering
// any of them within five minutes is talking to him, and the gatekeeper decides
// from there. Done here, once, so no outbound path can forget it. Callers that
// count the line as a real reply still call markGroupReplied afterwards (same
// fields, plus the counters); `openWindow: false` is for the one message he
// can't follow up on anyway (out of credits).
//
// Its own module so both the webhook side (app.ts) and the tool side (oai.ts)
// can speak without importing each other. Pictures (showAndRemember) and
// lines to the creator (tellCreator) are remembered the same way.
import wa from "./wa.js";
import m from "./mongo.js";
import u from "./util.js";
import { bubbles } from "./getToKnow.js";
import turns from "./turn.js";

export async function sayAndRemember(chatId: string, text: string, opts: { openWindow?: boolean } = {}): Promise<boolean> {
    // "[[next]]" between short messages (getToKnow.ts): separate messages in a
    // private chat, a paragraph break anywhere else.
    if (/\[\[next\]\]/i.test(text)) {
        if (u.isGroupChatId(chatId)) text = text.replace(/\s*\[\[next\]\]\s*/gi, "\n\n");
        else {
            const parts = bubbles(text);
            const started = Date.now();
            let ok = false;
            for (const [i, part] of parts.entries()) {
                if (i) await new Promise(r => setTimeout(r, 900 + Math.min(1500, part.length * 15)));
                // They started typing: give them the floor for a moment.
                for (let w = 0; i && w < 30 && turns.typingState(chatId) && !turns.heardSince(chatId, started); w++) await new Promise(r => setTimeout(r, 500));
                // They wrote meanwhile: stop, the way a person stops talking
                // when interrupted. Their message is answered next, knowing
                // what was said so far.
                if (i && turns.heardSince(chatId, started)) { console.log(`Stopped after ${i} of ${parts.length} short messages in ${chatId}: they wrote.`); break; }
                ok = (await sayAndRemember(chatId, part, opts)) || ok;
            }
            return ok;
        }
    }
    const isGroup = u.isGroupChatId(chatId);
    const tagged = (isGroup && wa.supportsMentions())
        ? u.tagMembers(text, await m.getNamedMembers(chatId))
        : { sent: text, mentions: [] as string[], archived: text };
    const sentId = await wa.sendWhatsAppMessage(chatId, tagged.sent, tagged.mentions);
    try { await m.archiveSent(chatId, sentId, tagged.archived); } catch (e) { /* non-critical */ }
    if (sentId && isGroup && opts.openWindow !== false) {
        try { await m.recordGroupAnnouncement(chatId, tagged.archived); } catch (e) { /* non-critical */ }
    }
    return !!sentId;
}

// A picture, remembered as a line saying it was sent and with what caption —
// the model never sees the image itself, only that he posted one.
export async function showAndRemember(chatId: string, image: string, caption = "", what = "image"): Promise<boolean> {
    const sent = await wa.sendWhatsAppImage(chatId, image, caption);
    const line = caption.trim() ? `[${what}] ${caption.trim()}` : `[${what}]`;
    try { await m.archiveSent(chatId, sent, line); } catch (e) { /* non-critical */ }
    return !!sent;
}

// A private line to Gepetel's creator (CREATOR_PHONE), kept in that chat's
// window like any other thing he said there.
export async function tellCreator(text: string): Promise<boolean> {
    const to = u.phoneDigits(process.env.CREATOR_PHONE);
    if (!to) { console.error("CREATOR_PHONE not set; cannot notify creator."); return false; }
    return await sayAndRemember(`${to}@s.whatsapp.net`, text);
}

export default { sayAndRemember, showAndRemember, tellCreator };
