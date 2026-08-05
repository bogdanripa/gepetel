import express from "express";
import { http } from "@google-cloud/functions-framework";
import wa from "./wa.js";
import oai from "./oai.js";
import m from "./mongo.js";
import u from "./util.js";
import tg from "./telegram.js";
import type { WaGroupEvent, WaIncomingMessage } from "./watypes.js";

// app
const app = express();
app.use(express.json());

// Growth nudge: a frequent group member gets a one-time DM inviting them to add
// Gepetel to their other group chats. mongo.recordUserMention atomically claims
// the nudge for exactly one mention, so this fires at most once per person.
async function sendGrowthNudge(authorPhone: string, name: string) {
    const to = String(authorPhone || "").replace(/\D/g, "");
    if (!to) return;
    const language = u.inferLanguage([to]);
    const timezone = u.inferTimezone([to]);
    const nudge = await oai.generateGrowthNudge(name || "", language, timezone);
    await wa.sendWhatsAppMessage(to, nudge.answer);
    await m.logInteraction({ chatId: to, groupName: "", isGroup: false, author: name, incoming: "(growth nudge)", action: "growth-nudge", reply: nudge.answer });
    console.log(`Growth nudge sent to ${to}`);
}

async function processIncomingMessage(chatId: string, text: string, author: string, groupName: string | undefined, messageId: string, authorPhone: string = "") {
    text = u.normalizeMentions(text);
    console.log(`Message from ${author}: ${text}`);
    const isGroupMessage = u.isGroupChatId(chatId);
    const mentioned = !isGroupMessage || u.isMentioned(text);

    // Track when this group is active (UTC hour histogram) for timing unprompted messages.
    await m.recordActivity(chatId);

    // Count every group mention/tag for the growth nudge, regardless of whether we
    // end up replying (gate/daily-limit may stop us below). If this mention crosses
    // the threshold, DM the user once. Failures here never block the group reply.
    if (isGroupMessage && mentioned && authorPhone) {
        try {
            const { claimedNudge } = await m.recordUserMention(authorPhone);
            if (claimedNudge) await sendGrowthNudge(authorPhone, author);
        } catch (e) { console.error("growth nudge failed:", e); }
    }

    // Mark the incoming message as read first (we've seen it).
    try { await wa.markAsRead(messageId); } catch (e) { /* non-critical */ }

    let shouldReply = true;          // 1:1 and explicit mentions always reply
    let numUnsentMessages = 0;
    let participants: any[] = [];
    let groupPreviousMessageId = "";

    let silentReason = "not-mentioned";
    if (isGroupMessage) {
        const meta = await m.getGroupMetadata(chatId);
        numUnsentMessages = meta.numUnsentMessages;
        participants = meta.participants || [];
        groupPreviousMessageId = meta.previousMessageId || "";

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
        // Quiet mode: just cache the message. We do NOT ingest anything into the
        // OpenAI conversation now — that's deferred until Gepetel actually wakes up,
        // at which point generateGroupReply pulls the cached (un-ingested) messages
        // into the thread and continues from there.
        console.log("Staying quiet, caching message.");
        await m.saveMessage(chatId, author, text);
        await m.logInteraction({ chatId, groupName, isGroup: isGroupMessage, author, incoming: text, action: `silent:${silentReason}`, reply: "" });
        return;
    }

    // Daily reply limit (group chats only). Two warnings are sent once the limit
    // is hit; after that the bot goes completely silent until the UTC day resets.
    if (isGroupMessage) {
        const limitStatus = await m.checkDailyLimit(chatId);
        if (limitStatus.limitReached) {
            // Atomically claim a warning slot so we never exceed two warnings,
            // even if several messages arrive concurrently after the limit hits.
            if (await m.claimDailyLimitWarning(chatId)) {
                const members = u.stripBot(participants);
                const limitMsg = await oai.generateDailyLimitMessage(
                    u.inferLanguage(members),
                    groupPreviousMessageId,
                    u.inferTimezone(members)
                );
                await wa.sendWhatsAppMessage(chatId, limitMsg.answer);
                await m.markGroupReplied(chatId, limitMsg.answer);
                await m.updatePreviousMessageId(chatId, limitMsg.responseId);
                await m.logInteraction({ chatId, groupName, isGroup: true, author, incoming: text, action: "silent:daily-limit", reply: limitMsg.answer });
            } else {
                await m.logInteraction({ chatId, groupName, isGroup: true, author, incoming: text, action: "silent:daily-limit", reply: "" });
            }
            return;
        }
    }

    // We've decided to reply — now show the "typing…" indicator. The message id
    // goes along because wa-gateway types in reply to a message (Meta's model);
    // whapi ignores it and types into the chat.
    await wa.sendTypingIndicator(chatId, messageId);

    // The group's main timezone (1:1: the user's own number, which is the chatId).
    const timezone = isGroupMessage
        ? u.inferTimezone(u.stripBot(participants))
        : u.inferTimezone([chatId]);

    let reply: {answer: string; responseId: string; consumedMessages?: {from: string; text: string; timestamp?: Date}[]};
    const {numberOfParticipants, previousMessageId} = await m.newMessage(chatId, author, text, wa.getGroupInfo, groupName);
    try {
        if (isGroupMessage) {
            reply = await oai.generateGroupReply(chatId, groupName || '', numberOfParticipants, previousMessageId, `${author}: ${text}`, numUnsentMessages, mentioned, timezone);
        } else {
            const userGroups = await m.getGroupsByParticipant(chatId);
            reply = await oai.generateReply(author, text, previousMessageId, timezone, chatId, userGroups);
        }
    } catch (err: any) {
        // An empty OpenAI balance breaks every single reply until a human tops it
        // up. Going quiet would look exactly like Gepetel choosing not to speak —
        // in a 1:1, where he always answers, that reads as "the bot is dead".
        // So say it out loud, once a day per chat, and let people nudge the owner.
        if (!u.isOutOfCredits(err)) throw err;
        const language = isGroupMessage
            ? u.inferLanguage(u.stripBot(participants))
            : u.inferLanguage([chatId]);
        if (await m.claimCreditsNotice(chatId)) {
            await wa.sendWhatsAppMessage(chatId, u.outOfCreditsMessage(language));
        }
        // Deliberately no markGroupReplied: he hasn't actually said anything, and
        // opening the continuation window would just fail the same way 5 minutes on.
        await m.logInteraction({ chatId, groupName, isGroup: isGroupMessage, author, incoming: text, action: "out-of-credits", reply: "" });
        return;
    }
    // In groups Gepetel may still decide there's nothing to add; in a 1:1 he always replies.
    if (isGroupMessage && reply.answer.toLowerCase().includes("no answer")) {
        console.log("No reply generated.");
        await m.logInteraction({ chatId, groupName, isGroup: isGroupMessage, author, incoming: text, action: "silent:no-answer", reply: "" });
    } else {
        console.log(`Reply: ${reply.answer}`);
        await wa.sendWhatsAppMessage(chatId, reply.answer);
        if (isGroupMessage) {
            await m.markGroupReplied(chatId, reply.answer);
            await m.incrementDailyReplyCount(chatId);
        }
        await m.logInteraction({ chatId, groupName, isGroup: isGroupMessage, author, incoming: text, action: "replied", reply: reply.answer });
    }
    await m.updatePreviousMessageId(chatId, reply.responseId);
}

