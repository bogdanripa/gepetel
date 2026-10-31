import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { http } from "@google-cloud/functions-framework";
import wa from "./wa.js";
import oai from "./oai.js";
import m from "./mongo.js";
import u from "./util.js";
import tg from "./telegram.js";
import mcp from "./mcp.js";
import { sayAndRemember } from "./say.js";
import turns from "./turn.js";
import device from "./device/routes.js";
import hub from "./device/hub.js";
import goals from "./goals.js";
import jobs from "./device/jobs.js";
import admin from "./admin.js";
import cron, { sendGrowthOpener } from "./cron.js";
import type { WaGroupEvent, WaIncomingMessage } from "./watypes.js";

// app
const app = express();
// Every body is JSON with Express's 100 KB default — except the computer's
// model calls, which carry a page snapshot (and sometimes a screenshot) and
// get their own, larger parser on their route (src/device/llm.ts) — and the
// phone's sign-in form, whose own 8 KB parser (src/device/signin.ts) never
// ran while this one read the body first.
app.use((req, res, next) => req.path === "/device/llm" || req.path.startsWith("/s/") ? next() : express.json()(req, res, next));

// Container healthcheck. Must answer 200 without auth: the Pi probes this path to
// decide whether a new deploy is healthy or should be rolled back, so it must not
// touch the database or any upstream — it answers for THIS process being alive.
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', commit: process.env.GIT_SHA || 'unknown' });
});

// How many recent messages of a chat go to the model each turn. Small on purpose:
// the average archived message is ~50 characters, so 50 of them is under 1k
// tokens — a fixed, knowable cost that cannot grow the way a thread did.
const CONVERSATION_WINDOW = 50;

// After a computer job, the part of the request that's the chat's own: one
// goal, done by the right hand — the browser for the RSVP, the calendar
// connector for the event (the owner, 2026-10-15: "1 task should have been
// executed via desktop, and the 2nd one via mcp"). The job's answer is
// already in the chat; this turn carries on from it.
/** A turn of the chat's own, with no new message from them: after a job, or
 *  once a service is connected — so the request they made goes on instead of
 *  stopping there. Joins a reply already being written. The reply, or "". */
async function followUpTurn(chatId: string, note: string, what: string): Promise<string> {
    // A reply is already being written for this chat (they wrote meanwhile):
    // the note joins it. Starting a turn here would replace that one, and the
    // message it was answering would get no reply.
    if (turns.offerToTurn(chatId, note, true)) {
        console.log(`${what} in ${chatId}: folded into the reply being written.`);
        await m.logInteraction({ chatId, groupName: "", isGroup: false, author: "(gepetel)", incoming: `(${what})`, action: "folded-into-reply", reply: "" });
        return "(folded)";
    }
    const history = await m.getRecentMessages(chatId, CONVERSATION_WINDOW);
    const author = [...history].reverse().find(x => x.from && x.from !== "Gepetel")?.from || "";
    // The open goal goes with it: the turn serves what they asked, not just
    // the event (a connection made, a job done).
    const goal = await goals.getGoal(chatId).catch(() => null);
    const withGoal = goal ? `${note}\n${goals.goalNote(goal)}` : note;
    const reply = await turns.withTurn(chatId, async turn =>
        oai.generateReply(author, withGoal, history, u.inferTimezone([chatId]), chatId, await m.getGroupsByParticipant(chatId), null, turn));
    console.log(`${what} in ${chatId}: ${reply.answer.slice(0, 200)}`);
    if (reply.answer.trim()) await sayAndRemember(chatId, reply.answer);
    await m.logInteraction({ chatId, groupName: "", isGroup: false, author: "(gepetel)", incoming: `(${what})`, action: what, reply: reply.answer });
    if (reply.answer.trim()) await afterReply(chatId, "", reply.waits || "", reply.answer, true);
    return reply.answer.trim();
}

/** A reply that only promises ("I'll check your calendar"): checked even
 *  with no goal open, so a request that stopped halfway is noticed. */
const PROMISE = /\b(i'll|i will|let me|i'm going to|going to check|on it|o să|o sa|voi |mă uit|ma uit|verific|caut acum|revin)\b/i;

/** After a 1:1 reply: keep the goal while something's awaited; else check it
 *  and, if it isn't met, carry on — at most goals.MAX_CONTINUES turns, and
 *  never twice for the same thing missing (a loop). */
async function afterReply(chatId: string, asked: string, waits: string, answer: string, followUp = false): Promise<void> {
    // Something still on its way is a wait too: a job on their computer that
    // hasn't answered (it may be asking them something — three "carrying on"
    // turns went out while TripIt waited for their sign-in, 2026-10-16), or a
    // question this reply just asked them.
    // Those only keep a goal already open; a login link or a job just
    // started opens one.
    if (waits) { await goals.keepGoal(chatId, followUp ? "" : asked, waits); console.log(`goal in ${chatId}: waiting for ${waits}`); return; }
    if (await goals.getGoal(chatId)) {
        const open = await jobs.openJobs(chatId).catch(() => [] as any[]);
        const still = open.length ? "their computer" : /\?\s*$/.test(answer.trim()) ? "their answer" : "";
        if (still) { await goals.keepGoal(chatId, "", still); console.log(`goal in ${chatId}: waiting for ${still}`); return; }
    }
    let goal = await goals.getGoal(chatId);
    if (!goal && !followUp && asked && PROMISE.test(answer) && !/\?\s*$/.test(answer.trim())) {
        await goals.keepGoal(chatId, asked, "");
        goal = await goals.getGoal(chatId);
    }
    if (!goal) return;
    const v = await oai.goalCheck(goal.asked, [answer]).catch(() => null);
    if (!v) return;
    if (v.achieved) { await goals.closeGoal(chatId); console.log(`goal in ${chatId}: met`); return; }
    if (!(await goals.spendContinue(chatId, v.missing))) {
        console.log(`goal in ${chatId}: not met (${v.missing}) — stopping (bound or loop)`);
        await goals.closeGoal(chatId);
        return;
    }
    console.log(`goal in ${chatId}: not met (${v.missing}) — carrying on`);
    await followUpTurn(chatId, `[Not finished yet — still missing: ${v.missing}. Do the next step now, with your tools; don't just say you will.]`, "goal-continue");
}

