import express from "express";
import { http } from "@google-cloud/functions-framework";
import wa from "./whapi.js";
import oai from "./oai.js";
import m from "./mongo.js";
import u from "./util.js";

// app
const app = express();
app.use(express.json());

async function processIncomingMessage(chatId: string, text: string, author: string, groupName: string | undefined, messageId: string) {
    text = u.normalizeMentions(text);
    console.log(`Message from ${author}: ${text}`);
    const isGroupMessage = u.isGroupChatId(chatId);
    const mentioned = !isGroupMessage || u.isMentioned(text);

    // Track when this group is active (UTC hour histogram) for timing unprompted messages.
    await m.recordActivity(chatId);

    // Mark the incoming message as read first (we've seen it).
    try { await wa.markAsRead(messageId); } catch (e) { /* non-critical */ }

    let shouldReply = true;          // 1:1 and explicit mentions always reply
    let numUnsentMessages = 0;

    let silentReason = "not-mentioned";
    if (isGroupMessage) {
        const meta = await m.getGroupMetadata(chatId);
        numUnsentMessages = meta.numUnsentMessages;

        const gate = u.replyGateDecision({
            isGroupMessage,
            mentioned,
            gapMs: Date.now() - new Date(meta.lastReplyAt || 0).getTime(),
        });

        if (gate.consultGatekeeper) {
            // Only when Gepetel spoke recently: ask the gatekeeper whether this
            // new message is a genuine follow-up to HIS last line.
            const cached = await m.getCachedMessages(chatId);
            const conversation = [
                ...cached.map((msg: any) => `${msg.from}: ${msg.text}`),
                `${author}: ${text}`,
            ].join("\n");
            shouldReply = await oai.shouldRespondToGroup(conversation, meta.lastReplyText || "");
            console.log(`Reply gate (follow-up?): ${shouldReply ? "yes" : "no"}`);
            silentReason = "gate-no";
        } else {
            shouldReply = gate.decision === "reply";
            silentReason = gate.reason;
        }
    }

    if (!shouldReply) {
        console.log("Staying quiet, caching message.");
        await m.saveMessage(chatId, author, text);
        await m.logInteraction({ chatId, groupName, isGroup: isGroupMessage, author, incoming: text, action: `silent:${silentReason}`, reply: "" });

        if (numUnsentMessages + 1 > 20) {
            const {previousMessageId} = await m.newMessage(chatId, author, text, wa.getGroupParticipants);
            const reply = await oai.updateMessages(chatId, previousMessageId);
            await m.updatePreviousMessageId(chatId, reply.responseId);
        }
        return;
    }

    // We've decided to reply — now show the "typing…" indicator.
    await wa.sendTypingIndicator(chatId);

    let reply: {answer: string; responseId: string; consumedMessages?: {from: string; text: string; timestamp?: Date}[]};
    const {numberOfParticipants, previousMessageId} = await m.newMessage(chatId, author, text, wa.getGroupParticipants);
    if (isGroupMessage) {
        reply = await oai.generateGroupReply(chatId, groupName || '', numberOfParticipants, previousMessageId, `${author}: ${text}`, numUnsentMessages, mentioned);
    } else {
        reply = await oai.generateReply(author, text, previousMessageId);
    }
    // In groups Gepetel may still decide there's nothing to add; in a 1:1 he always replies.
    if (isGroupMessage && reply.answer.toLowerCase().includes("no answer")) {
        console.log("No reply generated.");
        await m.logInteraction({ chatId, groupName, isGroup: isGroupMessage, author, incoming: text, action: "silent:no-answer", reply: "" });
    } else {
        console.log(`Reply: ${reply.answer}`);
        await wa.sendWhatsAppMessage(chatId, reply.answer);
        if (isGroupMessage) await m.markGroupReplied(chatId, reply.answer);
        await m.logInteraction({ chatId, groupName, isGroup: isGroupMessage, author, incoming: text, action: "replied", reply: reply.answer });
    }
    await m.updatePreviousMessageId(chatId, reply.responseId);
}