// Membership/name changes for the groups Gepetel is in. Returns true when it
// greeted a group, which ends the webhook (as it always has: a fresh join is the
// only thing worth doing in that delivery).
async function handleGroupEvents(groups: WaGroupEvent[]): Promise<boolean> {
    for (const group of groups) {
        const chatId = group.id;
        // Learn any names carried in the group payload.
        for (const p of (group.participants || [])) {
            const nm = p?.name;
            if (p?.id && nm) { try { await m.updatePeople({ phoneNumber: p.id, name: nm }); } catch (e) {} }
        }
        const existing: any = await m.getGroupByChatId(chatId);
        const isNewGroup = !existing;

        // Authoritative roster + name + whether Gepetel is currently a member.
        let info: any = null;
        try { info = await wa.getGroupInfo(chatId); } catch (e) { console.error("getGroupInfo failed:", e); }
        const participantIds = (info && info.participants.length)
            ? info.participants
            : (group.participants || []).map((p: any) => p.id);
        const resolvedName = (info && info.name) || group.name || existing?.name || "";
        const botIn = participantIds.some((id: any) => u.BOT_PHONE_DIGITS.includes(String(id).replace(/\D/g, "")));

        if (!botIn) {
            // Gepetel was removed — remember it so the next add greets again.
            if (existing) await m.setBotPresent(chatId, false);
            console.log(`Gepetel is no longer a member of ${chatId}.`);
            continue;
        }

        await m.setParticipants(chatId, participantIds, resolvedName);

        // Greet on a genuine (re-)join: brand-new group, an observed re-add, or a
        // long-dormant group Gepetel was clearly just added back to.
        const lastReplyMs = existing?.lastReplyAt ? Date.now() - new Date(existing.lastReplyAt).getTime() : Infinity;
        const shouldGreet = isNewGroup || existing?.botPresent === false || lastReplyMs > 12 * 60 * 60 * 1000;

        if (shouldGreet) {
            console.log(`Greeting group ${chatId} ("${resolvedName}").`);
            const members = u.stripBot(participantIds);
            const language = m.inferLanguage(members);

            // Tell the operator he's in a new room. Only for genuinely new
            // groups — a re-add or a group waking up after a quiet day also
            // greets, and pinging for those would just be noise.
            if (isNewGroup) {
                tg.notify(
                    `👋 *Gepetel was added to a new group*\n\n` +
                    `*${tg.escapeMarkdown(resolvedName || "(unnamed group)")}*\n` +
                    `${members.length} member${members.length === 1 ? "" : "s"} · ${m.inferRegion(members)} · ${language}`
                ).catch(() => {});   // never let a notification break the greeting
            }

            const reply = await oai.generateGroupGreeting(resolvedName, language, u.inferTimezone(members));
            await wa.sendWhatsAppMessage(chatId, reply.answer);
            await m.markGroupReplied(chatId, reply.answer);
            await m.setBotPresent(chatId, true);
            await m.updatePreviousMessageId(chatId, reply.responseId);
            await m.logInteraction({ chatId, groupName: resolvedName, isGroup: true, author: "", incoming: "(added to group)", action: "greeting", reply: reply.answer });
            return true;
        }
        // Routine membership/name change — roster already refreshed above.
        await m.setBotPresent(chatId, true);
    }
    return false;
}