hub.hooks.jobDone = async (chatId: string, then: string, kind: string) => {
    // A failed job: the rest of the request usually leaned on it (the RSVP
    // that didn't go through, then a calendar event for it). Doing it anyway,
    // silently, was wrong; the model says what it will do instead.
    const note = kind === "failed"
        ? `[Your computer could not finish — its answer is the message just above. The rest of their request was: ${then}. Don't do that silently: say in a line or two what you'll do instead (or ask), and only do it now if it plainly doesn't depend on what failed. Don't start the same browse again.]`
        : `[Your computer has finished — its answer is the message just above. Now do what was left of their request yourself, with your own tools: ${then}. Don't start the same browse again.]`;
    await followUpTurn(chatId, note, kind === "failed" ? "after-job-failed" : "after-job");
};

// A job answered (no then step): an open goal is checked against its answer
// — met, it closes; not, the chat does the next step (the ski trip's TripIt
// job answered while the goal waited for it, 2026-10-16).
hub.hooks.jobEnded = async (chatId: string, answer: string, kind: string) => {
    const goal = await goals.getGoal(chatId);
    if (!goal) return;
    const v = await oai.goalCheck(goal.asked, [answer]).catch(() => null);
    if (!v) return;
    if (v.achieved) { await goals.closeGoal(chatId); console.log(`goal in ${chatId}: met by the job's answer`); return; }
    if (!(await goals.spendContinue(chatId, v.missing))) { await goals.closeGoal(chatId); console.log(`goal in ${chatId}: not met after the job (${v.missing}) — stopping`); return; }
    console.log(`goal in ${chatId}: not met after the job (${v.missing}) — carrying on`);
    await followUpTurn(chatId, `[Your computer has ${kind === "failed" ? "stopped without finishing" : "answered"} — its message is just above. Still missing for what they asked: ${v.missing}. Do the next step now, with your tools; don't repeat what the computer said.]`, "goal-continue");
};

/** Login links already used, a while: loaded again (a second tap, a reload),
 *  the page says it's connected rather than "expired" — that made the chat
 *  tear down a connection that had just worked (2026-10-16). */
const connectedLinks = new Map<string, { label: string; at: number }>();

// Sending as Gepetel — tagging, archiving, opening the follow-up window — lives in
// say.ts so the tool side (oai.ts) can speak too.

