// What the schedulers call: the hourly tick (reminders, scheduled tasks,
// outreach follow-ups and summaries) and the unprompted posts — plus the
// growth opener, which a group mention sends. Moved out of app.ts as it was
// (2026-10-15); app.ts mounts it with registerCronRoutes.
import express from "express";
import wa from "./wa.js";
import oai from "./oai.js";
import m from "./mongo.js";
import u from "./util.js";
import tg from "./telegram.js";
import { sayAndRemember } from "./say.js";

const router = express.Router();

// Growth: a frequent group member is written to privately — with a plain hello
// and nothing else. Whether the idea of another group ever comes up is decided
// later, inside the conversation this opens (growth-warmup.txt,
// mongo.noteOutreachReply); it never travels in this message.
// mongo.recordUserMention atomically claims each outreach against a single
// mention, so concurrent messages can never produce two. Up to
// GROWTH_MAX_NUDGES over a person's lifetime, spaced by a long cooldown and
// gated on fresh engagement — see recordUserMention for the exact rules.
export async function sendGrowthOpener(authorPhone: string, name: string, attempt: number = 1) {
    const to = String(authorPhone || "").replace(/\D/g, "");
    if (!to) return;
    const language = u.inferLanguage([to]);
    const timezone = u.inferTimezone([to]);
    // The group they know him from: the hook for the hello, and what he can ask
    // them about once they reply.
    const shared = await m.recentSharedGroup(to).catch(() => ({ name: "", chatId: "" }));
    const groupName = shared.name;
    await m.setOutreachGroup(to, groupName, shared.chatId);
    const opener = await oai.generateGrowthOpener(u.firstName(name), groupName, language, timezone, attempt);
    // Through sayAndRemember, and addressed the way a 1:1 chat is addressed, so
    // the hello lands in the same archive their reply will be read against.
    // Sent bare, it left the model answering a message it could not see.
    const chatId = `${to}@s.whatsapp.net`;
    await sayAndRemember(chatId, opener.answer);
    await m.logInteraction({ chatId, groupName: "", isGroup: false, author: name, incoming: "(growth opener)", action: "growth-opener", reply: opener.answer });
    console.log(`Growth opener #${attempt} sent to ${to} (hook: ${groupName || "none"})`);
}

// A chat he opened that has trailed off gets picked up once, and at most twice,
// the way a person would — then he leaves it alone. Everything that decides
// whether one is owed (the gap, the cap, civilised hours, whether they asked
// him to stop, whether the last word was actually his) lives in
// mongo.claimDueOutreachFollowUps, which claims each one before it is sent.
async function sendOutreachFollowUps(): Promise<number> {
    const due = await m.claimDueOutreachFollowUps();
    let sent = 0;
    for (const person of due) {
        try {
            const language = u.inferLanguage([person.phone]);
            const timezone = u.inferTimezone([person.phone]);
            const row: any = await m.getOutreachState(person.phone).catch(() => null);
            const note = await oai.generateOutreachFollowUp(
                u.firstName(person.name), person.groupName, person.lastLine, language, timezone,
                person.attempt, Number(row?.outreachReplies || 0),
            );
            if (!note.answer) continue;
            const chatId = `${person.phone}@s.whatsapp.net`;
            if (await sayAndRemember(chatId, note.answer)) {
                await m.logInteraction({ chatId, groupName: "", isGroup: false, author: person.name, incoming: "(outreach follow-up)", action: "growth-followup", reply: note.answer });
                console.log(`Outreach follow-up #${person.attempt} sent to ${chatId}`);
                sent++;
            }
        } catch (e) {
            console.error(`Outreach follow-up for ${person.phone} failed:`, e);
        }
    }
    if (due.length) console.log(`Outreach follow-ups: due=${due.length} sent=${sent}`);
    return sent;
}