// One inbound message, already normalized by the provider.
async function handleIncomingMessage(message: WaIncomingMessage) {
    // Idempotency: both providers redeliver on any timeout/5xx. Skip a message
    // id we've already handled so Gepetel never replies (or counts) twice.
    if (!(await m.markMessageProcessed(message.id))) {
        console.log(`Duplicate webhook for message ${message.id}, skipping.`);
        return;
    }
    const chatId = message.chatId;
    let text = '';
    // Image extraction can fail (bad preview, model error); never let
    // that crash the webhook — fall back to a neutral placeholder.
    const describe = async (preview: string) => {
        try { return await oai.getImageDescription(preview); }
        catch (e) { console.error("getImageDescription failed:", e); return "an image"; }
    };
    if (message.text) {
        text = message.text;
    } else if (message.gif) {
        text = await describe(message.gif.link);
        if (message.gif.caption) text += ` (${message.gif.caption})`;
    } else if (message.image) {
        try { await m.setLastImage(chatId, message.image.link); } catch (e) { /* non-critical */ }
        text = await describe(message.image.link);
        if (message.image.caption) text += ". " + message.image.caption;
    } else if (message.voice) {
        // Voice/audio note -> transcribe and treat as the sender's words.
        try {
            text = await oai.transcribeVoice(message.voice.link);
        } catch (e) {
            console.error("transcribeVoice failed:", e);
            return; // can't read it -> ignore rather than reply blind
        }
        if (!text) return;
        // A voice note can't type "@", so let a spoken "Gepetel" count as a mention.
        text = text.replace(/\bgepetel\b/gi, "@gepetel");
    } else if (message.linkPreview) {
        text = message.linkPreview.title;
        if (message.linkPreview.description) {
            text += ". " + message.linkPreview.description;
        } else if (message.linkPreview.preview) {
            text += ". " + await describe(message.linkPreview.preview);
        }
    } else {
        console.error(message.raw ?? message);
        // unsupported type -> ignore
        return;
    }

    const author = message.fromName;
    try {
        await processIncomingMessage(chatId, text, author, message.chatName, message.id, message.from);
        await m.updatePeople({ phoneNumber: message.from, name: author });
    } catch (error) {
        console.error(`Error processing message from ${author} in chat ${chatId}:`, error);
    }
}