// `loggedAs` is what the admin log shows instead of the raw text — used to mark a
// voice note, whose transcription is otherwise indistinguishable from something
// typed. The model still receives `text`; only the review log differs.
async function processIncomingMessage(chatId: string, text: string, author: string, groupName: string | undefined, messageId: string, authorPhone: string = "", loggedAs: string = "", repliedToBot: boolean = false) {
    const incoming = loggedAs || text;
    text = u.normalizeMentions(text);
    console.log(`Message from ${author}: ${text}`);
    const isGroupMessage = u.isGroupChatId(chatId);
    // Quoting one of his messages is addressing him, however long ago he said it.
    const mentioned = !isGroupMessage || u.isMentioned(text) || repliedToBot;

    // Track when this group is active (UTC hour histogram) for timing unprompted messages.
    await m.recordActivity(chatId);

    // They wrote: a nudge he sent earlier got an answer. That is what allows the
    // NEXT one ever to be sent — an unanswered one blocks the chat for good.
    if (!isGroupMessage) await m.clearFollowUp(chatId).catch(() => {});

    // Reading the room for a reaction to his last unprompted post. Never blocks or
    // breaks the reply flow.
    if (isGroupMessage) {
        try {
            const watched = await m.noteWatchedMessage(chatId, author, text);
            if (watched && await oai.detectPushback(watched.post, watched.messages)) {
                const until = await m.startUnpromptedCooldown(chatId);
                console.log(`Unprompted pushback in ${chatId}: no unprompted posts until ${until.toISOString()}.`);
            }
        } catch (e) { console.error("pushback check failed:", e); }
    }

    // "Stop" in a private chat while the computer is working on something:
    // stopped here, at once — not left to the model, which once answered
    // "Stopped" without stopping anything (2026-10-14).
    if (!isGroupMessage) {
        const { STOP_WORDS, stopOpenWork } = await import("./device/mcp.js");
        if (STOP_WORDS.test(text)) {
            const stopped = await stopOpenWork(chatId).catch((e: any) => { console.error("stop failed:", e?.message || e); return [] as string[]; });
            if (stopped.length) {
                const ro = u.replyLanguage({ text, chatId }) === "Romanian";
                await sayAndRemember(chatId, ro ? "🖥️ Gata, am oprit. Nu s-a trimis și nu s-a schimbat nimic." : "🖥️ Stopped. Nothing was sent or changed.");
                await m.logInteraction({ chatId, groupName, isGroup: false, author, incoming, action: "stopped-computer-work", reply: "" });
                return;
            }
        }
    }

    // Is a reply for this chat already being written? Then this message belongs
    // IN that reply, not in a second one racing it. The turn folds it into its
    // next model round, so the answer accounts for it — which is what a person
    // does when you add something while they are mid-sentence.
    //
    // Only what the model has not already seen: the archive it reads from was
    // written before this line arrived.
    if (turns.offerToTurn(chatId, `${author}: ${text}`, mentioned)) {
        console.log(`Message from ${author} folded into the reply already being written for ${chatId}.`);
        // He is plainly awake for it — it is going into the answer — so the read
        // receipt is honest here.
        try { await wa.markAsRead(messageId); } catch (e) { /* non-critical */ }
        await m.logInteraction({ chatId, groupName, isGroup: isGroupMessage, author, incoming, action: "folded-into-reply", reply: "" });
        return;
    }

    // Count every group mention/tag for the growth nudge, regardless of whether we
    // end up replying (gate/daily-limit may stop us below). If this mention crosses
    // the threshold, DM the user once. Failures here never block the group reply.
    if (isGroupMessage && mentioned && authorPhone) {
        try {
            const { claimedNudge, nudgeNumber } = await m.recordUserMention(authorPhone);
            if (claimedNudge) await sendGrowthOpener(authorPhone, author, nudgeNumber);
        } catch (e) { console.error("growth opener failed:", e); }
    }

    // Mark the incoming message as read first (we've seen it).
    let shouldReply = true;          // 1:1 and explicit mentions always reply
    let numUnsentMessages = 0;
    let participants: any[] = [];

    let silentReason = "not-mentioned";
    if (isGroupMessage) {
        const meta = await m.getGroupMetadata(chatId);
        numUnsentMessages = meta.numUnsentMessages;
        participants = meta.participants || [];
        

        const gate = u.replyGateDecision({
            isGroupMessage,
            mentioned,
            gapMs: Date.now() - new Date(meta.lastReplyAt || 0).getTime(),
            askedOnly: u.isAskedOnly(meta.askedOnlyUntil),
        });

        // Read receipts are honest now: a message he is asleep for is never
        // looked at — no gatekeeper, no model — so it is not marked read. Mentions
        // and follow-up-window messages are actually read (by the gatekeeper at
        // least), and a 1:1 always is.
        if (gate.decision !== "silent") {
            try { await wa.markAsRead(messageId); } catch (e) { /* non-critical */ }
        }

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
        await m.logInteraction({ chatId, groupName, isGroup: isGroupMessage, author, incoming, action: `silent:${silentReason}`, reply: "" });
        return;
    }

    // 1:1 abuse gate. Groups are capped by dailyReplyLimit; a DM had no ceiling at
    // all, so one person could use Gepetel as an unlimited free assistant. The
    // caps are generous enough that an ordinary conversation never meets them.
    // Not for the owner (CREATOR_PHONE) or a number in DM_UNLIMITED: testing
    // Gepetel's computer work from the phone is many short messages a day
    // (the owner was cut off mid-test, 2026-10-14).
    if (!isGroupMessage && !u.dmUnlimited(chatId)) {
        const quota = await m.claimDmMessage(chatId);
        if (!quota.allowed) {
            if (quota.shouldTell) {
                await sayAndRemember(chatId, u.dmLimitMessage(u.inferLanguage([chatId]), quota.reason === "burst"));
            }
            await m.logInteraction({ chatId, groupName, isGroup: false, author, incoming, action: `silent:dm-limit-${quota.reason}`, reply: "" });
            return;
        }
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
                    u.inferTimezone(members)
                );
                await sayAndRemember(chatId, limitMsg.answer);
                await m.markGroupReplied(chatId, limitMsg.answer);
                await m.logInteraction({ chatId, groupName, isGroup: true, author, incoming, action: "silent:daily-limit", reply: limitMsg.answer });
            } else {
                await m.logInteraction({ chatId, groupName, isGroup: true, author, incoming, action: "silent:daily-limit", reply: "" });
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

    let reply: {answer: string; responseId: string; waits?: string; consumedMessages?: {from: string; text: string; timestamp?: Date}[]};
    const {numberOfParticipants} = await m.newMessage(chatId, author, text, wa.getGroupInfo, groupName);
    // The last N messages, both sides, re-sent each turn. This replaces the old
    // previous_response_id chain, which grew without limit and re-billed the
    // entire history every message.
    const history = await m.getRecentMessages(chatId, CONVERSATION_WINDOW);
    // From here until the answer is in hand, this chat has a live turn: anything
    // that arrives joins this reply rather than starting another.
    const turn = turns.beginTurn(chatId);
    // A reply that takes a while (looking through mail, a calendar, starting
    // a job): "on it" after 15 s, and the typing shown again — the owner sat
    // through 2 minutes of nothing and wrote "well?" (2026-10-15). 1:1 only.
    let ackTimer: NodeJS.Timeout | null = null, typingTimer: NodeJS.Timeout | null = null;
    if (!isGroupMessage) {
        ackTimer = setTimeout(() => {
            const ro = u.replyLanguage({ text, chatId }) === "Romanian";
            void sayAndRemember(chatId, ro ? "Mă ocup…" : "On it…").catch(() => {});
        }, 15_000);
        typingTimer = setInterval(() => { void wa.sendTypingIndicator(chatId, messageId).catch(() => {}); }, 20_000);
    }
    const stopWaiting = () => { if (ackTimer) clearTimeout(ackTimer); if (typingTimer) clearInterval(typingTimer); ackTimer = typingTimer = null; };
    try {
        if (isGroupMessage) {
            reply = await oai.generateGroupReply(chatId, groupName || '', numberOfParticipants, history, `${author}: ${text}`, numUnsentMessages, mentioned, timezone, authorPhone, turn);
        } else {
            const userGroups = await m.getGroupsByParticipant(chatId);
            // If Gepetel opened this chat himself, this is a reply inside that
            // warm-up: it says how far along it is, and whether this is the one
            // message where the ask may surface. Null for every ordinary DM.
            const outreach = await m.noteOutreachReply(chatId).catch(() => null);
            if (outreach) console.log(`Growth warm-up with ${chatId}: reply ${outreach.replies}${outreach.mayAsk ? " — the ask may come up now" : ""}.`);
            reply = await oai.generateReply(author, text, history, timezone, chatId, userGroups, outreach, turn);
        }
    } catch (err: any) {
        stopWaiting();
        // The generator closes its own turn when it finishes; if it threw, it did
        // not get that far. Leaving one open would make the chat swallow every
        // later message into a reply that is never coming.
        const { unused } = turns.closeTurn(turn);
        if (unused.length) console.warn(`Generation failed with ${unused.length} folded-in message(s) unanswered in ${chatId}.`);
        // An empty OpenAI balance breaks every single reply until a human tops it
        // up. Going quiet would look exactly like Gepetel choosing not to speak —
        // in a 1:1, where he always answers, that reads as "the bot is dead".
        // So say it out loud, once a day per chat, and let people nudge the owner.
        if (!u.isOutOfCredits(err)) {
            // A 1:1 always gets an answer — never "On it…" and then silence.
            if (!isGroupMessage) {
                const ro = u.conversationLanguage([text], chatId) === "Romanian";
                await sayAndRemember(chatId, ro ? "Ceva n-a mers la mine — întreabă-mă din nou peste un minut." : "Something went wrong on my side — ask me again in a minute.").catch(() => {});
            }
            throw err;
        }
        const language = isGroupMessage
            ? u.inferLanguage(u.stripBot(participants))
            : u.inferLanguage([chatId]);
        if (await m.claimCreditsNotice(chatId)) {
            await sayAndRemember(chatId, u.outOfCreditsMessage(language), { openWindow: false });
        }
        // Deliberately no markGroupReplied: he hasn't actually said anything, and
        // opening the continuation window would just fail the same way 5 minutes on.
        await m.logInteraction({ chatId, groupName, isGroup: isGroupMessage, author, incoming, action: "out-of-credits", reply: "" });
        return;
    }
    stopWaiting();
    // In groups Gepetel may still decide there's nothing to add; in a 1:1 he always replies.
    if (isGroupMessage && reply.answer.toLowerCase().includes("no answer")) {
        console.log("No reply generated.");
        await m.logInteraction({ chatId, groupName, isGroup: isGroupMessage, author, incoming, action: "silent:no-answer", reply: "" });
    } else {
        console.log(`Reply: ${reply.answer}`);
        await sayAndRemember(chatId, reply.answer);
        if (isGroupMessage) {
            await m.markGroupReplied(chatId, reply.answer);
            await m.incrementDailyReplyCount(chatId);
        }
        await m.logInteraction({ chatId, groupName, isGroup: isGroupMessage, author, incoming, action: "replied", reply: reply.answer });
        // A 1:1 request carried to its end (goals.ts), after the reply is out.
        if (!isGroupMessage) void afterReply(chatId, text, reply.waits || "", reply.answer).catch(e => console.error(`goal after reply in ${chatId}:`, e?.message || e));
    }
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

        // Greet on a genuine (re-)join only — see util.shouldGreetGroup. Someone
        // else being added, a subject change, a settings tweak: not his cue.
        const lastReplyMs = existing?.lastReplyAt ? Date.now() - new Date(existing.lastReplyAt).getTime() : Infinity;
        const shouldGreet = u.shouldGreetGroup({ isNewGroup, botPresent: existing?.botPresent, lastReplyMs, change: group.change });
        if (!shouldGreet && group.change) console.log(`Group event for ${chatId}: ${group.change.action}${group.change.participants.length ? " " + group.change.participants.length + " member(s)" : ""} — no greeting.`);

        if (shouldGreet) {
            console.log(`Greeting group ${chatId} ("${resolvedName}").`);
            const members = u.stripBot(participantIds);
            const language = u.inferLanguage(members);

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
            await sayAndRemember(chatId, reply.answer);
            await m.markGroupReplied(chatId, reply.answer);
            await m.setBotPresent(chatId, true);
            await m.logInteraction({ chatId, groupName: resolvedName, isGroup: true, author: "", incoming: "(added to group)", action: "greeting", reply: reply.answer });
            return true;
        }
        // Routine membership/name change — roster already refreshed above.
        await m.setBotPresent(chatId, true);
    }
    return false;
}