app.post('/whapi', async (req, res) => {
    const groups = req.body.groups;
    if (groups && groups.length) {
        for (const group of groups) {
            const chatId = group.id;
            const isNewGroup = await m.isNewGroup(chatId);
            if (isNewGroup) {
                console.log(`Gepetel was added to a new group: ${group.name}`);
                const participantIds = group.participants.map((participant: any) => participant.id);
                await m.setParticipants(chatId, participantIds);
                const language = m.inferLanguage(u.stripBot(participantIds));
                const reply = await oai.generateGroupGreeting(group.name, language);
                await wa.sendWhatsAppMessage(chatId, reply.answer);
                await m.markGroupReplied(chatId, reply.answer);
                await m.updatePreviousMessageId(chatId, reply.responseId);
                await m.logInteraction({ chatId, groupName: group.name, isGroup: true, author: "", incoming: "(added to group)", action: "greeting", reply: reply.answer });
                res.status(200).json({ status: 'success' });
                return;
            }
        }
    }
    //console.log(JSON.stringify(req.body, null, 2));

    // Poll votes arrive as message updates (requires "Messages PATCH" mode in the
    // whapi webhook settings). The updated poll message carries the full tally.
    const updates = req.body.messages_updates;
    if (updates && updates.length) {
        for (const upd of updates) {
            const pollMsg = [upd?.after_update, upd?.message, upd].find(
                (c: any) => c && c.type === "poll" && c.poll && Array.isArray(c.poll.results)
            );
            if (pollMsg) {
                try {
                    await m.recordPollVotes(pollMsg.id, pollMsg.poll);
                } catch (error) {
                    console.error("Error recording poll votes:", error);
                }
            }
        }
    }

    const messages = req.body.messages;
    if (messages && messages.length) {
        for (const message of messages) {
            if (!message.from_me) {
                const chatId = message.chat_id;
                let text = '';
                // Image extraction can fail (bad preview, model error); never let
                // that crash the webhook — fall back to a neutral placeholder.
                const describe = async (preview: string) => {
                    try { return await oai.getImageDescription(preview); }
                    catch (e) { console.error("getImageDescription failed:", e); return "an image"; }
                };
                if (message.text && message.text.body) {
                    text = message.text.body;
                } else if (message.gif && message.gif.preview) {
                    text = await describe(message.gif.preview);
                    if (message.gif.caption) text += ` (${message.gif.caption})`;
                } else if (message.image && message.image.preview) {
                    // Prefer the full-res link (Auto Download) over the thumbnail.
                    const src = message.image.link || message.image.preview;
                    try { await m.setLastImage(chatId, src); } catch (e) { /* non-critical */ }
                    text = await describe(src);
                    if (message.image.caption) text += ". " + message.image.caption;
                } else if ((message.voice && message.voice.link) || (message.audio && message.audio.link)) {
                    // Voice/audio note -> transcribe and treat as the sender's words.
                    const link = (message.voice || message.audio).link;
                    try {
                        text = await oai.transcribeVoice(link);
                    } catch (e) {
                        console.error("transcribeVoice failed:", e);
                        continue; // can't read it -> ignore rather than reply blind
                    }
                    if (!text) continue;
                    // A voice note can't type "@", so let a spoken "Gepetel" count as a mention.
                    text = text.replace(/\bgepetel\b/gi, "@gepetel");
                } else if (message.link_preview) {
                    text = message.link_preview.title;
                    if (message.link_preview.description) {
                        text += ". " + message.link_preview.description;
                    } else if (message.link_preview.preview) {
                        text += ". " + await describe(message.link_preview.preview);
                    }
                } else {
                    console.error(message);
                    // ignore
                    continue;
                }

                const groupName = message.chat_name;
                const author = message.from_name;

                try {
                    await processIncomingMessage(chatId, text, author, groupName, message.id);
                    await m.updatePeople({phoneNumber: message.from, name: author});
                } catch (error) {
                    console.error(`Error processing message from ${author} in chat ${chatId}:`, error);
                }
            }
        }
    }

    res.status(200).json({ status: 'success' });
});