// The inbound webhook. Both providers post here: whapi's flat payload and
// wa-gateway's Meta-shaped envelope are told apart by wa.parseWebhook, so a
// webhook still pointed at the old provider keeps working across the switch.
async function handleWebhook(req: express.Request, res: express.Response) {
    if (!wa.webhookAuthOk(req)) {
        console.error("Rejected a webhook delivery: X-Wa-Gateway-Token doesn't match.");
        res.status(401).json({ error: 'unauthorized' });
        return;
    }

    const events = wa.parseWebhook(req.body);

    if (await handleGroupEvents(events.groups)) {
        res.status(200).json({ status: 'success' });
        return;
    }

    // Contact updates (name/profile changes) — keep stored member names fresh even
    // for people who don't message. On whapi this needs the "contacts" event enabled.
    for (const c of events.contacts) {
        if (c.id && c.name) { try { await m.updatePeople({ phoneNumber: c.id, name: c.name }); } catch (e) { console.error("contact update failed:", e); } }
    }

    // Poll votes. Each update carries the full current tally for that poll.
    for (const p of events.polls) {
        try {
            await m.recordPollVotes(p.id, p.poll);
        } catch (error) {
            console.error("Error recording poll votes:", error);
        }
    }

    for (const message of events.messages) {
        await handleIncomingMessage(message);
    }

    res.status(200).json({ status: 'success' });
}

// `/whapi` is where whapi.cloud has always posted; `/wa` is the provider-neutral
// name to point wa-gateway (or anything later) at. Both do the same thing.
app.post('/whapi', handleWebhook);
app.post('/wa', handleWebhook);

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
        const replied = it.action === "replied" || it.action === "greeting" || it.action === "unprompted" || it.action === "scheduled";
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

// --- Scheduled tasks (admin) ---
// Recurring things Gepetel posts into a group (poll / fixed message / generated).
// Normally created from a 1:1 chat; these routes exist to inspect and debug them.