// One inbound message, already normalized by the provider.
// Is Gepetel awake enough in this chat to be worth paying to decode media?
//
// Vision and Whisper run per message, so a photo-heavy group nobody tags can
// quietly cost a fortune describing images no one will ever read back: "Vama 15"
// took 49 photos in a day with Gepetel speaking zero times. The reply gate
// already knows when he's out of the picture, so ask it BEFORE decoding rather
// than after — the answer is the same one processIncomingMessage will reach.
//
// `carrierText` is the free text we have without paying anything: the message
// body, or an image/GIF caption. A caption is where an "@gepetel" would live.
async function isAwakeFor(chatId: string, carrierText: string): Promise<boolean> {
    const isGroupMessage = u.isGroupChatId(chatId);
    if (!isGroupMessage) return true;          // he always answers a 1:1
    let lastReplyAt: any = null;
    try {
        lastReplyAt = (await m.getGroupByChatId(chatId))?.lastReplyAt || null;
    } catch (e) {
        // Unknown group -> treat as asleep; the gate would say the same.
    }
    return u.replyGateDecision({
        isGroupMessage,
        mentioned: u.isMentioned(carrierText),
        gapMs: Date.now() - new Date(lastReplyAt || 0).getTime(),
    }).decision !== "silent";
}

async function handleIncomingMessage(message: WaIncomingMessage) {
    // Idempotency: both providers redeliver on any timeout/5xx. Skip a message
    // id we've already handled so Gepetel never replies (or counts) twice.
    if (!(await m.markMessageProcessed(message.id))) {
        console.log(`Duplicate webhook for message ${message.id}, skipping.`);
        return;
    }
    const chatId = message.chatId;
    let text = '';
    let loggedAs = '';        // what the admin log shows, when it differs from `text`
    // Image extraction can fail (bad preview, model error); never let
    // that crash the webhook — fall back to a neutral placeholder.
    const describe = async (preview: string) => {
        try { return await oai.getImageDescription(preview); }
        catch (e) { console.error("getImageDescription failed:", e); return "an image"; }
    };
    // Everything we can read for free, before spending anything on the media
    // itself. A caption is plain text and is where an "@gepetel" would appear.
    const caption = message.image?.caption || message.gif?.caption || message.document?.caption || "";
    const awake = await isAwakeFor(chatId, message.text || caption);

    if (message.reaction) {
        // A reaction is an answer with no words. It counts when it lands on one
        // of Gepetel's own lines: in a 1:1 a 👋 to his hello IS the reply, and
        // treating it as nothing left him talking to someone he thought had gone
        // quiet. On anyone else's message it is just chat furniture, and a
        // removed reaction (empty emoji) is someone taking it back — neither is
        // something to answer.
        if (!message.reaction.emoji.trim()) return;
        const target = await m.getArchivedMessage(message.reaction.messageId).catch(() => null);
        const toGepetel = target?.from === "Gepetel";
        if (!toGepetel) {
            console.log(`Reaction ${message.reaction.emoji} on someone else's message — noted, not answered.`);
            return;
        }
        // In a group a reaction is applause, not a summons: one emoji from each
        // of eight people would have him answer eight times. His own follow-up
        // window already covers anyone who actually means to keep talking.
        if (u.isGroupChatId(chatId)) {
            console.log(`Reaction ${message.reaction.emoji} in a group — noted, not answered.`);
            return;
        }
        text = u.formatReaction(message.reaction.emoji, target);
        loggedAs = `${message.reaction.emoji} (reaction)`;
    } else if (message.text) {
        text = message.text;
    } else if (message.gif) {
        text = awake ? await describe(message.gif.link) : "a GIF";
        if (message.gif.caption) text += ` (${message.gif.caption})`;
    } else if (message.image) {
        // Still remembered even when asleep: it costs nothing and keeps
        // "edit that picture" working if the group wakes him right after.
        try { await m.setLastImage(chatId, message.image.link); } catch (e) { /* non-critical */ }
        text = awake ? await describe(message.image.link) : "a photo";
        if (message.image.caption) text += ". " + message.image.caption;
    } else if (message.voice) {
        // Voice/audio note -> transcribe and treat as the sender's words.
        // A voice note carries no caption, so there is nothing free to read: when
        // he's asleep it is logged as-is rather than transcribed. That does mean a
        // spoken "Gepetel" can't wake a quiet group — the cost of not paying
        // Whisper for every note in a chat he isn't part of.
        if (!awake) {
            text = "a voice message";
        } else {
            try {
                text = await oai.transcribeVoice(message.voice.link);
            } catch (e) {
                console.error("transcribeVoice failed:", e);
                return; // can't read it -> ignore rather than reply blind
            }
            if (!text) return;
            // A voice note can't type "@", so let a spoken "Gepetel" count as a mention.
            text = text.replace(/\bgepetel\b/gi, "@gepetel");
            // Flag it in the review log: a transcription reads exactly like a typed
            // message, so without this there's no way to tell what arrived by voice.
            loggedAs = `🎤 ${text}`;
        }
    } else if (message.document) {
        // We know a file arrived and what it is called; we do not read it. Costs
        // nothing either way, so this reads the same asleep or awake — unlike the
        // media above, there is no download to skip. Naming it plainly is what
        // stops the model inventing contents it has never seen.
        const name = message.document.filename || "un fișier";
        text = `[a document nobody has read: "${name}"]`;
        // A PDF in a chat Gepetel answers is read (fetched from the gateway,
        // read by the model): the owner sent a SmartBill invoice and "pay this
        // invoice" and was told it couldn't read PDFs (2026-10-19).
        const pdf = /pdf/i.test(String(message.document.mimeType || "")) || /\.pdf$/i.test(name);
        if (awake && pdf && (!message.document.size || message.document.size <= 15_000_000) && message.document.mediaId) {
            const got = await wa.fetchDocument(message.document.mediaId).catch(() => null);
            const read = got ? await oai.readDocument(got.data, name, got.mimetype.includes("pdf") ? got.mimetype : "application/pdf").catch(e => { console.error("readDocument failed:", e?.message || e); return ""; }) : "";
            if (read) text = `[the document "${name}" — its content, read:\n${read.slice(0, 6000)}]`;
            else text = `[a document "${name}" that couldn't be read]`;
        }
        if (message.document.caption) text += " " + message.document.caption;
        loggedAs = `📎 ${name}${text.startsWith("[the document") ? " (read)" : ""}${message.document.caption ? ` — ${message.document.caption}` : ""}`;
    } else if (message.linkPreview) {
        text = message.linkPreview.title;
        if (message.linkPreview.description) {
            text += ". " + message.linkPreview.description;
        } else if (message.linkPreview.preview && awake) {
            text += ". " + await describe(message.linkPreview.preview);
        }
    } else {
        console.error(message.raw ?? message);
        // unsupported type -> ignore
        return;
    }

    // Who is speaking, as the model will see it: the profile name; failing that,
    // a name learned from the conversation (setMemberName); failing that, a
    // stable handle rather than nothing — an empty label makes a person
    // impossible to refer to, and a number must never reach the model.
    const author = message.fromName
        || (await m.getPersonName(message.from).catch(() => null))
        || u.anonymousHandle(message.from);

    // Normalise before anything stores or reads this: the bot's own tag becomes
    // "@gepetel", and everyone else's resolved number becomes their name. Doing it
    // here means the archive — and therefore the conversation window — holds
    // readable text rather than phone numbers.
    text = u.normalizeMentions(text);
    try { text = await m.resolveMentionNames(text); } catch (e) { /* names are a nicety */ }

    // Archive first, and unconditionally: a reply can quote a message Gepetel
    // never answered, so archiving only what he replied to would miss most of it.
    try { await m.archiveMessage(chatId, message.id, author, text); } catch (e) { /* non-critical */ }

    // Tell Bogdan when someone is working on the prompt. Deliberately here, before
    // the reply gate: an attempt is worth knowing about whether or not Gepetel was
    // awake to answer it, and a quiet group is exactly where someone would probe.
    // Nothing is blocked — see looksLikeExtractionAttempt for why this is an alert
    // and not a defence — and the claim keeps a fifteen-message campaign to one ping.
    if (u.looksLikeExtractionAttempt(text)) {
        try {
            if (await m.claimInjectionAlert(chatId)) {
                const where = message.chatName || (await m.getGroupByChatId(chatId))?.name || chatId;
                await tg.notify(
                    `🕵️ Someone's poking at the prompt in *${tg.escapeMarkdown(where)}*\n` +
                    `From: ${tg.escapeMarkdown(author || "unknown")}\n\n` +
                    `${tg.escapeMarkdown(text.slice(0, 400))}\n\n` +
                    `_Nothing is exposed — no key is in the prompt and group access is checked in code. ` +
                    `Muted for an hour in this chat._`
                );
            }
        } catch (e) { console.error("injection alert failed:", e); }
    }

    // If this is a reply, resolve what it's replying to and put that in front of
    // the text — the gateway sends only the quoted id, never its content.
    let repliedToBot = !!message.reaction;   // a reaction here is one on his own line
    if (message.quoted?.id && !message.reaction) {
        try {
            const quoted = await m.getArchivedMessage(message.quoted.id);
            repliedToBot = quoted?.from === "Gepetel";
            text = u.formatQuotedContext(quoted, text);
            loggedAs = `↩️ ${loggedAs || text}`;
        } catch (e) { console.error("resolving a quoted message failed:", e); }
    }

    try {
        await processIncomingMessage(chatId, text, author, message.chatName, message.id, message.from, loggedAs, repliedToBot);
        if (message.fromName) await m.updatePeople({ phoneNumber: message.from, name: message.fromName });
    } catch (error) {
        console.error(`Error processing message from ${author} in chat ${chatId}:`, error);
    }
}