// Escape user content before putting it into the review HTML.
function escapeHtml(s: any): string {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Basic-auth gate for the review pages (password = CRON_SECRET, any username).
function reviewAuthOk(req: any, res: any): boolean {
    const expected = process.env.CRON_SECRET || "";
    const hdr = req.get("authorization") || "";
    if (expected && hdr.startsWith("Basic ")) {
        const pass = Buffer.from(hdr.slice(6), "base64").toString().split(":")[1] || "";
        if (pass === expected) return true;
    }
    res.set("WWW-Authenticate", 'Basic realm="gepetel-review"');
    res.status(401).send("Authentication required");
    return false;
}

app.get('/groups/', async (req, res) => {
    if (!reviewAuthOk(req, res)) return;
    const gl = await m.getGroupList();

    res.send(`
        <!DOCTYPE html>
        <html lang="en"><head><meta charset="UTF-8"><title>Groups</title>
        <style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem}a{color:#0a58ca;text-decoration:none}li{margin:.3rem 0}</style>
        </head><body>
            <h1>Groups</h1>
            <ul>
                ${gl.map(g => `<li><a href="/groups/${g._id}">${escapeHtml(g.chatId)}</a> — ${g.numParticipants} participants</li>`).join('')}
            </ul>
        </body></html>
    `);
});

app.get('/groups/:id', async (req, res) => {
    if (!reviewAuthOk(req, res)) return;
    const groupId = req.params.id;
    const group = await m.getGroupById(groupId);
    if (!group) {
        res.status(404).send('Group not found');
        return;
    }
    const interactions = await m.getInteractions(group.chatId, 300);

    const rows = interactions.map((it: any) => {
        const when = new Date(it.createdAt).toISOString().replace('T', ' ').slice(0, 16);
        const replied = it.action === "replied" || it.action === "greeting" || it.action === "unprompted";
        const actionColor = replied ? "#0a7d28" : "#888";
        return `<tr style="border-top:1px solid #eee;vertical-align:top">
            <td style="white-space:nowrap;color:#888;padding:.4rem .6rem .4rem 0">${when}</td>
            <td style="padding:.4rem .6rem .4rem 0"><b>${escapeHtml(it.author || "—")}</b><br><span style="color:#333">${escapeHtml(it.incoming)}</span></td>
            <td style="padding:.4rem 0"><span style="color:${actionColor};font-size:.8em">${escapeHtml(it.action)}</span>${it.reply ? `<br><span style="color:#0a58ca">${escapeHtml(it.reply)}</span>` : ""}</td>
        </tr>`;
    }).join('');

    res.send(`
        <!DOCTYPE html>
        <html lang="en"><head><meta charset="UTF-8"><title>${escapeHtml(group.chatId)}</title>
        <style>body{font-family:system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}a{color:#0a58ca;text-decoration:none}</style>
        </head><body>
            <p><a href="/groups/">← all groups</a></p>
            <h1>${escapeHtml(group.chatId)}</h1>
            <p>${group.numParticipants} participants · last checked ${escapeHtml(group.lastChecked)}</p>
            <p style="margin:.6rem 0"><input id="message" placeholder="send a test message…" style="width:60%;padding:.4rem"/> <button onclick="sendMessage()">Send</button></p>
            <h2 style="margin-top:1.5rem">Last 2 weeks (${interactions.length})</h2>
            <table>${rows || '<tr><td style="color:#888;padding:1rem 0">No interactions logged yet.</td></tr>'}</table>
            <script>
                async function sendMessage() {
                    const message = document.getElementById('message').value;
                    const r = await fetch(window.location.pathname, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message }) });
                    alert(await r.text()); location.reload();
                }
            </script>
        </body></html>
    `);
});

app.post('/groups/:id', async (req, res) => {
    if (!reviewAuthOk(req, res)) return;
    const groupId = req.params.id;
    const g = await m.getGroupById(groupId);
    const text = req.body.message;
    const from = "me";
    try {
        const reply = await processIncomingMessage(g?.chatId || '', text, from, 'groupName', '1234567890');
        res.send(reply);
    } catch (error) {
        console.error(`Error processing test message in group ${groupId}:`, error);
        res.status(500).json({ error: 'Failed to process message' });
    }
});

// Cron endpoint: delivers due reminders. Called hourly by Cloud Scheduler,
// which authenticates with a shared secret in the X-Cron-Key header.
app.post('/cron/fire-reminders', async (req, res) => {
    if (!process.env.CRON_SECRET || req.get('X-Cron-Key') !== process.env.CRON_SECRET) {
        res.status(403).json({ error: 'forbidden' });
        return;
    }
    try {
        const result = await m.fireDueReminders(wa.sendWhatsAppMessage);
        console.log(`Cron fire-reminders: due=${result.due} fired=${result.fired}`);
        res.json({ status: 'ok', ...result });
    } catch (error) {
        console.error('Error firing reminders:', error);
        res.status(500).json({ error: 'Failed to fire reminders' });
    }
});

// Cron endpoint: sends unprompted, gossipy conversation starters to groups that
// are due and currently active. Called hourly by Cloud Scheduler.
app.post('/cron/unprompted', async (req, res) => {
    if (!process.env.CRON_SECRET || req.get('X-Cron-Key') !== process.env.CRON_SECRET) {
        res.status(403).json({ error: 'forbidden' });
        return;
    }
    try {
        const groups = await m.getGroupsDueForUnprompted(10);
        const nowHourUTC = new Date().getUTCHours();
        let sent = 0;
        for (const g of groups) {
            try {
                // Safety: never post outside the group's active hours (no 4am gossip).
                const active = u.activeHoursFromHistogram(g.activityByHour);
                if (active && !active.topHoursUTC.includes(nowHourUTC)) {
                    console.log(`Unprompted skip ${g.chatId}: hour ${nowHourUTC} UTC outside active hours.`);
                    continue; // try again next hour; do NOT reschedule
                }
                const members = u.stripBot(g.participants);
                const region = m.inferRegion(members);
                const language = m.inferLanguage(members);
                const topics = await m.getRecentMemoriesText(g.chatId);
                const gossip = await oai.generateGossip(region, language, topics, g.previousMessageId);
                if (gossip.answer && !gossip.answer.toLowerCase().includes("no answer")) {
                    console.log(`Unprompted -> ${g.chatId} (${region}/${language}): ${gossip.answer}`);
                    await wa.sendWhatsAppMessage(g.chatId, gossip.answer);
                    await m.markGroupReplied(g.chatId, gossip.answer);
                    await m.updatePreviousMessageId(g.chatId, gossip.responseId);
                    await m.logInteraction({ chatId: g.chatId, groupName: "", isGroup: true, author: "", incoming: "(unprompted)", action: "unprompted", reply: gossip.answer });
                    sent++;
                }
            } catch (error) {
                console.error(`Unprompted failed for ${g.chatId}:`, error);
            }
            // Roll the next slot, so a dud doesn't retry every hour.
            await m.scheduleNextUnprompted(g.chatId);
        }
        console.log(`Cron unprompted: due=${groups.length} sent=${sent}`);
        res.json({ status: 'ok', due: groups.length, sent });
    } catch (error) {
        console.error('Error in unprompted cron:', error);
        res.status(500).json({ error: 'Failed to run unprompted cron' });
    }
});

// Register the Express app as a Google Cloud Function (gen2) entry point.
http("app", app);

// When not running inside Cloud Run / Cloud Functions, start a local server.
if (!process.env.K_SERVICE) {
    const PORT = process.env.PORT || 8080;
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}