app.get('/scheduled-tasks/', async (req, res) => {
    if (!reviewAuthOk(req, res)) return;
    const chatId = typeof req.query.chatId === "string" ? req.query.chatId : undefined;
    const tasks = await m.listScheduledTasks(chatId, { admin: true });

    if (req.get("accept")?.includes("application/json")) {
        res.json({ tasks });
        return;
    }

    const rows = tasks.map((t: any) => `<tr style="border-top:1px solid #eee;vertical-align:top">
        <td style="padding:.4rem .6rem .4rem 0"><b>${escapeHtml(t.title)}</b><br>
            <span style="color:#888;font-size:.85em">${escapeHtml(t.kind)} · ${escapeHtml(t.chat_id)}</span></td>
        <td style="padding:.4rem .6rem .4rem 0;white-space:nowrap">${escapeHtml(t.schedule)}</td>
        <td style="padding:.4rem .6rem .4rem 0;color:${t.active ? "#0a7d28" : "#888"}">${t.active ? "active" : "paused"}<br>
            <span style="color:#888;font-size:.85em">${t.last_fired_at ? "last: " + new Date(t.last_fired_at).toISOString().replace("T", " ").slice(0, 16) : "never fired"}</span></td>
        <td style="padding:.4rem 0;white-space:nowrap"><button onclick="run('${escapeHtml(t.task_id)}')">run now</button> <button onclick="del('${escapeHtml(t.task_id)}')">delete</button></td>
    </tr>`).join('');

    res.send(`
        <!DOCTYPE html>
        <html lang="en"><head><meta charset="UTF-8"><title>Scheduled tasks</title>
        <style>body{font-family:system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}a{color:#0a58ca;text-decoration:none}</style>
        </head><body>
            <p><a href="/groups/">← all groups</a></p>
            <h1>Scheduled tasks (${tasks.length})</h1>
            <table>${rows || '<tr><td style="color:#888;padding:1rem 0">Nothing scheduled yet.</td></tr>'}</table>
            <script>
                async function run(id) {
                    if (!confirm('Post this into the group right now?')) return;
                    const r = await fetch('/scheduled-tasks/' + id + '/run', { method: 'POST' });
                    alert(await r.text()); location.reload();
                }
                async function del(id) {
                    if (!confirm('Delete this scheduled task?')) return;
                    const r = await fetch('/scheduled-tasks/' + id, { method: 'DELETE' });
                    alert(await r.text()); location.reload();
                }
            </script>
        </body></html>
    `);
});

app.post('/scheduled-tasks/', async (req, res) => {
    if (!reviewAuthOk(req, res)) return;
    try {
        const task = await m.createScheduledTask(req.body || {}, { admin: true });
        res.json({ status: 'ok', task });
    } catch (error: any) {
        // Validation errors are the expected case here — surface the message.
        res.status(400).json({ error: String(error?.message || error) });
    }
});

app.delete('/scheduled-tasks/:id', async (req, res) => {
    if (!reviewAuthOk(req, res)) return;
    try {
        res.send(await m.deleteScheduledTask(req.params.id, { admin: true }));
    } catch (error: any) {
        res.status(404).send(String(error?.message || error));
    }
});

// Post a task right now, ignoring its schedule — for testing without waiting for
// its hour. Does not consume the day's slot.
app.post('/scheduled-tasks/:id/run', async (req, res) => {
    if (!reviewAuthOk(req, res)) return;
    try {
        const r = await m.runScheduledTaskNow(req.params.id, scheduledTaskDeps(), { admin: true });
        res.send(r.sent ? `Sent: ${r.text}` : `Not sent (${r.reason})`);
    } catch (error: any) {
        res.status(400).send(String(error?.message || error));
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
        // Scheduled tasks ride the same hourly tick, so no extra Cloud Scheduler
        // job is needed. Their failures must not fail the reminders run.
        let scheduled: any = null;
        try {
            scheduled = await runScheduledTasks();
        } catch (e) {
            console.error('Error firing scheduled tasks:', e);
        }
        res.json({ status: 'ok', ...result, scheduled });
    } catch (error) {
        console.error('Error firing reminders:', error);
        res.status(500).json({ error: 'Failed to fire reminders' });
    }
});

// How a scheduled task reaches the outside world. `generate` covers the kinds
// whose text isn't fixed up front (`generated`); the group's own language and
// region are resolved here so the model writes the way that group talks.
function scheduledTaskDeps() {
    return {
        sendMessage: wa.sendWhatsAppMessage,
        sendPoll: wa.sendWhatsAppPoll,
        generate: async (task: any, group: any) => {
            const members = u.stripBot(group?.participants || []);
            return await oai.generateScheduledContent(task.kind, task.payload, {
                groupName: group?.name || "",
                region: u.inferRegion(members),
                language: u.inferLanguage(members),
                timezone: task.timezone || u.inferTimezone(members),
            });
        },
    };
}