// --- The marketing pages, at addresses without ".html" ---

// The static host in front of this app serves a file only at its exact path:
// /privacy.html is a file, /privacy is not, and anything that isn't a file is
// handed to this app. So these are the pages people actually link to, answered
// here with the same HTML the bundle ships (COPY website/*.html in the
// Dockerfile). A redirect would have worked too, but then the address bar says
// ".html" and the link people share is the one we didn't choose.
//
// Relative paths inside those pages ("assets/gepetel.png", "index.html") still
// resolve against the root, so the images and the other pages come from the
// bundle exactly as before. No trailing slash, for the same reason.
const SITE_PAGES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "website");
const CLEAN_URL_PAGES = ["privacy", "tos", "faq", "pay", "computer"];
app.get(CLEAN_URL_PAGES.map(p => `/${p}`), (req, res, next) => {
    const page = req.path.replace(/^\/+|\/+$/g, "");
    res.sendFile(path.join(SITE_PAGES, `${page}.html`), (err) => {
        // Not shipped in this image for some reason: fall through rather than
        // answering with a broken page.
        if (err) next();
    });
});

// --- Connected services: the OAuth half that needs a browser ---

// Who Gepetel is, for a login provider that takes a URL as the client id.
app.get("/oauth/client-metadata.json", (_req, res) => {
    const base = u.publicBaseUrl();
    res.json(mcp.clientMetadata(`${base}/oauth/callback`, `${base}/oauth/client-metadata.json`));
});

