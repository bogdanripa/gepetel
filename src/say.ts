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
// can speak without importing each other.
import wa from "./wa.js";
import m from "./mongo.js";
import u from "./util.js";

export async function sayAndRemember(chatId: string, text: string, opts: { openWindow?: boolean } = {}): Promise<boolean> {
    const isGroup = u.isGroupChatId(chatId);
    const tagged = (isGroup && wa.supportsMentions())
        ? u.tagMembers(text, await m.getNamedMembers(chatId))
        : { sent: text, mentions: [] as string[], archived: text };
    const sentId = await wa.sendWhatsAppMessage(chatId, tagged.sent, tagged.mentions);
    if (typeof sentId === "string") {
        try { await m.archiveMessage(chatId, sentId, "Gepetel", tagged.archived); } catch (e) { /* non-critical */ }
    }
    if (sentId && isGroup && opts.openWindow !== false) {
        try { await m.recordGroupAnnouncement(chatId, tagged.archived); } catch (e) { /* non-critical */ }
    }
    return !!sentId;
}

export default { sayAndRemember };