// Shared by the hourly reminders tick and the manual endpoint below.
async function runScheduledTasks() {
    const result = await m.fireDueScheduledTasks(scheduledTaskDeps());
    console.log(`Scheduled tasks: due=${result.due} fired=${result.fired} skipped=${result.skipped} failed=${result.failed}`);
    return result;
}

// Manual trigger for the same work — handy for testing a task without waiting
// for its hour, and lets scheduled tasks be split onto their own (finer) cron
// later without touching any code.
app.post('/cron/scheduled-tasks', async (req, res) => {
    if (!process.env.CRON_SECRET || req.get('X-Cron-Key') !== process.env.CRON_SECRET) {
        res.status(403).json({ error: 'forbidden' });
        return;
    }
    try {
        res.json({ status: 'ok', ...await runScheduledTasks() });
    } catch (error) {
        console.error('Error firing scheduled tasks:', error);
        res.status(500).json({ error: 'Failed to fire scheduled tasks' });
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
                // Recent not-yet-ingested messages anchor the gossip in what the
                // group is actually talking about (peek only — reply flow ingests them).
                const cached = await m.getCachedMessages(g.chatId);
                const conversation = cached.slice(-30)
                    .map((msg: any) => `${msg.from}: ${String(msg.text).slice(0, 300)}`)
                    .join("\n");
                const gossip = await oai.generateGossip(g.name || "", region, language, topics, conversation, g.previousMessageId, u.inferTimezone(members));
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

const MAX_DAILY_LIMIT = 10000;

// Payment callback: adds `additional` messages/day to a group's limit — but ONLY
// ONCE per group (the free extension). Body: { groupId, userId, additional, email }
// — secret in X-Payment-Secret header. Announces in the group and DMs the user.
app.post('/payment/callback', async (req, res) => {
    const secret = req.get('X-Payment-Secret');
    if (!process.env.PAYMENT_SECRET || secret !== process.env.PAYMENT_SECRET) {
        res.status(403).json({ error: 'forbidden' });
        return;
    }
    const { groupId, userId, additional, email } = req.body;
    const add = Number(additional);
    if (!groupId || !userId || ![100, 200, 500].includes(add)) {
        res.status(400).json({ error: 'invalid parameters' });
        return;
    }

    // Apply the extension once (atomic). If already used, tell the caller — it
    // shows "already extended" instead of the on-the-house success.
    let newLimit: number;
    let r: any;
    try {
        r = await m.extendDailyLimitOnce(groupId, add, String(email || ""));
        if (r.notFound) { res.status(404).json({ error: 'group_not_found' }); return; }
    } catch (err) {
        console.error('Payment callback DB error:', err);
        res.status(500).json({ error: 'internal error' });
        return;
    }

    // Ping the creator on EVERY pay attempt (success OR already-extended).
    try {
        const grp: any = await m.getGroupByChatId(groupId);
        const gName = grp?.name || groupId;
        const payer = (await m.getPersonName(userId)) || "Someone";
        await wa.notifyCreator(r.alreadyUsed
            ? `🛒 ${payer} tried to extend "${gName}" (+${add}/day) but it was already extended — no change.${email ? ` Email: ${email}` : ""}`
            : `🛒 ${payer} extended "${gName}" by +${add} → ${r.newLimit} msgs/day.${email ? ` Email: ${email}` : ""}`);
    } catch (e) { console.error("creator attempt ping failed:", e); }

    if (r.alreadyUsed) { res.status(409).json({ error: 'already_extended' }); return; }
    newLimit = r.newLimit!;

    // Notifications are best-effort and run BEFORE we respond: on Cloud Functions
    // gen2 the instance CPU is throttled once the HTTP response is flushed, so any
    // async work awaited after res.json() may never complete. We swallow errors
    // here so a notification failure doesn't turn into a 500 (which would make the
    // provider retry and re-announce the already-applied limit).
    try {
        const group: any = await m.getGroupByChatId(groupId);
        const groupName: string = group?.name || groupId;
        const members = u.stripBot(group?.participants || []);
        const language = u.inferLanguage(members);
        const timezone = u.inferTimezone(members);
        const groupPrevId = group?.previousMessageId || null;

        // Resolve the paying member's display name.
        const userLanguage = u.inferLanguage([userId]);
        const userTimezone = u.inferTimezone([userId]);
        const memberName = (await m.getPersonName(userId)) || "Someone";

        // Announce in the group (don't reset messagesSinceLastSend — not a reactive reply).
        const groupMsg = await oai.generatePaymentGroupMessage(memberName, newLimit, language, groupPrevId, timezone);
        await wa.sendWhatsAppMessage(groupId, groupMsg.answer);
        await m.recordGroupAnnouncement(groupId, groupMsg.answer);
        await m.updatePreviousMessageId(groupId, groupMsg.responseId);
        await m.logInteraction({ chatId: groupId, groupName, isGroup: true, author: "", incoming: "(payment callback)", action: "replied", reply: groupMsg.answer });

        // Confirm to the paying user via DM, continuing their conversation thread.
        const dmGroup: any = await m.getGroupByChatId(userId);
        const dmPrevId = dmGroup?.previousMessageId || null;
        const dmMsg = await oai.generatePaymentDmConfirmation(memberName, groupName, newLimit, userLanguage, dmPrevId, userTimezone);
        await wa.sendWhatsAppMessage(userId, dmMsg.answer);
        await m.updatePreviousMessageId(userId, dmMsg.responseId);
    } catch (err) {
        console.error('Payment callback notification error:', err);
    }

    console.log(`Payment callback: ${userId} extended ${groupId} by +${add} -> ${newLimit} msgs/day`);
    res.json({ status: 'ok', added: add, newLimit });
});

// Public send API: lets an authorised 3rd party post a message to a group, which
// Gepetel then sends verbatim. Auth: X-Api-Key header must equal PUBLIC_API_KEY.
// Body: { groupId, message } where groupId is the WhatsApp chat id (…@g.us).
app.post('/api/send', async (req, res) => {
    const key = req.get('X-Api-Key');
    if (!process.env.PUBLIC_API_KEY || key !== process.env.PUBLIC_API_KEY) {
        res.status(403).json({ error: 'forbidden' });
        return;
    }

    const { groupId, message } = req.body || {};
    const text = String(message ?? "").trim();
    if (!groupId || !u.isGroupChatId(groupId) || !text) {
        res.status(400).json({ error: 'invalid parameters' });
        return;
    }

    // Only groups Gepetel already belongs to — we won't message unknown chats.
    const group: any = await m.getGroupByChatId(groupId);
    if (!group) {
        res.status(404).json({ error: 'group_not_found' });
        return;
    }

    try {
        const ok = await wa.sendWhatsAppMessage(groupId, text);
        if (!ok) {
            res.status(502).json({ error: 'send_failed' });
            return;
        }
        // Treat like a system announcement: refresh lastReply* (so the reply gate
        // knows Gepetel just spoke) without resetting the gossip counter or the
        // OpenAI thread — this isn't a model-generated reactive reply.
        await m.recordGroupAnnouncement(groupId, text);
        await m.logInteraction({ chatId: groupId, groupName: group.name || "", isGroup: true, author: "(api)", incoming: "(api send)", action: "replied", reply: text });
        console.log(`API send -> ${groupId}: ${text}`);
        res.json({ status: 'ok' });
    } catch (error) {
        console.error('API send error:', error);
        res.status(500).json({ error: 'internal error' });
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