function oauthPage(ok: boolean, title: string, body: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#FBF6EC;color:#2A2620;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{max-width:28rem;margin:1rem;padding:1.6rem;background:#fff;border:2.5px solid #2A2620;border-radius:18px;box-shadow:4px 4px 0 #2A2620}
h1{font-size:1.3rem;margin:0 0 .6rem}p{margin:.4rem 0;line-height:1.5}</style></head>
<body><div class="card"><h1>${ok ? "✅" : "⚠️"} ${title}</h1><p>${body}</p></div></body></html>`;
}

// The person approved (or refused) the login. Finish the connection, tell them
// in the 1:1, and show a page that says so — never a token, there is nothing
// for a person to copy anywhere.
app.get("/oauth/callback", async (req, res) => {
    const q: any = req.query || {};
    const state = String(q.state || "");
    if (q.error) {
        // Refused or failed at the provider. Claim the pending row so it can't
        // be replayed, and let the person know in the 1:1.
        const pending = await m.takeMcpOAuthPending(state).catch(() => null);
        if (pending?.requester) {
            const lang = u.inferLanguage([pending.requester]);
            await sayAndRemember(`${pending.requester}@s.whatsapp.net`, u.connectorFailedMessage(lang, { label: pending.label, reason: String(q.error_description || q.error) }));
        }
        res.status(400).send(oauthPage(false, "Not connected", `The login was not completed (${String(q.error_description || q.error)}). You can close this page and go back to WhatsApp.`));
        return;
    }
    if (!state || !q.code) {
        res.status(400).send(oauthPage(false, "Nothing to do here", "This page only makes sense at the end of a login started from WhatsApp."));
        return;
    }
    let done;
    try {
        done = await oai.completeMcpOAuth(state, String(q.code));
    } catch (e: any) {
        const was = connectedLinks.get(state);
        if (was && Date.now() - was.at < 30 * 60_000) {
            res.send(oauthPage(true, `${was.label} is connected`, "This link was already used, and it worked. You can close this page and go back to WhatsApp."));
            return;
        }
        res.status(400).send(oauthPage(false, "This link has expired", "Ask Gepetel in WhatsApp to connect the service again and you'll get a fresh one."));
        return;
    }
    // Their conversation's language, not the phone number's country: the chat
    // was in English and this came in Romanian (2026-10-16).
    const recent = await m.getRecentMessages(`${done.requester}@s.whatsapp.net`, 6).catch(() => []);
    const lang = u.replyLanguage({ text: recent.filter(x => x.from !== "Gepetel").map(x => x.text).join("\n"), chatId: `${done.requester}@s.whatsapp.net` });
    if (done.ok) {
        for (const [k, v] of connectedLinks) if (Date.now() - v.at > 30 * 60_000) connectedLinks.delete(k);
        connectedLinks.set(state, { label: done.label, at: Date.now() });
        await m.logInteraction({ chatId: done.chatId, groupName: done.groupName, isGroup: true, author: "(oauth)", incoming: `(connected ${done.label})`, action: "connector", reply: "" });
        res.send(oauthPage(true, `${done.label} is connected`, `Connected to "${done.groupName}". You can close this page and go back to WhatsApp — Gepetel carries on there.`));
        // Then the conversation goes on: what they asked that needed it gets
        // its answer now (the owner, 2026-10-16: "you connect and then you
        // stop. you should continue"). The fixed note only if that fails.
        const chat = `${done.requester}@s.whatsapp.net`;
        const here = !done.groupName || done.chatId === chat;
        const note = `[${done.label} is now connected${here ? " here" : ` to the group "${done.groupName}"`}. Say so in one short line, in the language of this conversation. If they asked something it was needed for, answer that now, using it — don't wait to be asked again. If nothing was pending, say in one plain sentence what it lets you do for them (e.g. "see and add to your calendar") — never tool names.]`;
        let said = "";
        try { said = await followUpTurn(chat, note, "after-connect"); } catch (e: any) { console.error(`after connecting ${done.label}:`, e?.message || e); }
        if (!said) await sayAndRemember(chat, u.connectorConnectedMessage(lang, { group: done.groupName, label: done.label, tools: done.tools }));
        return;
    } else {
        // A person-facing page, so 200 even on failure: Cloudflare replaces any
        // 5xx from the origin with its own "Bad gateway" page, and the reason
        // written here never reached anyone.
        console.error(`oauth callback: ${done.label} for ${done.chatId} failed — ${done.reason}`);
        await m.logInteraction({ chatId: done.chatId, groupName: done.groupName, isGroup: u.isGroupChatId(done.chatId), author: "(oauth)", incoming: `(connect ${done.label} failed)`, action: "connector-failed", reply: done.reason || "" });
        await sayAndRemember(`${done.requester}@s.whatsapp.net`, u.connectorFailedMessage(lang, { label: done.label, reason: done.reason || "unknown error" }));
        res.status(200).send(oauthPage(false, "Not connected", `The login went through but the service could not be reached afterwards (${done.reason}). Gepetel has sent you a note in WhatsApp.`));
    }
});