// Every conversation Gepetel starts himself gets reported to the operator once
// it's over — how the person took it, what they said about having him in their
// group, whether the subject of another group came up and how it landed.
//
// Anonymous, and not as a courtesy: the transcript is stripped of the person's
// name, their group's name, numbers, emails and links before the model ever
// sees it (mongo.claimDueOutreachSummaries), and the prompt is told to keep it
// that way. The operator learns how the outreach is going, not who it was with.
async function reportFinishedOutreach(): Promise<number> {
    if (!tg.isConfigured()) return 0;
    const due = await m.claimDueOutreachSummaries();
    let sent = 0;
    for (const conversation of due) {
        try {
            const summary = await oai.summariseOutreach(conversation.handle, conversation.replies, conversation.transcript);
            if (!summary) continue;
            await tg.notify(`\u{1F4AC} *A chat Gepetel started has ended*\n\n${tg.escapeMarkdown(summary)}`);
            sent++;
        } catch (e) {
            console.error(`Outreach summary for ${conversation.handle} failed:`, e);
        }
    }
    if (due.length) console.log(`Outreach summaries: due=${due.length} sent=${sent}`);
    return sent;
}

// Shared secret guarding the /cron/* routes, accepted two ways because the two
// schedulers can send it two different ways: Cloud Scheduler sets the X-Cron-Key
// header, while the Pi's cron dispatcher can only send a JSON body. Same secret,
// same strength — and deliberately NOT a query parameter, which would end up in
// every access log along the way.
export function cronKeyOk(req: express.Request): boolean {
    const supplied = req.get('X-Cron-Key') || (req.body && req.body.key);
    return u.secretEquals(supplied, process.env.CRON_SECRET);
}

// Cron endpoint: delivers due reminders. Called hourly by whichever scheduler is
// live — Cloud Scheduler on GCP, the Pi's own dispatcher on the box.
router.post('/cron/fire-reminders', async (req, res) => {
    if (!cronKeyOk(req)) {
        res.status(403).json({ error: 'forbidden' });
        return;
    }
    try {
        // Through sayAndRemember, so a reminder is archived, tags whoever it names,
        // and opens the follow-up window like anything else he says in a group.
        const result = await m.fireDueReminders(sayAndRemember);
        console.log(`Cron fire-reminders: due=${result.due} fired=${result.fired}`);
        // Scheduled tasks ride the same hourly tick, so no extra Cloud Scheduler
        // job is needed. Their failures must not fail the reminders run.
        let scheduled: any = null;
        try {
            scheduled = await runScheduledTasks();
        } catch (e) {
            console.error('Error firing scheduled tasks:', e);
        }
        // Nudges first, summaries second: a conversation still owed a nudge is
        // not finished, and reporting it as finished would close it early.
        let outreachFollowUps = 0;
        try {
            outreachFollowUps = await sendOutreachFollowUps();
        } catch (e) {
            console.error('Error sending outreach follow-ups:', e);
        }
        let outreachSummaries = 0;
        try {
            outreachSummaries = await reportFinishedOutreach();
        } catch (e) {
            console.error('Error summarising outreach:', e);
        }
        res.json({ status: 'ok', ...result, scheduled, outreachFollowUps, outreachSummaries });
    } catch (error) {
        console.error('Error firing reminders:', error);
        res.status(500).json({ error: 'Failed to fire reminders' });
    }
});