// The inbound webhook. Both providers post here: whapi's flat payload and
// wa-gateway's Meta-shaped envelope are told apart by wa.parseWebhook, so a
// webhook still pointed at the old provider keeps working across the switch.
/** The note to someone who called, at most once per 10 minutes per caller. */
const callNoted = new Map<string, number>();
async function answerCall(from: string): Promise<void> {
    const digits = u.phoneDigits(from);
    if (!digits) return;
    const last = callNoted.get(digits) || 0;
    if (Date.now() - last < 10 * 60_000) return;
    callNoted.set(digits, Date.now());
    const chatId = `${digits}@s.whatsapp.net`;
    const lang = u.replyLanguage({ text: "", chatId });
    console.log(`A call from ${chatId}: rejected; told them to write instead.`);
    await sayAndRemember(chatId, u.callNote(lang));
}

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

    // Calls: Gepetel can't take them — the gateway rejects them, and the caller
    // is told, once in a while, that it reads messages, voice ones included
    // (the owner, 2026-10-30).
    for (const c of events.calls || []) {
        try { await answerCall(c.from); } catch (e) { console.error("call note failed:", e); }
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

    // One message failing doesn't cost the rest of the batch their replies.
    // Marked done either way: it was handled, if badly, and a retry of the
    // same failure would only fail again (or answer twice).
    for (const message of events.messages) {
        try { await handleIncomingMessage(message); }
        catch (e: any) { console.error(`message ${message.id} in ${message.chatId} failed:`, e?.stack || e?.message || e); }
        finally { await m.markMessageDone(message.id); }
    }

    res.status(200).json({ status: 'success' });
}

// `/whapi` is where whapi.cloud has always posted; `/wa` is the provider-neutral
// name to point wa-gateway (or anything later) at. Both do the same thing.
app.post('/whapi', handleWebhook);
app.post('/wa', handleWebhook);

// The review pages (admin.ts) and the scheduler's endpoints (cron.ts).
admin.registerAdminRoutes(app, { processIncomingMessage });
cron.registerCronRoutes(app);

const MAX_DAILY_LIMIT = 10000;

// Payment callback: adds `additional` messages/day to a group's limit — but ONLY
// ONCE per group (the free extension). Body: { groupId, userId, additional, email }
// — secret in X-Payment-Secret header. Announces in the group and DMs the user.
const applyPaymentExtension: express.RequestHandler = async (req, res) => {
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

        // Resolve the paying member's display name.
        const userLanguage = u.inferLanguage([userId]);
        const userTimezone = u.inferTimezone([userId]);
        const memberName = (await m.getPersonName(userId)) || "Someone";

        // Announce in the group (don't reset messagesSinceLastSend — not a reactive reply).
        const groupMsg = await oai.generatePaymentGroupMessage(memberName, newLimit, language, timezone);
        await sayAndRemember(groupId, groupMsg.answer);
        await m.recordGroupAnnouncement(groupId, groupMsg.answer);
        await m.logInteraction({ chatId: groupId, groupName, isGroup: true, author: "", incoming: "(payment callback)", action: "replied", reply: groupMsg.answer });

        // Confirm to the paying user via DM, continuing their conversation thread.
        const dmGroup: any = await m.getGroupByChatId(userId);
        const dmMsg = await oai.generatePaymentDmConfirmation(memberName, groupName, newLimit, userLanguage, userTimezone);
        await sayAndRemember(userId, dmMsg.answer);
    } catch (err) {
        console.error('Payment callback notification error:', err);
    }

    console.log(`Payment callback: ${userId} extended ${groupId} by +${add} -> ${newLimit} msgs/day`);
    res.json({ status: 'ok', added: add, newLimit });
};

// Cross-origin caller (the Vercel-hosted checkout) — proves itself with the shared
// secret. Kept working so rolling back to Vercel + Cloud Functions needs no code change.
app.post('/payment/callback', (req, res, next) => {
    if (!u.secretEquals(req.get('X-Payment-Secret'), process.env.PAYMENT_SECRET)) {
        res.status(403).json({ error: 'forbidden' });
        return;
    }
    applyPaymentExtension(req, res, next);
});

// Same-origin checkout: pay.html now ships from this app's own frontend bundle, so
// the browser posts straight here and there is no secret to relay. This replaces
// website/api/extend.js, which was equally unauthenticated from the browser's side
// — it held the secret server-side and forwarded. Same exposure, one less hop.
app.post('/api/extend', applyPaymentExtension);

// Public send API: lets an authorised 3rd party post a message to a group, which
// Gepetel then sends verbatim. Auth: X-Api-Key header must equal PUBLIC_API_KEY.
// Body: { groupId, message } where groupId is the WhatsApp chat id (…@g.us).
app.post('/api/send', async (req, res) => {
    if (!u.secretEquals(req.get('X-Api-Key'), process.env.PUBLIC_API_KEY)) {
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
        const ok = await sayAndRemember(groupId, text);
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

// The device relay's HTTP half. The WebSocket half needs the http.Server, so it
// is attached below where that exists — under Cloud Functions there is no server
// to attach to and no paired computer either, so the routes alone are correct.
device.registerDeviceRoutes(app);

// Register the Express app as a Google Cloud Function (gen2) entry point.
http("app", app);

// When not running inside Cloud Run / Cloud Functions, start a local server.
if (!process.env.K_SERVICE) {
    const PORT = Number(process.env.PORT) || 8080;
    // '::' is dual-stack in Node, and the Pi needs both families: the healthcheck
    // runs inside the container against IPv6 localhost, while the proxy reaches the
    // container over IPv4. HOST stays overridable for a box with no IPv6.
    const HOST = process.env.HOST || '::';
    const server = app.listen(PORT, HOST, () => {
        console.log(`Server is running on port ${PORT}`);
    });
    // Paired computers dial in here and hold the socket open.
    device.attachHub(server);
}