// How a scheduled task reaches the outside world. `generate` covers the kinds
// whose text isn't fixed up front (`generated`); the group's own language and
// region are resolved here so the model writes the way that group talks.
export function scheduledTaskDeps() {
    return {
        sendMessage: wa.sendWhatsAppMessage,
        sendPoll: wa.sendWhatsAppPoll,
        supportsMentions: wa.supportsMentions(),
        checkGroup: (chatId: string) => wa.getGroupInfo(chatId),
        alertPaused: async ({ task, group, reason }: { task: any; group: any; reason: string }) => {
            const e = tg.escapeMarkdown;
            await tg.notify(`⏸ Scheduled task auto-paused\n*${e(task.title || "")}* (${e(task.kind || "")})\nGroup: ${e(group?.name || "?")} (${e(task.chat_id)})\nReason: ${e(reason)}\nReactivate at /scheduled-tasks/`);
        },
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
    console.log(`Scheduled tasks: due=${result.due} fired=${result.fired} skipped=${result.skipped} failed=${result.failed} missed=${result.missed}`);
    return result;
}

// Manual trigger for the same work — handy for testing a task without waiting
// for its hour, and lets scheduled tasks be split onto their own (finer) cron
// later without touching any code.
router.post('/cron/scheduled-tasks', async (req, res) => {
    if (!cronKeyOk(req)) {
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
router.post('/cron/unprompted', async (req, res) => {
    if (!cronKeyOk(req)) {
        res.status(403).json({ error: 'forbidden' });
        return;
    }
    try {
        const groups = await m.getGroupsDueForUnprompted(10);
        const nowHourUTC = new Date().getUTCHours();
        let sent = 0;
        for (const g of groups) {
            try {
                // Defence in depth: the query already excludes these.
                if (u.inUnpromptedCooldown(g)) {
                    console.log(`Unprompted skip ${g.chatId}: in cooldown until ${new Date(g.unpromptedCooldownUntil as any).toISOString()}.`);
                    continue; // do NOT reschedule: the cooldown already moved the slot
                }
                // Safety: never post outside the group's active hours (no 4am gossip).
                const active = u.activeHoursFromHistogram(g.activityByHour);
                if (active && !active.topHoursUTC.includes(nowHourUTC)) {
                    console.log(`Unprompted skip ${g.chatId}: hour ${nowHourUTC} UTC outside active hours.`);
                    continue; // try again next hour; do NOT reschedule
                }
                const members = u.stripBot(g.participants);
                const region = m.inferRegion(members);
                const language = u.inferLanguage(members);
                const topics = await m.getRecentMemoriesText(g.chatId);
                // Recent not-yet-ingested messages anchor the gossip in what the
                // group is actually talking about (peek only — reply flow ingests them).
                const cached = await m.getCachedMessages(g.chatId);
                const recent = cached.slice(-30);
                // Same clock the reply window carries, for the same reason — and it
                // matters most here. This fires on a SCHEDULE into a silent group, so
                // the newest line can be days old; without the gaps Gepetel opened
                // with "la avionul de la 12" four days after that flight had left.
                const lines: string[] = [];
                let prevAt: Date | undefined;
                for (const msg of recent as any[]) {
                    const at = msg.timestamp ? new Date(msg.timestamp) : undefined;
                    const gap = u.gapMarker(prevAt, at);
                    if (gap) lines.push(gap);
                    prevAt = at || prevAt;
                    lines.push(`${msg.from}: ${String(msg.text).slice(0, 300)}`);
                }
                // How stale the room is at the moment of speaking. This is the line
                // that stops him treating an old plan as something happening today.
                if (prevAt) {
                    const since = Date.now() - prevAt.getTime();
                    if (since >= u.CONVERSATION_GAP_MS) {
                        lines.push(`[nobody has said anything for ${u.humanGap(since)} — everything above is OLD]`);
                    }
                }
                const conversation = lines.join("\n");
                const gossip = await oai.generateGossip(g.name || "", region, language, topics, conversation, u.inferTimezone(members));
                if (gossip.answer && !gossip.answer.toLowerCase().includes("no answer")) {
                    console.log(`Unprompted -> ${g.chatId} (${region}/${language}): ${gossip.answer}`);
                    await sayAndRemember(g.chatId, gossip.answer);
                    await m.markGroupReplied(g.chatId, gossip.answer);
                    await m.openUnpromptedWatch(g.chatId, gossip.answer);
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

export function registerCronRoutes(app: express.Express): void {
    app.use(router);
}

export default { registerCronRoutes, sendGrowthOpener, scheduledTaskDeps, cronKeyOk };
