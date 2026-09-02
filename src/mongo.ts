import mongoose from "mongoose";
import u from "./util.js";
import type { NamedMember } from "./util.js";
import fx from "./fx.js";

mongoose.connect(process.env["GEPETEL_DATABASE_URL"] || process.env["GEPETEL_DATABASE_URL1"] || '')
    .catch((err) => console.error("MongoDB connection error:", err.message));

const GroupsSchema = new mongoose.Schema({
    chatId: { type: String, required: true },
    name: { type: String, default: "" },
    numParticipants: { type: Number, default: 2 },
    lastChecked: { type: Date, default: Date.now },
    lastMessageTimestamp: { type: Date, default: Date.now },
    lastReplyAt: { type: Date, default: null },
    lastReplyText: { type: String, default: "" },
    botPresent: { type: Boolean, default: true },        // is Gepetel currently a member (for re-add greetings)
    previousMessageId: {type: String, default: ""},
    participants: {type: Array, default: []},
    // Rolling histogram of message activity by UTC hour ("0".."23" -> count).
    // Used to estimate when a group is awake, for well-timed unprompted messages.
    activityByHour: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Unprompted-message bookkeeping.
    addedAt: { type: Date, default: null },               // when Gepetel joined the group
    messagesSinceLastSend: { type: Number, default: 0 },  // incoming msgs since Gepetel last spoke
    nextUnpromptedAt: { type: Date, default: null },      // earliest time for the next unprompted msg
    lastImage: { type: String, default: "" },             // most recent image (url/data-uri) for edits
    lastCreditsNoticeAt: { type: Date, default: null },   // throttles the "out of credits" heads-up
    lastInjectionAlertAt: { type: Date, default: null },  // throttles the prompt-injection heads-up
    // Daily reply-limit bookkeeping (group chats only).
    dailyReplyLimit: { type: Number, default: 20 },        // max replies per UTC day (per-group setting)
    dailyReplyCount: { type: Number, default: 0 },         // replies sent today (UTC day)
    dailyLimitWarningCount: { type: Number, default: 0 },  // "limit reached" messages sent today
    dailyResetDate: { type: String, default: "" },          // UTC date string "YYYY-MM-DD" of last reset
    freeExtensionUsed: { type: Boolean, default: false },   // the one free limit extension has been used
    extensionEmail: { type: String, default: "" },          // email collected during the extension flow
});

const messagesSchema = new mongoose.Schema({
    chatId: { type: String, required: true },
    from: { type: String, required: true },
    text: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
});

// Idempotency guard: every incoming WhatsApp message id we've already handled.
// whapi redelivers webhooks on any timeout/5xx, which would otherwise make
// Gepetel reply (and count mentions) twice. Unique index => second insert fails.
// TTL auto-expires entries after a day (whapi won't redeliver that late).
const processedMessageSchema = new mongoose.Schema({
    messageId: { type: String, required: true, unique: true },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 },
});

const peopleSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true },
    name: { type: String, required: true },
});

// Per-person growth tracking (independent of People so it has no name requirement).
// Counts how many times a user has mentioned/tagged Gepetel across ALL shared
// groups; once they're a regular we DM them a one-time "add me to your other
// groups" nudge. Keyed by digit-normalized phone number.
const userGrowthSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true, index: true },
    mentionCount: { type: Number, default: 0 },   // total group mentions/tags, all groups
    firstMentionAt: { type: Date, default: null }, // when they first tagged Gepetel
    nudgeSent: { type: Boolean, default: false },  // legacy flag: at least one nudge went out
    nudgeSentAt: { type: Date, default: null },     // when the last one went out (drives the cooldown)
    nudgeCount: { type: Number, default: 0 },       // how many have gone out, capped at GROWTH_MAX_NUDGES
    mentionsAtLastNudge: { type: Number, default: 0 },  // so a follow-up needs fresh engagement
});

const memorySchema = new mongoose.Schema({
    chatId: { type: String, required: true, index: true },
    summary: { type: String, required: true },
    details: { type: String, default: "" },
    tags: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now },
});

const RemindersSchema = new mongoose.Schema({
    chat_id: { type: String, required: true },
    reminder_id: { type: String, required: false },
    title: { type: String, required: true },
    due_date: { type: Date, required: true },
    is_individual: { type: Boolean, default: false },
    phone_number: { type: String, required: false },
    recurrence: { type: String, default: null },   // null | "daily" | "weekly" | "monthly"
});

const ActionItemSchema = new mongoose.Schema({
    chat_id: { type: String, required: true, index: true },
    action_item_id: { type: String, required: false },
    title: { type: String, required: true },
    assignee: { type: String, required: false },
    status: { type: String, default: "open" },
    due_date: { type: Date, required: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

const PollSchema = new mongoose.Schema({
    chat_id: { type: String, required: true, index: true },
    poll_id: { type: String, required: false },
    wa_message_id: { type: String, required: false, index: true },
    question: { type: String, required: true },
    options: { type: [String], required: true },
    allow_multiple: { type: Boolean, default: false },
    results: {
        type: [{
            name: { type: String },
            count: { type: Number, default: 0 },
            voters: { type: [String], default: [] },
        }],
        default: [],
    },
    total: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

// A recurring thing Gepetel posts into a group on a schedule (a poll, a fixed
// message, or content written fresh each run). Set up from a 1:1 chat by any
// member of the target group — never in the group itself, which would be noisy.
//
// The schedule is weekday-based and evaluated in the group's own timezone (see
// util.isTaskDue), so it survives DST with no stored offset. Firing is hourly.
const ScheduledTaskSchema = new mongoose.Schema({
    chat_id: { type: String, required: true, index: true },   // target group
    task_id: { type: String, required: false },
    created_by: { type: String, default: "" },                // requester's 1:1 chat id
    created_by_name: { type: String, default: "" },
    kind: { type: String, required: true },                   // text | poll | generated
    title: { type: String, default: "" },                     // short label for listings
    // Kind-specific settings: text -> {text}, poll -> {question, options, allow_multiple},
    // generated -> {instruction, web_search}. Mixed so new kinds need no migration.
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    hour_local: { type: Number, required: true },             // 0..23, in `timezone`
    days_of_week: { type: [Number], default: [] },            // 0=Sun .. 6=Sat (weekly)
    interval_weeks: { type: Number, default: 1 },             // 2 = fortnightly, 4 = every 4 weeks
    anchor_date: { type: String, default: null },             // "YYYY-MM-DD": which week is week zero
    days_of_month: { type: [Number], default: [] },           // 1..31 (monthly); wins over days_of_week
    // Set instead of days_of_week for a ONE-OFF: "YYYY-MM-DD" in `timezone`.
    // Runs once on that date and is deactivated straight after.
    run_on_date: { type: String, default: null },
    timezone: { type: String, default: "UTC" },               // resolved from members at creation
    active: { type: Boolean, default: true },
    last_fired_at: { type: Date, default: null },             // guards against double-firing
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

// Per-person budget for 1:1 chats. Groups have dailyReplyLimit; a DM had nothing,
// so one person could use Gepetel as an unlimited free assistant. Keyed by the
// 1:1 chat id, reset by UTC day, with a short rolling window on top to stop a
// burst (a script, or someone pasting a wall of tasks) before the daily cap does.
const dmQuotaSchema = new mongoose.Schema({
    chatId: { type: String, required: true, unique: true },
    dayKey: { type: String, default: "" },        // UTC "YYYY-MM-DD" the day count belongs to
    dayCount: { type: Number, default: 0 },
    windowStart: { type: Date, default: null },   // start of the current burst window
    windowCount: { type: Number, default: 0 },
    noticeAt: { type: Date, default: null },      // last time we told them, so we say it once
});

// Every message we see, keyed by its WhatsApp id, so a REPLY can be resolved back
// to what it was replying to. Kept separate from `Message` (the unread backlog,
// which is deleted once consumed) because this has to survive being read.
//
// The gateway sends only the quoted message's id, never its text, so without this
// a reply is just an id pointing at nothing. Note the ceiling that implies: a
// reply to something older than the TTL, or from before Gepetel joined the group,
// can never be resolved here — only the gateway has that history.
const messageArchiveSchema = new mongoose.Schema({
    messageId: { type: String, required: true, unique: true },
    chatId: { type: String, required: true, index: true },
    from: { type: String, default: "" },      // display name, or "Gepetel" for his own
    text: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
});

// A shared expense, or a repayment between two people. Amounts are integers in
// MINOR units (bani/cents) — a ledger that doesn't balance to the penny is worse
// than no ledger, and floats don't.
const expenseSchema = new mongoose.Schema({
    chat_id: { type: String, required: true, index: true },
    expense_id: { type: String, required: false },
    description: { type: String, default: "" },
    currency: { type: String, default: "RON" },
    // Several payers is normal: "Dragos paid the bill and I tipped on top".
    payers: { type: [{ name: String, amount: Number }], default: [] },
    // Who it's shared between and each person's share. For a repayment this is
    // just the person being paid back.
    shares: { type: [{ name: String, amount: Number }], default: [] },
    kind: { type: String, default: "expense" },   // expense | settlement
    created_by_name: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
});

// Per-interaction review log: what came in and how Gepetel responded. Auto-expires
// after 14 days (TTL index on createdAt) so it stays a rolling ~2-week window.
const InteractionSchema = new mongoose.Schema({
    chatId: { type: String, index: true },
    groupName: { type: String, default: "" },
    isGroup: { type: Boolean, default: false },
    author: { type: String, default: "" },
    incoming: { type: String, default: "" },
    action: { type: String, default: "" },   // "replied" | "silent:<reason>" | "greeting" | "unprompted"
    reply: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 14 },
});

const Group = mongoose.model("Group", GroupsSchema);
const Interaction = mongoose.model("Interaction", InteractionSchema);
const Reminder = mongoose.model("Reminder", RemindersSchema);
const Message = mongoose.model("Message", messagesSchema);
const ProcessedMessage = mongoose.model("ProcessedMessage", processedMessageSchema);
const Person = mongoose.model("Person", peopleSchema);
const UserGrowth = mongoose.model("UserGrowth", userGrowthSchema);
const ActionItem = mongoose.model("ActionItem", ActionItemSchema);
const Memory = mongoose.model("Memory", memorySchema);
const Poll = mongoose.model("Poll", PollSchema);
const ScheduledTask = mongoose.model("ScheduledTask", ScheduledTaskSchema);
const DmQuota = mongoose.model("DmQuota", dmQuotaSchema);
const MessageArchive = mongoose.model("MessageArchive", messageArchiveSchema);
const Expense = mongoose.model("Expense", expenseSchema);

const toolFunctions:any = {};

toolFunctions.create_reminder = async ({chat_id, title, due_date, is_individual, phone_number}: {chat_id: string, title: string, due_date: Date, is_individual: boolean, phone_number: string | null}) => {
    // An individual reminder MUST have a phone number, otherwise it would be
    // delivered to the whole group at fire time.
    if (is_individual && !phone_number) {
        throw new Error("phone_number is required when is_individual is true");
    }
    const reminder = new Reminder({chat_id, title, due_date, is_individual, phone_number});
    reminder.reminder_id = reminder._id.toString();
    await reminder.save();
    return reminder.toJSON();
}

toolFunctions.get_group_future_reminders = async ({chat_id}: {chat_id: string}) => {
    const reminders = await Reminder.find({chat_id, due_date: {$gt: new Date()}});
    return reminders.map(reminder => reminder.toJSON());
}

toolFunctions.list_reminders = async ({chat_id}: {chat_id: string}) => {
    return await listReminders(chat_id);
}

toolFunctions.search_reminders = async ({chat_id, text}: {chat_id: string; text?: string}) => {
    const query: any = { chat_id, due_date: { $gt: new Date() } };
    if (text && text.trim()) {
        query.title = { $regex: text.trim(), $options: "i" };
    }
    const reminders = await Reminder.find(query).limit(50);
    return reminders.map(r => r.toJSON());
}

toolFunctions.update_reminder = async ({chat_id, reminder_id, title, due_date, is_individual, phone_number}: {chat_id: string, reminder_id: string, title: string, due_date: Date, is_individual: boolean, phone_number: string | null}) => {
    const reminder = await Reminder.findOne({chat_id, reminder_id});
    if (!reminder) throw new Error(`Reminder id ${reminder_id} not found`);
    if (title) reminder.title = title;
    if (due_date) reminder.due_date = due_date;
    if (is_individual !== undefined) reminder.is_individual = is_individual;     // can now be set to false
    if (phone_number !== undefined) reminder.phone_number = phone_number;        // only touch when provided
    if (reminder.is_individual === false) reminder.phone_number = null;          // group reminder needs no number
    if (reminder.is_individual && !reminder.phone_number) {
        throw new Error("phone_number is required when is_individual is true");
    }
    await reminder.save();
    return reminder.toJSON();
}

toolFunctions.delete_reminder = async ({chat_id, reminder_id}: {chat_id: string, reminder_id: string}) => {
    const reminder = await Reminder.findOne({chat_id, reminder_id});
    if (!reminder) throw new Error(`Reminder id ${reminder_id} not found`);
    await reminder.deleteOne();
    return "Reminder deleted";
}

toolFunctions.create_recurring_reminder = async ({chat_id, title, due_date, recurrence, is_individual, phone_number}: {chat_id: string, title: string, due_date: Date, recurrence: string, is_individual: boolean, phone_number: string | null}) => {
    if (!["daily", "weekly", "monthly"].includes(recurrence)) {
        throw new Error("recurrence must be one of: daily, weekly, monthly");
    }
    if (is_individual && !phone_number) {
        throw new Error("phone_number is required when is_individual is true");
    }
    const reminder = new Reminder({chat_id, title, due_date, recurrence, is_individual, phone_number});
    reminder.reminder_id = reminder._id.toString();
    await reminder.save();
    return reminder.toJSON();
}

toolFunctions.split_bill = ({total, people, names, tip_percent, currency}: {total: number, people?: number, names?: string[], tip_percent?: number, currency?: string}) => {
    return u.splitBill({ total, people, names, tip_percent, currency });
}

toolFunctions.remember_fact = async ({chat_id, summary, details, tags}: {chat_id: string, summary: string, details?: string, tags?: string[]}) => {
    return await addMemory(chat_id, summary, details, tags);
}

toolFunctions.list_memories = async ({chat_id, tag}: {chat_id: string, tag?: string}) => {
    return await listMemories(chat_id, { tag, limit: 20 });
}

toolFunctions.delete_memory = async ({chat_id, memory_id}: {chat_id: string, memory_id: string}) => {
    return await deleteMemory(chat_id, memory_id);
}

toolFunctions.create_action_item = async ({chat_id, title, assignee, status, due_date}: {chat_id: string; title: string; assignee?: string; status?: string; due_date?: Date}) => {
    const item = new ActionItem({
        chat_id,
        title: String(title || "").trim(),
        assignee: assignee ? String(assignee).trim() : undefined,
        status: status ? String(status).trim() : "open",
        due_date
    });
    item.action_item_id = item._id.toString();
    await item.save();
    return item.toJSON();
}

toolFunctions.list_action_items = async ({chat_id}: {chat_id: string}) => {
    return await listActionItems(chat_id);
}

toolFunctions.search_action_items = async ({chat_id, text}: {chat_id: string; text?: string}) => {
    return await searchActionItems(chat_id, text);
}

toolFunctions.update_action_item = async ({chat_id, action_item_id, title, assignee, status, due_date}: {chat_id: string; action_item_id: string; title?: string; assignee?: string; status?: string; due_date?: Date}) => {
    const item = await ActionItem.findOne({ chat_id, action_item_id });
    if (!item) throw new Error(`Action item ${action_item_id} not found`);
    if (title !== undefined) item.title = String(title).trim();
    if (assignee !== undefined) item.assignee = String(assignee).trim();
    if (status !== undefined) item.status = String(status).trim();
    if (due_date !== undefined) item.due_date = due_date;
    item.updatedAt = new Date();
    await item.save();
    return item.toJSON();
}

toolFunctions.delete_action_item = async ({chat_id, action_item_id}: {chat_id: string; action_item_id: string}) => {
    const item = await ActionItem.findOne({ chat_id, action_item_id });
    if (!item) throw new Error(`Action item ${action_item_id} not found`);
    await item.deleteOne();
    return "Action item deleted";
}

toolFunctions.create_poll = async ({chat_id, question, options, allow_multiple}: {chat_id: string; question: string; options: string[]; allow_multiple?: boolean}) => {
    const cleanedOptions = (options || []).map(o => String(o || "").trim()).filter(Boolean).slice(0, 12);
    if (cleanedOptions.length < 2) throw new Error("Provide at least two options");
    const poll = new Poll({
        chat_id,
        question: String(question || "").trim(),
        options: cleanedOptions,
        allow_multiple: !!allow_multiple,
    });
    poll.poll_id = poll._id.toString();
    await poll.save();
    return poll.toJSON();
}

toolFunctions.list_polls = async ({chat_id}: {chat_id: string}) => {
    return await listPolls(chat_id);
}

toolFunctions.search_polls = async ({chat_id, text}: {chat_id: string; text?: string}) => {
    const query: any = { chat_id };
    if (text && text.trim()) {
        query.question = { $regex: text.trim(), $options: "i" };
    }
    const polls = await Poll.find(query).sort({ createdAt: -1 }).limit(50);
    return polls.map(p => p.toJSON());
}

toolFunctions.update_poll = async ({chat_id, poll_id, question, options, allow_multiple}: {chat_id: string; poll_id: string; question?: string; options?: string[]; allow_multiple?: boolean}) => {
    const poll = await Poll.findOne({ chat_id, poll_id });
    if (!poll) throw new Error(`Poll ${poll_id} not found`);
    if (question !== undefined) poll.question = String(question).trim();
    if (options !== undefined) {
        const cleanedOptions = (options || []).map(o => String(o || "").trim()).filter(Boolean).slice(0, 12);
        if (cleanedOptions.length >= 2) poll.options = cleanedOptions;
    }
    if (allow_multiple !== undefined) poll.allow_multiple = !!allow_multiple;
    await poll.save();
    return poll.toJSON();
}

toolFunctions.delete_poll = async ({chat_id, poll_id}: {chat_id: string; poll_id: string}) => {
    const poll = await Poll.findOne({ chat_id, poll_id });
    if (!poll) throw new Error(`Poll ${poll_id} not found`);
    await poll.deleteOne();
    return "Poll deleted";
}

// Enough to answer both "which option won?" and "has everyone voted?" — the two
// things a group actually asks. Voters come back as NAMES, never phone numbers:
// the question is who voted, not everyone's contact details.
toolFunctions.get_poll_results = async ({chat_id, poll_id}: {chat_id: string; poll_id: string}) => {
    const poll = await Poll.findOne({ chat_id, poll_id });
    if (!poll) throw new Error(`Poll ${poll_id} not found`);
    const j: any = poll.toJSON();
    const results: any[] = j.results || [];

    const group: any = await Group.findOne({ chatId: chat_id }).lean();
    const members = u.stripBot(group?.participants || []).map((p: any) => u.phoneDigits(p)).filter(Boolean);
    const people = await Person.find({}).lean();
    const nameOf = new Map<string, string>();
    for (const p of people) nameOf.set(u.phoneDigits(p.phoneNumber), p.name);

    // One person can pick several options in a multi-select, so count distinct
    // voters rather than summing the per-option counts.
    const votersSeen = new Set<string>();
    for (const r of results) for (const v of (r.voters || [])) votersSeen.add(u.phoneDigits(v));

    const top = Math.max(0, ...results.map(r => r.count || 0));
    const leading = top > 0 ? results.filter(r => (r.count || 0) === top).map(r => r.name) : [];

    const pending = members.filter(d => !votersSeen.has(d));
    return {
        question: j.question,
        total_votes: j.total || 0,
        results: results.map(r => ({
            option: r.name,
            count: r.count || 0,
            voters: (r.voters || []).map((v: any) => nameOf.get(u.phoneDigits(v))).filter(Boolean),
        })),
        // More than one when it's a tie — say so rather than picking a winner.
        leading_options: leading,
        people_who_voted: votersSeen.size,
        group_size: members.length,
        everyone_voted: members.length > 0 && pending.length === 0,
        // Only those we can name; the rest are counted so the answer stays honest
        // about being partial rather than implying this is the full list.
        not_voted_names: pending.map(d => nameOf.get(d)).filter(Boolean),
        not_voted_unknown: pending.filter(d => !nameOf.get(d)).length,
        updatedAt: j.updatedAt,
    };
}

// Store the WhatsApp poll message id so incoming votes can be matched to this poll.
async function setPollWaMessageId(poll_id: string, wa_message_id: string) {
    await Poll.updateOne({ poll_id }, { $set: { wa_message_id } });
}

// Apply the latest tally from a whapi poll-vote update. Each update carries the
// full current result set (option name + count + voters), so we just overwrite.
async function recordPollVotes(waMessageId: string, pollObj: any) {
    if (!waMessageId || !pollObj || !Array.isArray(pollObj.results)) return null;
    const poll = await Poll.findOne({ wa_message_id: waMessageId });
    if (!poll) return null; // not one of our tracked polls
    const results = pollObj.results.map((r: any) => ({
        name: r.name,
        count: r.count || 0,
        voters: Array.isArray(r.voters) ? r.voters : [],
    }));
    poll.set("results", results);
    poll.set("total", typeof pollObj.total === "number" ? pollObj.total : results.reduce((s: number, r: any) => s + r.count, 0));
    poll.set("updatedAt", new Date());
    await poll.save();
    return poll.toJSON();
}

// Most recently active first — a listing is nearly always read looking for
// "what's alive", and groups Gepetel hasn't spoken in for months sink.
async function getGroupList() {
    return await Group.find().sort({ lastReplyAt: -1 });
}

// Append a review-log entry (never throws — logging must not break handling).
async function logInteraction(entry: { chatId: string; groupName?: string; isGroup?: boolean; author?: string; incoming?: string; action: string; reply?: string }) {
    try { await Interaction.create(entry); } catch (e) { console.error("logInteraction failed:", e); }
}

// Recent interactions for a group (newest first), within the ~2-week TTL window.
// `sinceMs` narrows to the last N milliseconds; omit it for everything retained.
// Note the Interaction TTL (14 days) is the real ceiling — there is nothing older
// to find, whatever window is asked for.
async function getInteractions(chatId: string, limit = 200, sinceMs?: number | null) {
    const query: any = { chatId };
    if (sinceMs) query.createdAt = { $gte: new Date(Date.now() - sinceMs) };
    return await Interaction.find(query).sort({ createdAt: -1 }).limit(limit).lean();
}

async function setParticipants(chatId: string, participants: string[], name?: string) {
    const now = new Date();
    const set: any = { participants, numParticipants: participants.length };
    if (name) set.name = name;
    await Group.updateOne(
        { chatId },
        {
            $set: set,
            $setOnInsert: { addedAt: now, nextUnpromptedAt: u.computeNextUnpromptedAt({ addedAt: now }) },
        },
        { upsert: true }
    );
}

async function newMessage(chatId: string, from: string, text: string, cb: Function, groupName?: string) {
    let group = await Group.findOne({ chatId });
    if (!group) group = new Group({chatId, lastChecked: new Date(Date.now() - 2000 * 60 * 60 * 24)});

    if (groupName && group.name !== groupName) group.name = groupName;

    // Refresh the roster once a day — or right now if we still don't have a name
    // for this group, so a single incoming message is enough to backfill it.
    if (group.lastChecked < new Date(Date.now() - 1000 * 60 * 60 * 24) || !group.name) {
        const info = await cb(chatId);
        const participants: string[] = Array.isArray(info?.participants) ? info.participants : [];
        if (participants.length > 0) {
            group.lastChecked = new Date();
            group.numParticipants = participants.length;
            group.participants = participants;
        }
        // whapi's group subject is authoritative — capture it whenever present.
        if (info?.name) group.name = info.name;
    }
    group.lastMessageTimestamp = new Date();
    await group.save();

    return {
        numberOfParticipants: group.numParticipants,
        previousMessageId: group.previousMessageId,
    };
}

async function saveMessage(chatId: string, from: string, text: string) {
    const message = new Message({chatId, from, text});
    await message.save();
}

// Atomically claim an incoming message id. Returns true the FIRST time we see it
// (caller should process it), false on any redelivery (caller should skip).
async function markMessageProcessed(messageId: string): Promise<boolean> {
    if (!messageId) return true; // no id to dedup on -> process it
    try {
        await ProcessedMessage.create({ messageId });
        return true;
    } catch (e: any) {
        if (e?.code === 11000) return false; // duplicate key -> already handled
        throw e;
    }
}

async function getGroupMetadata(chatId: string) {
    const group = await Group.findOne({chatId});
    if (!group) throw new Error(`Group ${chatId} not found`);
    return {
        numUnsentMessages: await Message.countDocuments({chatId}),
        numberOfParticipants: group.numParticipants,
        lastMessageTimestamp: group.lastMessageTimestamp,
        lastReplyAt: group.lastReplyAt,
        lastReplyText: group.lastReplyText,
        previousMessageId: group.previousMessageId,
        participants: group.participants || [],
    }
}

// Record that Gepetel sent a message to this group (reply or unprompted): resets
// the reply-gate window/counter and stores his last line so the gatekeeper can
// judge whether a later message is a genuine follow-up to him.
async function markGroupReplied(chatId: string, replyText: string = "") {
    await Group.updateOne({ chatId }, { $set: { lastReplyAt: new Date(), messagesSinceLastSend: 0, lastReplyText: replyText } });
}

// Claim the right to send one "I'm out of credits" heads-up in this chat.
// Atomic and throttled to once a day: while the account is empty EVERY message
// fails, and topping up isn't something anyone does within the hour — so
// repeating it more often than daily is just a broken bot nagging.
const CREDITS_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

async function claimCreditsNotice(chatId: string, windowMs = CREDITS_NOTICE_WINDOW_MS): Promise<boolean> {
    const cutoff = new Date(Date.now() - windowMs);
    const r = await Group.findOneAndUpdate(
        { chatId, $or: [{ lastCreditsNoticeAt: null }, { lastCreditsNoticeAt: { $lte: cutoff } }] },
        { $set: { lastCreditsNoticeAt: new Date() } },
        { new: true }
    );
    return !!r;
}

// One alert per chat per hour, claimed atomically. A jailbreak attempt is never a
// single message — the campaign in "Daily AI AI AI" was about fifteen back to back —
// so the useful signal is "something is happening in here", once, not a running
// commentary that trains Bogdan to swipe the notification away.
const INJECTION_ALERT_WINDOW_MS = 60 * 60 * 1000;

async function claimInjectionAlert(chatId: string, windowMs = INJECTION_ALERT_WINDOW_MS): Promise<boolean> {
    const cutoff = new Date(Date.now() - windowMs);
    const r = await Group.findOneAndUpdate(
        { chatId, $or: [{ lastInjectionAlertAt: null }, { lastInjectionAlertAt: { $lte: cutoff } }] },
        { $set: { lastInjectionAlertAt: new Date() } },
        { new: true }
    );
    return !!r;
}

// Read the cached (not-yet-consumed) messages for a group without deleting them.
async function getCachedMessages(chatId: string) {
    return await Message.find({ chatId }).sort({ timestamp: 1 }).lean();
}

// Track whether Gepetel is currently a member of a group (drives re-add greetings).
async function setBotPresent(chatId: string, present: boolean) {
    await Group.updateOne({ chatId }, { $set: { botPresent: present } });
}

// Names of group members we actually know (matched from People by phone digits).
// Most members are unknown until they speak, so this is usually a partial list.
async function getKnownMembers(chatId: string): Promise<string[]> {
    const group: any = await Group.findOne({ chatId }).lean();
    if (!group || !Array.isArray(group.participants)) return [];
    const wanted = new Set(group.participants.map((p: any) => String(p).replace(/\D/g, "")));
    const people = await Person.find({}).lean();
    const names: string[] = [];
    for (const p of people) {
        if (wanted.has(String(p.phoneNumber).replace(/\D/g, "")) && p.name) names.push(p.name);
    }
    return [...new Set(names)];
}

// Group members by number AND name — the two halves tagMembers needs to turn a
// name in an outgoing message into a real tag. Only people known by name, and
// never Gepetel himself.
async function getNamedMembers(chatId: string): Promise<NamedMember[]> {
    const group: any = await Group.findOne({ chatId }).lean();
    if (!group || !Array.isArray(group.participants)) return [];
    const wanted = new Set(u.stripBot(group.participants).map((p: any) => u.phoneDigits(p)));
    const people = await Person.find({}).lean();
    const out: NamedMember[] = [];
    for (const p of people) {
        const phone = u.phoneDigits(p.phoneNumber);
        if (wanted.has(phone) && p.name) out.push({ phone, name: p.name });
    }
    return out;
}

// Remember the most recent image in a chat so an "edit this" request can use it.
async function setLastImage(chatId: string, image: string) {
    await Group.updateOne({ chatId }, { $set: { lastImage: image } }, { upsert: true, setDefaultsOnInsert: true });
}
async function getLastImage(chatId: string): Promise<string> {
    const g: any = await Group.findOne({ chatId }).lean();
    return (g && g.lastImage) || "";
}

// Count one message toward the group's UTC hour-of-day activity histogram,
// and toward "messages since Gepetel last spoke".
async function recordActivity(chatId: string, when: Date = new Date()) {
    const hour = when.getUTCHours();
    await Group.updateOne({ chatId }, { $inc: { [`activityByHour.${hour}`]: 1, messagesSinceLastSend: 1 } });
}

// Estimate when a group is active (in UTC) from its activity histogram.
// Returns null until there is some data. (Pure math lives in util.)
async function getGroupActiveHoursUTC(chatId: string) {
    const group: any = await Group.findOne({ chatId }).lean();
    return u.activeHoursFromHistogram(group && group.activityByHour);
}

// --- Unprompted message scheduling (region/language/hour math lives in util) ---

const inferRegion = u.inferRegion;
const inferLanguage = u.inferLanguage;

// Groups whose unprompted message is due now AND that are currently active
// (>= minMessages incoming messages since Gepetel last spoke).
async function getGroupsDueForUnprompted(minMessages = 10) {
    // Lazily initialise nextUnpromptedAt for groups that predate this feature.
    const uninit = await Group.find({ chatId: /@g\.us$/, nextUnpromptedAt: null }).lean();
    for (const g of uninit) {
        await Group.updateOne({ chatId: g.chatId }, { $set: { nextUnpromptedAt: u.computeNextUnpromptedAt(g) } });
    }
    return await Group.find({
        chatId: /@g\.us$/,
        nextUnpromptedAt: { $lte: new Date() },
        messagesSinceLastSend: { $gte: minMessages },
    }).lean();
}

// Roll the next unprompted slot for a group.
async function scheduleNextUnprompted(chatId: string) {
    const group = await Group.findOne({ chatId }).lean();
    await Group.updateOne({ chatId }, { $set: { nextUnpromptedAt: u.computeNextUnpromptedAt(group) } });
}

// Return the cached (not-yet-ingested) messages newest-first and clear the cache.
// With `limit`, only the most recent N are returned for ingestion; any older
// surplus is still deleted (dropped), so a long quiet spell can't dump an
// unbounded backlog into the OpenAI conversation when Gepetel finally wakes up.
async function getLastMessagesThenDeleteThem(chatId: string, limit?: number) {
    const q = Message.find({chatId}).sort({timestamp: -1});
    if (limit && limit > 0) q.limit(limit);
    const messages = await q.lean();
    await Message.deleteMany({chatId});
    return messages;
}

async function updatePreviousMessageId(chatId: string, previousMessageId: string) {
    let group = await Group.findOne({ chatId });
    if (!group) return;
    group.previousMessageId = previousMessageId;
    await group.save();
}

async function isNewGroup(chatId: string) {
    const group = await Group.findOne({ chatId });
    return group?false:true;
}

async function getGroupById(_id: string) {
    return await Group.findOne({ _id });
}

async function getGroupByChatId(chatId: string) {
    return await Group.findOne({ chatId });
}

// Like markGroupReplied but does NOT reset messagesSinceLastSend — used for
// system-generated messages (payment announcements) that aren't reactive replies,
// so they don't suppress the unprompted-gossip counter.
async function recordGroupAnnouncement(chatId: string, replyText: string = "") {
    await Group.updateOne({ chatId }, { $set: { lastReplyAt: new Date(), lastReplyText: replyText } });
}

async function getPersonName(userChatId: string): Promise<string | null> {
    const digits = String(userChatId).replace(/\D/g, "");
    if (!digits) return null;
    const person: any = await Person.findOne({ phoneNumber: digits }).lean();
    return person?.name || null;
}

async function updatePeople({phoneNumber, name}: {phoneNumber: string, name: string}) {
    const digits = String(phoneNumber || "").replace(/\D/g, "");  // normalize: one record per person
    if (!digits || !name) return;
    await Person.updateOne({ phoneNumber: digits }, { name }, { upsert: true });
}

// Growth nudge thresholds: after this many group mentions AND at least this many
// days since their very first one, a user qualifies for the one-time DM.
const GROWTH_MENTION_THRESHOLD = 3;   // mentions needed before the first ask
const GROWTH_MIN_DAYS = 2;            // ...and how long they must have been around
// A single lifetime nudge meant anyone who ignored the first was never asked again.
// Follow-ups are allowed, but each one needs the cooldown AND another
// GROWTH_MENTION_THRESHOLD mentions since the last — so only people still actively
// using Gepetel are asked again, and nobody hears it more than GROWTH_MAX_NUDGES times.
const GROWTH_MAX_NUDGES = 3;
const GROWTH_REPEAT_DAYS = 45;

// Count one group mention/tag of Gepetel by a user, then atomically decide whether
// THIS mention is the one that should trigger the one-time growth DM. Returns
// { claimedNudge: true } to exactly one caller (the nudge flag is flipped in the
// same update), so concurrent webhooks can never double-send. claimedNudge is
// false on every other mention (not yet eligible, or already nudged).
async function recordUserMention(phoneNumber: string): Promise<{ claimedNudge: boolean; nudgeNumber?: number }> {
    const digits = String(phoneNumber || "").replace(/\D/g, "");
    if (!digits) return { claimedNudge: false };
    const now = new Date();
    // Increment the counter; stamp firstMentionAt only on the very first mention.
    await UserGrowth.updateOne(
        { phoneNumber: digits },
        { $inc: { mentionCount: 1 }, $setOnInsert: { firstMentionAt: now } },
        { upsert: true }
    );
    // Claim a nudge iff: enough mentions, around long enough, under the lifetime
    // cap, past the cooldown, and they've engaged afresh since the last one.
    // Written as one $expr so the "since the last nudge" comparisons can reference
    // sibling fields, and so legacy rows (nudgeSent with no nudgeCount) count as 1.
    const cutoff = new Date(now.getTime() - GROWTH_MIN_DAYS * 24 * 60 * 60 * 1000);
    const repeatCutoff = new Date(now.getTime() - GROWTH_REPEAT_DAYS * 24 * 60 * 60 * 1000);
    const sent = { $ifNull: ["$nudgeCount", { $cond: ["$nudgeSent", 1, 0] }] };
    const claimed = await UserGrowth.findOneAndUpdate(
        {
            phoneNumber: digits,
            firstMentionAt: { $lte: cutoff },
            $expr: {
                $and: [
                    { $lt: [sent, GROWTH_MAX_NUDGES] },
                    // Fresh mentions since the last ask (or since zero, first time round).
                    { $gte: ["$mentionCount", { $add: [{ $ifNull: ["$mentionsAtLastNudge", 0] }, GROWTH_MENTION_THRESHOLD] }] },
                    // Never nudged, or the cooldown has passed.
                    { $or: [
                        { $eq: [{ $ifNull: ["$nudgeSentAt", null] }, null] },
                        { $lte: ["$nudgeSentAt", repeatCutoff] },
                    ] },
                ],
            },
        },
        [{ $set: {
            nudgeSent: true,
            nudgeSentAt: now,
            nudgeCount: { $add: [sent, 1] },
            mentionsAtLastNudge: "$mentionCount",
        } }],
        { new: true }
    );
    return { claimedNudge: !!claimed, nudgeNumber: claimed?.nudgeCount || 1 };
}

async function addMemory(chatId: string, summary: string, details?: string, tags?: string[]) {
    const cleanSummary = String(summary || "").trim().slice(0, 240);
    const cleanDetails = String(details || "").trim().slice(0, 1200);
    const cleanTags = (tags || []).map(t => String(t).trim()).filter(Boolean).slice(0, 8);
    if (!cleanSummary) throw new Error("Summary is required");
    const memory = new Memory({ chatId, summary: cleanSummary, details: cleanDetails, tags: cleanTags });
    await memory.save();
    return memory.toJSON();
}

async function listMemories(chatId: string, { tag, limit = 10 }: { tag?: string; limit?: number }) {
    const query: any = { chatId };
    if (tag) query.tags = tag;
    return await Memory.find(query).sort({ createdAt: -1 }).limit(limit).lean();
}

async function deleteMemory(chatId: string, memoryId: string) {
    const memory = await Memory.findOne({ chatId, _id: memoryId });
    if (!memory) throw new Error(`Memory ${memoryId} not found`);
    await memory.deleteOne();
    return "Memory deleted";
}

async function getRecentMemoriesText(chatId: string, limit = 10) {
    const memories = await listMemories(chatId, { limit });
    if (!memories.length) return "";
    return memories
        .map(m => {
            const parts = [`- ${m.summary}`];
            if (m.details) parts.push(`Details: ${m.details}`);
            if (m.tags?.length) parts.push(`Tags: ${m.tags.join(", ")}`);
            return parts.join(" | ");
        })
        .join("\n");
}

async function listReminders(chatId: string) {
    const reminders = await Reminder.find({ chat_id: chatId, due_date: { $gt: new Date() } }).sort({ due_date: 1 }).limit(50);
    return reminders.map(r => r.toJSON());
}

async function listActionItems(chatId: string) {
    const items = await ActionItem.find({ chat_id: chatId }).sort({ createdAt: -1 }).limit(100);
    return items.map(i => i.toJSON());
}

async function searchActionItems(chatId: string, text?: string) {
    const query: any = { chat_id: chatId };
    if (text && text.trim()) {
        query.$or = [
            { title: { $regex: text.trim(), $options: "i" } },
            { assignee: { $regex: text.trim(), $options: "i" } },
            { status: { $regex: text.trim(), $options: "i" } },
        ];
    }
    const items = await ActionItem.find(query).sort({ createdAt: -1 }).limit(100);
    return items.map(i => i.toJSON());
}

// Groups that a given WhatsApp user (by their chat/phone ID) is a participant of.
// Used to build the group picker in the DM upsell flow.
async function getGroupsByParticipant(userChatId: string): Promise<{ name: string; chatId: string; dailyReplyLimit: number }[]> {
    const digits = String(userChatId).replace(/\D/g, "");
    if (!digits) return [];
    // Participants are stored either as bare digits ("40711") or suffixed
    // ("40711@s.whatsapp.net"). Match the full number as a whole token: it must
    // start at a boundary (start-of-string or a non-digit like "+") and end at a
    // boundary ("@" or end-of-string), so "40711" never matches "407112345".
    const groups: any[] = await Group.find({ participants: new RegExp('(?:^|\\D)' + digits + '(?:@|$)') }).lean();
    if (!groups.length) return [];

    // For groups we don't have a real name for yet, build a human-friendly label
    // like "the group with Ana" from the members we know (excluding the bot and
    // the user we're talking to). Resolve known names once from the People list.
    const people = await Person.find({}).lean();
    const nameByPhone = new Map<string, string>();
    for (const p of people) nameByPhone.set(String(p.phoneNumber).replace(/\D/g, ""), p.name);

    const friendlyName = (g: any): string => {
        if (g.name) return g.name;
        const others = u.stripBot(g.participants || [])
            .map((p: any) => String(p).replace(/\D/g, ""))
            .filter((d: string) => d && d !== digits);
        const names = [...new Set(others.map((d: string) => nameByPhone.get(d)).filter(Boolean))] as string[];
        if (names.length === 0) return "an unnamed group";
        if (names.length === 1) return `the group with ${names[0]}`;
        if (names.length === 2) return `the group with ${names[0]} and ${names[1]}`;
        return `the group with ${names[0]}, ${names[1]} and ${names.length - 2} others`;
    };

    return groups.map(g => {
        // A schedule needs a timezone, and "9am" means nothing without one. We can
        // guess from the members' phone prefixes, but that guess is only worth
        // trusting when they all point at the same country — a mixed group has to
        // be confirmed with the person instead of quietly assumed.
        const members = u.stripBot(g.participants || []);
        const countries = new Set(
            members.map((p: any) => u.countryOf(p)).filter(Boolean)
        );
        return {
            name: friendlyName(g),
            chatId: g.chatId,
            dailyReplyLimit: typeof g.dailyReplyLimit === "number" ? g.dailyReplyLimit : 20,
            timezone: u.inferTimezone(members),
            timezoneConfident: countries.size === 1,
        };
    });
}

async function setDailyReplyLimit(chatId: string, limit: number) {
    await Group.updateOne({ chatId }, { $set: { dailyReplyLimit: limit } });
}

// Add `additional` to a group's daily limit, but only ONCE per group (the free
// extension). Atomic: the filter requires freeExtensionUsed != true, so a second
// concurrent/repeat call can't apply. Returns { alreadyUsed } or { newLimit, previous }.
async function extendDailyLimitOnce(chatId: string, additional: number, email: string = ""): Promise<{ alreadyUsed?: boolean; newLimit?: number; previous?: number; notFound?: boolean }> {
    const group: any = await Group.findOne({ chatId }).lean();
    if (!group) return { notFound: true };
    if (group.freeExtensionUsed) return { alreadyUsed: true };
    const previous = typeof group.dailyReplyLimit === "number" ? group.dailyReplyLimit : 20;
    const newLimit = Math.min(MAX_DAILY_LIMIT_DB, previous + additional);
    const r = await Group.updateOne(
        { chatId, freeExtensionUsed: { $ne: true } },
        { $set: { dailyReplyLimit: newLimit, freeExtensionUsed: true, extensionEmail: email } }
    );
    if (!r.modifiedCount) return { alreadyUsed: true }; // lost the race
    return { newLimit, previous };
}
const MAX_DAILY_LIMIT_DB = 10000;

// --- Daily reply limit ---

// Check whether this group has hit its daily reply limit (UTC-day based).
// Automatically resets counters when the UTC date has rolled over.
// Returns the current limit state without modifying the reply/warning counts.
async function checkDailyLimit(chatId: string): Promise<{ limitReached: boolean }> {
    const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" UTC
    // Atomic stale-day reset: the filter only matches when the stored reset date
    // is not today, so under concurrent first-of-day messages exactly one writer
    // does the reset (the rest are no-ops) instead of racing read-then-write.
    await Group.updateOne(
        { chatId, dailyResetDate: { $ne: today } },
        { $set: { dailyReplyCount: 0, dailyLimitWarningCount: 0, dailyResetDate: today } }
    );
    const group: any = await Group.findOne({ chatId }).lean();
    if (!group) return { limitReached: false };
    const limit: number = typeof group.dailyReplyLimit === "number" ? group.dailyReplyLimit : 20;
    return { limitReached: (group.dailyReplyCount || 0) >= limit };
}

async function incrementDailyReplyCount(chatId: string) {
    await Group.updateOne({ chatId }, { $inc: { dailyReplyCount: 1 } });
}

// Atomically claim one of the two daily limit-warning slots. Returns true if this
// caller got a slot (and should send the "limit reached" message), false if both
// warnings have already been used today. The $lt guard + $inc in a single
// findOneAndUpdate makes "send it exactly twice" hold even under concurrent
// webhook invocations (no read-then-write race that could emit a third warning).
async function claimDailyLimitWarning(chatId: string): Promise<boolean> {
    const r = await Group.findOneAndUpdate(
        { chatId, dailyLimitWarningCount: { $lt: 2 } },
        { $inc: { dailyLimitWarningCount: 1 } },
        { new: true }
    );
    return !!r;
}

async function listPolls(chatId: string) {
    const polls = await Poll.find({ chat_id: chatId }).sort({ createdAt: -1 }).limit(50);
    return polls.map(p => p.toJSON());
}




// --- Shared expenses ---

// Round a major-unit amount ("124", "12.34") to integer minor units.
function toMinor(amount: any): number {
    const n = Number(amount);
    if (!isFinite(n)) throw new Error(`"${amount}" isn't an amount I can use`);
    return Math.round(n * 100);
}

// Record one expense. `paid_by` may hold several people; `split_between` is who
// shares the cost, split evenly unless explicit shares are given.
toolFunctions.record_expense = async ({ chat_id, description, total, currency, paid_by, split_between, shares }: any) => {
    const payers = (Array.isArray(paid_by) ? paid_by : [])
        .map((p: any) => ({ name: String(p.name || "").trim(), amount: toMinor(p.amount) }))
        .filter((p: any) => p.name && p.amount > 0);
    if (!payers.length) throw new Error("I need to know who paid, and how much");

    const paid = payers.reduce((s: number, p: any) => s + p.amount, 0);
    // The total is whatever changed hands. Trust the payers over a stated total:
    // "124 and I tipped 20" means 144 went out, whichever number they said first.
    const totalMinor = total !== undefined && total !== null ? toMinor(total) : paid;
    if (paid !== totalMinor) {
        throw new Error(`the payments add up to ${paid / 100} but the total says ${totalMinor / 100} — which is right?`);
    }

    const people = (Array.isArray(split_between) ? split_between : []).map((n: any) => String(n || "").trim()).filter(Boolean);
    if (!people.length) throw new Error("I need to know who this is split between");

    let split: { name: string; amount: number }[];
    if (Array.isArray(shares) && shares.length === people.length) {
        split = shares.map((a: any, i: number) => ({ name: people[i], amount: toMinor(a) }));
        const sum = split.reduce((s, x) => s + x.amount, 0);
        if (sum !== totalMinor) throw new Error(`those shares add up to ${sum / 100}, not ${totalMinor / 100}`);
    } else {
        split = u.splitEvenly(totalMinor, people.length).map((a, i) => ({ name: people[i], amount: a }));
    }

    const doc = new Expense({
        chat_id, description: String(description || "").slice(0, 120),
        currency: String(currency || "RON").toUpperCase(),
        payers, shares: split, kind: "expense",
    });
    doc.expense_id = doc._id.toString();
    await doc.save();
    return { recorded: doc.description || "expense", ...(await balancesFor(chat_id)) };
};

// A repayment: money moving from one person to another to clear a debt. Modelled
// as an expense the payer covers entirely on the other person's behalf, so the
// same arithmetic settles it.
toolFunctions.record_settlement = async ({ chat_id, from, to, amount, currency }: any) => {
    const payer = String(from || "").trim(), payee = String(to || "").trim();
    if (!payer || !payee) throw new Error("I need to know who paid whom");
    if (payer === payee) throw new Error("that's the same person on both sides");
    const minor = toMinor(amount);
    if (minor <= 0) throw new Error("the amount has to be more than zero");
    const doc = new Expense({
        chat_id, description: `${payer} → ${payee}`,
        currency: String(currency || "RON").toUpperCase(),
        payers: [{ name: payer, amount: minor }],
        shares: [{ name: payee, amount: minor }],
        kind: "settlement",
    });
    doc.expense_id = doc._id.toString();
    await doc.save();
    return { settled: `${payer} paid ${payee}`, ...(await balancesFor(chat_id)) };
};

// Who owes whom, per currency, already reduced to the fewest payments.
async function balancesFor(chatId: string) {
    const entries: any[] = await Expense.find({ chat_id: chatId }).lean();
    const books = u.computeBalances(entries as any);
    const out: any = { balances: [] as any[] };
    for (const [currency, book] of Object.entries(books)) {
        out.balances.push({
            currency,
            who_owes_whom: u.settleUp(book).map(t => ({
                from: t.from, to: t.to, amount: u.formatAmount(t.amount, currency),
            })),
            net: Object.entries(book)
                .sort((a, b) => b[1] - a[1])
                .map(([name, v]) => ({ name, position: u.formatAmount(v, currency) })),
        });
    }
    if (!out.balances.length) out.note = "nothing owed — everyone is square";
    return out;
}

toolFunctions.get_balances = async ({ chat_id }: any) => await balancesFor(chat_id);

// The full history, not just a summary — "ce am cheltuit?" deserves the actual
// list. Capped so a long-running tab can't flood the model's context, and says so
// when it truncates rather than quietly presenting a partial list as complete.
const EXPENSE_HISTORY_LIMIT = 60;

toolFunctions.list_expenses = async ({ chat_id, limit }: any) => {
    const total = await Expense.countDocuments({ chat_id });
    const want = Math.min(Math.max(1, Number(limit) || EXPENSE_HISTORY_LIMIT), EXPENSE_HISTORY_LIMIT);
    const rows: any[] = await Expense.find({ chat_id }).sort({ createdAt: -1 }).limit(want).lean();
    const entries = rows.map(r => ({
        internal_id_do_not_show: r.expense_id,
        what: r.description || "(no description)",
        amount: u.formatAmount((r.payers || []).reduce((s: number, p: any) => s + p.amount, 0), r.currency),
        // Per-person detail, so "cine cât a pus" can be answered from the history.
        paid_by: (r.payers || []).map((p: any) => `${p.name} ${u.formatAmount(p.amount, r.currency)}`).join(", "),
        split_between: (r.shares || []).map((x: any) => `${x.name} ${u.formatAmount(x.amount, r.currency)}`).join(", "),
        kind: r.kind,
        when: r.createdAt,
    }));
    return total > entries.length
        ? { entries, showing: entries.length, total, note: `showing the ${entries.length} most recent of ${total}` }
        : { entries, showing: entries.length, total };
};

// Reconcile a tab that ended up in several currencies into one.
//
// Recorded rather than merely displayed: it writes a pair of entries per currency
// — one that zeroes the old book, one that recreates the same positions in the
// target — so the conversion is part of the ledger's history and a later "how did
// we get here?" has an answer, including the rate and its date.
toolFunctions.convert_balances = async ({ chat_id, to_currency }: any) => {
    const target = String(to_currency || "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(target)) throw new Error(`"${to_currency}" isn't a currency I recognise`);

    const entries: any[] = await Expense.find({ chat_id }).lean();
    const books = u.computeBalances(entries as any);
    const others = Object.keys(books).filter(c => c !== target);
    if (!others.length) {
        return { converted: [], ...(await balancesFor(chat_id)),
                 note: Object.keys(books).length ? `everything is already in ${target}` : "nothing owed — everyone is square" };
    }

    const used: any[] = [];
    for (const from of others) {
        const quote = await fx.getRate(from, target);
        if (!quote) throw new Error(`I couldn't get a ${from}->${target} rate just now — try again in a bit`);
        const book = books[from];
        const converted = u.convertBook(book, quote.rate);

        // Close the old currency: everyone who was owed now "shares" that amount,
        // everyone who owed "pays" it, which nets the whole book to zero.
        const closing = new Expense({
            chat_id, kind: "conversion", currency: from,
            description: `conversie ${from} → ${target} (curs ${quote.rate})`,
            payers: Object.entries(book).filter(([, v]) => v < 0).map(([name, v]) => ({ name, amount: -v })),
            shares: Object.entries(book).filter(([, v]) => v > 0).map(([name, v]) => ({ name, amount: v })),
        });
        closing.expense_id = closing._id.toString();
        await closing.save();

        // Reopen the same positions in the target currency.
        const opening = new Expense({
            chat_id, kind: "conversion", currency: target,
            description: `conversie ${from} → ${target} (curs ${quote.rate})`,
            payers: Object.entries(converted).filter(([, v]) => v > 0).map(([name, v]) => ({ name, amount: v })),
            shares: Object.entries(converted).filter(([, v]) => v < 0).map(([name, v]) => ({ name, amount: -v })),
        });
        opening.expense_id = opening._id.toString();
        await opening.save();

        used.push({ from, to: target, rate: quote.rate, rate_date: quote.date || "latest available" });
    }
    return { converted: used, ...(await balancesFor(chat_id)) };
};

toolFunctions.delete_expense = async ({ chat_id, expense_id }: any) => {
    const doc = await Expense.findOne({ chat_id, expense_id });
    if (!doc) throw new Error(`I can't find that one`);
    await doc.deleteOne();
    return { deleted: doc.description || "expense", ...(await balancesFor(chat_id)) };
};

// --- Message archive (reply resolution) ---

// Record what a message said, under its WhatsApp id. Called for EVERY incoming
// message, awake or not — a reply can quote something Gepetel never answered, so
// archiving only what he replied to would miss most of it.
async function archiveMessage(chatId: string, messageId: string, from: string, text: string) {
    if (!messageId || !text) return;
    try {
        await MessageArchive.updateOne(
            { messageId },
            { $set: { chatId, from: from || "", text: String(text).slice(0, 2000) } },
            { upsert: true }
        );
    } catch (e) {
        // A duplicate id is a webhook redelivery, not a problem worth failing on.
    }
}

// Turn "@40712345678" into "@Ana" for people we know by name.
//
// The gateway resolves a mention's LID to a phone number, which makes the text
// match the roster — but a bare number in front of the model is barely more
// readable than the LID was, and phone numbers are kept away from it everywhere
// else (group members, poll voters). An unknown number is left alone: it is a
// visible sign the mapping is missing, which is more useful than a placeholder.
async function resolveMentionNames(text: string): Promise<string> {
    const body = String(text || "");
    const tags = [...new Set((body.match(/@\+?\d{7,20}\b/g) || []))];
    if (!tags.length) return body;
    const people = await Person.find({}).lean();
    const nameOf = new Map<string, string>();
    for (const p of people) nameOf.set(u.phoneDigits(p.phoneNumber), p.name);
    let out = body;
    for (const tag of tags) {
        const name = nameOf.get(u.phoneDigits(tag));
        if (name) out = out.split(tag).join(`@${name}`);
    }
    return out;
}

// The last N messages in a chat, oldest first — the conversation window sent to
// the model each turn, in place of an ever-growing previous_response_id thread.
// Both sides are here because Gepetel's own lines are archived too.
// `at` is carried through, not just used for sorting: 50 messages with no clock
// read as one continuous conversation even when they span a week, and the model
// then treats last Tuesday's plans as today's. windowAsInput turns these into
// gaps.
async function getRecentMessages(chatId: string, limit = 50): Promise<{ from: string; text: string; at?: Date }[]> {
    const docs: any[] = await MessageArchive.find({ chatId })
        .sort({ createdAt: -1 }).limit(Math.max(1, limit)).lean();
    return docs.reverse().map(d => ({
        from: d.from || "",
        // One long image description or transcription must not crowd out the
        // other 49 messages.
        text: String(d.text || "").slice(0, 500),
        at: d.createdAt ? new Date(d.createdAt) : undefined,
    }));
}

// What was said in the quoted message, or null when it's outside what we kept.
async function getArchivedMessage(messageId: string): Promise<{ from: string; text: string } | null> {
    if (!messageId) return null;
    const doc: any = await MessageArchive.findOne({ messageId }).lean();
    return doc ? { from: doc.from || "", text: doc.text || "" } : null;
}

// --- 1:1 abuse gate ---

// Deliberately generous: a real person having a long conversation should never
// hit these. They exist to stop automated or wholesale use, not to ration help.
const DM_DAILY_LIMIT = 40;          // messages per person per UTC day
const DM_BURST_LIMIT = 12;          // ...and per DM_BURST_MINUTES
const DM_BURST_MINUTES = 10;
const DM_NOTICE_COOLDOWN_MS = 60 * 60 * 1000;   // how often we bother saying so

// Count one incoming 1:1 message and decide whether to answer it.
// Counters are advanced in a single atomic pipeline update so concurrent
// messages can't race past the cap.
async function claimDmMessage(chatId: string, now: Date = new Date()): Promise<{
    allowed: boolean; reason?: "daily" | "burst"; shouldTell: boolean;
}> {
    const dayKey = now.toISOString().slice(0, 10);
    const windowCutoff = new Date(now.getTime() - DM_BURST_MINUTES * 60 * 1000);
    const sameDay = { $eq: ["$dayKey", dayKey] };
    const inWindow = { $gte: [{ $ifNull: ["$windowStart", new Date(0)] }, windowCutoff] };

    const doc: any = await DmQuota.findOneAndUpdate(
        { chatId },
        [{ $set: {
            dayKey,
            dayCount: { $cond: [sameDay, { $add: [{ $ifNull: ["$dayCount", 0] }, 1] }, 1] },
            windowStart: { $cond: [inWindow, "$windowStart", now] },
            windowCount: { $cond: [inWindow, { $add: [{ $ifNull: ["$windowCount", 0] }, 1] }, 1] },
        } }],
        { new: true, upsert: true }
    );

    const overDaily = doc.dayCount > DM_DAILY_LIMIT;
    const overBurst = doc.windowCount > DM_BURST_LIMIT;
    if (!overDaily && !overBurst) return { allowed: true, shouldTell: false };

    // Say why once an hour at most. Past that, stay silent rather than answering
    // every message with the same refusal — that IS the flood, just from our side.
    const notice: any = await DmQuota.findOneAndUpdate(
        { chatId, $or: [{ noticeAt: null }, { noticeAt: { $lte: new Date(now.getTime() - DM_NOTICE_COOLDOWN_MS) } }] },
        { $set: { noticeAt: now } },
        { new: true }
    );
    return { allowed: false, reason: overDaily ? "daily" : "burst", shouldTell: !!notice };
}

// --- Scheduled tasks ---

// The timezone a group's schedule should be read in, inferred from its members'
// phone numbers (same rule the prompts already use for "what time is it there").
async function groupTimezone(chatId: string): Promise<string> {
    const group: any = await Group.findOne({ chatId }).lean();
    return u.inferTimezone(u.stripBot(group?.participants || []));
}

// Who is asking. `admin` is the operator behind Basic auth; `requesterChatId` is
// a real person's 1:1 chat id. Fail-closed by design: a caller that supplies
// neither is rejected, so forgetting to pass context can never widen access.
export type TaskContext = { admin?: boolean; requesterChatId?: string };

// The authorization gate for every scheduled-task operation. Returns the group.
//
// Membership is re-checked against the database on every call. The list of a
// user's groups is also injected into the DM prompt, but that is only there so
// the model can talk about groups by name — it is never the thing that decides
// access. A model that invents or is talked into a chat_id still gets stopped
// here, because a group the requester isn't in simply won't match.
async function assertGroupAccess(chatId: string, ctx: TaskContext) {
    const chat_id = String(chatId || "").trim();
    if (!u.isGroupChatId(chat_id)) throw new Error("chat_id must be a WhatsApp group id (…@g.us)");

    const group: any = await Group.findOne({ chatId: chat_id }).lean();
    if (!group) throw new Error(`I'm not in a group with id ${chat_id}`);
    if (ctx?.admin) return group;

    const requester = u.phoneDigits(ctx?.requesterChatId);
    if (!requester) throw new Error("no requester — refusing to touch a scheduled task without knowing who is asking");
    if (!u.isParticipant(group.participants || [], requester)) {
        // Deliberately vague: don't confirm the group exists to a non-member.
        throw new Error("you're not a member of that group, so I can't schedule anything there");
    }
    return group;
}

// A group can only hold so many schedules before it becomes the noise it was
// meant to avoid. This is also the backstop against a fan-out: when a pattern
// can't be expressed, the model's instinct is to create one task per date, and
// nothing else stops it at 52.
const MAX_TASKS_PER_GROUP = 20;

async function createScheduledTask(input: {
    chat_id: string;
    kind: string;
    payload: any;
    hour_local: number;
    days_of_week?: unknown;      // weekly: which weekdays
    interval_weeks?: unknown;    // weekly: 2 = fortnightly (needs an anchor)
    anchor_date?: string;        // weekly: which week counts as week zero
    days_of_month?: unknown;     // monthly: which days of the month
    run_on_date?: string;        // one-off: a single "YYYY-MM-DD" instead
    title?: string;
    created_by?: string;
    created_by_name?: string;
    timezone?: string;
}, ctx: TaskContext) {
    const chat_id = String(input.chat_id || "").trim();
    await assertGroupAccess(chat_id, ctx);

    const hour = Number(input.hour_local);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        throw new Error("hour_local must be a whole number between 0 and 23 (the group's local time)");
    }
    // A task either repeats on given weekdays, or runs once on a given date.
    // Both paths throw a user-readable message when the input is unusable, so a
    // bad schedule fails here rather than silently never firing.
    const timezone = input.timezone || await groupTimezone(chat_id);
    let runOnDate: string | null = null;
    let days: number[] = [];
    let monthDays: number[] = [];
    let intervalWeeks = 1;
    let anchorDate: string | null = null;
    if (input.run_on_date) {
        runOnDate = String(input.run_on_date).trim();
        if (!u.isValidLocalDate(runOnDate)) {
            throw new Error("run_on_date must be a real calendar date as YYYY-MM-DD");
        }
        // Today is fine (later the same day still fires); yesterday never would.
        const today = u.localParts(new Date(), timezone).ymd;
        if (runOnDate < today) throw new Error(`${runOnDate} is in the past — pick today or a later date`);
    } else if (input.days_of_month !== undefined && input.days_of_month !== null
               && !(Array.isArray(input.days_of_month) && input.days_of_month.length === 0)) {
        monthDays = u.normalizeDaysOfMonth(input.days_of_month);
    } else {
        days = u.normalizeDaysOfWeek(input.days_of_week);
        if (input.interval_weeks !== undefined && input.interval_weeks !== null) {
            const n = Number(input.interval_weeks);
            if (!Number.isInteger(n) || n < 1 || n > 12) {
                throw new Error("interval_weeks must be a whole number of weeks between 1 and 12");
            }
            intervalWeeks = n;
        }
        // "Every other Friday" is undefined until we say which Friday is week
        // zero, so anchor it — to today's local week unless told otherwise.
        if (intervalWeeks > 1) {
            anchorDate = String(input.anchor_date || "").trim() || u.localParts(new Date(), timezone).ymd;
            if (!u.isValidLocalDate(anchorDate)) throw new Error("anchor_date must be a real date as YYYY-MM-DD");
        }
    }
    const payload = u.validateTaskPayload(input.kind, input.payload);

    const existing = await ScheduledTask.countDocuments({ chat_id });
    if (existing >= MAX_TASKS_PER_GROUP) {
        throw new Error(
            `that group already has ${existing} scheduled items, which is the most I'll keep. ` +
            `Delete one first — and if you're adding the same thing on many dates, say the pattern instead ` +
            `("every other Friday") so it's one schedule rather than dozens.`
        );
    }

    const task = new ScheduledTask({
        chat_id,
        kind: input.kind,
        payload,
        hour_local: hour,
        days_of_week: days,
        interval_weeks: intervalWeeks,
        anchor_date: anchorDate,
        days_of_month: monthDays,
        run_on_date: runOnDate,
        timezone,
        title: String(input.title || "").trim() || defaultTaskTitle(input.kind, payload),
        // Attribution always comes from the verified caller, never from the model.
        created_by: ctx?.requesterChatId || input.created_by || "",
        created_by_name: input.created_by_name || "",
    });
    task.task_id = task._id.toString();
    await task.save();
    return task.toJSON();
}

// A short label for listings, so a task is recognisable without opening it.
function defaultTaskTitle(kind: string, payload: any): string {
    if (kind === "poll") return `Poll: ${payload.question}`;
    if (kind === "generated") return String(payload.instruction || "").slice(0, 60);
    return String(payload.text || "").slice(0, 60);
}

// List tasks the caller is allowed to see: everything for an admin, and only the
// groups they actually belong to for a real user.
async function listScheduledTasks(chatId: string | undefined, ctx: TaskContext) {
    let query: any = {};
    if (ctx?.admin) {
        if (chatId) query.chat_id = chatId;
    } else {
        const allowed = (await getGroupsByParticipant(ctx?.requesterChatId || "")).map(g => g.chatId);
        if (!allowed.length) return [];
        // Narrowing to one group is only honoured if it's one of theirs.
        query.chat_id = chatId && allowed.includes(chatId)
            ? chatId                       // narrowing to one of their own groups
            : { $in: chatId ? [] : allowed };   // asked for a group that isn't theirs -> match nothing
    }
    // Capped low on purpose. These go straight into the model's context on any
    // "what's scheduled?", and a fanned-out schedule used to put 50+ near-identical
    // records in front of it — expensive, and impossible to answer usefully from.
    const tasks = await ScheduledTask.find(query).sort({ createdAt: -1 }).limit(25).lean();
    // Resolve group names once, so callers can talk about "Noi 2" rather than a jid.
    const names = new Map<string, string>();
    for (const g of await Group.find({ chatId: { $in: [...new Set(tasks.map((t: any) => t.chat_id))] } })
                                .select("chatId name").lean() as any[]) {
        names.set(g.chatId, g.name || "");
    }
    return tasks.map((t: any) => ({
        ...t,
        schedule: u.describeSchedule(t as any),
        group_name: names.get(t.chat_id) || "",
    }));
}

// Load a task and re-check that the caller may touch the group it targets.
async function getScheduledTask(taskId: string, ctx: TaskContext) {
    const task = await ScheduledTask.findOne({ task_id: String(taskId || "").trim() });
    // Same message whether it's missing or forbidden — don't leak that it exists.
    if (!task) throw new Error(`Scheduled task ${taskId} not found`);
    await assertGroupAccess(task.chat_id, ctx).catch(() => {
        throw new Error(`Scheduled task ${taskId} not found`);
    });
    return task;
}

async function updateScheduledTask(taskId: string, patch: any, ctx: TaskContext) {
    const task = await getScheduledTask(taskId, ctx);

    // A task cannot be re-pointed at another group: that would let someone edit
    // their way into a group they were never allowed to create a task for.
    if (patch.chat_id !== undefined && String(patch.chat_id).trim() !== task.chat_id) {
        throw new Error("a scheduled task can't be moved to a different group — delete it and create a new one");
    }

    if (patch.hour_local !== undefined) {
        const hour = Number(patch.hour_local);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("hour_local must be between 0 and 23");
        task.hour_local = hour;
    }
    if (patch.days_of_week !== undefined) {
        task.set("days_of_week", u.normalizeDaysOfWeek(patch.days_of_week));
        task.set("days_of_month", []);      // the two are mutually exclusive
    }
    if (patch.interval_weeks !== undefined) {
        const n = Number(patch.interval_weeks);
        if (!Number.isInteger(n) || n < 1 || n > 12) throw new Error("interval_weeks must be between 1 and 12");
        task.set("interval_weeks", n);
        if (n > 1 && !task.anchor_date) {
            task.set("anchor_date", u.localParts(new Date(), task.timezone || "UTC").ymd);
        }
    }
    if (patch.days_of_month !== undefined) {
        task.set("days_of_month", u.normalizeDaysOfMonth(patch.days_of_month));
        task.set("days_of_week", []);
    }
    if (patch.active !== undefined) task.active = !!patch.active;
    if (patch.timezone !== undefined) task.timezone = String(patch.timezone);
    if (patch.payload !== undefined) {
        // Re-validate against the (possibly new) kind, and merge so a caller can
        // change just the question without re-sending every option.
        const kind = patch.kind || task.kind;
        const merged = u.validateTaskPayload(kind, { ...(task.payload || {}), ...patch.payload });
        task.kind = kind;
        task.set("payload", merged);
        if (!patch.title) task.title = defaultTaskTitle(kind, merged);
    }
    if (patch.title !== undefined) task.title = String(patch.title).trim();
    task.updatedAt = new Date();
    await task.save();
    return task.toJSON();
}

async function deleteScheduledTask(taskId: string, ctx: TaskContext) {
    const task = await getScheduledTask(taskId, ctx);
    await task.deleteOne();
    return "Scheduled task deleted";
}

// What Gepetel posted, phrased for his own memory. This is fed back as a cached
// message so that the next time he genuinely wakes up he knows he posted it,
// instead of being baffled by a group discussing a poll he has no record of.
function describeSentForContext(kind: string, payload: any, sentText: string): string {
    if (kind === "poll") {
        return `[poll] ${payload.question} — options: ${(payload.options || []).join(", ")}`;
    }
    return sentText;
}

// The name to credit a scheduled post to. Prefer the name captured when the task
// was created, then whatever we know about that number today.
async function schedulerName(task: any): Promise<string> {
    if (task.created_by_name) return task.created_by_name;
    if (!task.created_by) return "";
    return (await getPersonName(task.created_by)) || "";
}

export type ScheduledTaskDeps = {
    sendMessage: (to: string, message: string, mentions?: string[]) => Promise<any>;
    sendPoll: (to: string, question: string, options: string[], allowMultiple: boolean) => Promise<any>;
    generate?: (task: any, group: any) => Promise<string | null>;
    // Whether `mentions` on sendMessage turn into real tags (see util.tagMembers).
    // Off by default, so a test double or an older gateway never sees raw numbers.
    supportsMentions?: boolean;
};

// Post one scheduled task into its group. Shared by the cron and the "run it
// now" admin action, so both behave identically — including the silence rules
// described on fireDueScheduledTasks below.
async function deliverScheduledTask(t: any, deps: ScheduledTaskDeps): Promise<{ sent: boolean; reason?: string; text?: string }> {
    const group: any = await Group.findOne({ chatId: t.chat_id }).lean();
    if (!group || group.botPresent === false) {
        // Gepetel isn't in that group any more — pause the task rather than
        // failing forever, so it shows as paused in the admin UI instead of
        // quietly erroring every hour.
        await ScheduledTask.updateOne({ _id: t._id }, { $set: { active: false } });
        return { sent: false, reason: "not-in-group" };
    }

    // Credit whoever set this up, so the group knows why it keeps arriving.
    const via = await schedulerName(t);

    let sentText = "";
    let sentId: any = null;
    if (t.kind === "poll") {
        const question = u.attributeToScheduler("poll", t.payload.question, via);
        const waMessageId = await deps.sendPoll(
            t.chat_id, question, t.payload.options || [], !!t.payload.allow_multiple
        );
        sentId = waMessageId;
        // Register it like any other poll so incoming votes are tallied by the
        // existing messages_updates webhook path.
        const poll = new Poll({
            chat_id: t.chat_id,
            question,
            options: t.payload.options || [],
            allow_multiple: !!t.payload.allow_multiple,
        });
        poll.poll_id = poll._id.toString();
        if (waMessageId) poll.wa_message_id = waMessageId;
        await poll.save();
        sentText = question;
    } else {
        // text uses its stored copy verbatim; generated kinds (news/joke) go
        // through the injected generator.
        const text = t.kind === "text"
            ? String(t.payload.text || "")
            : (deps.generate ? await deps.generate(t, group) : null);
        if (!text || !text.trim()) {
            // Nothing worth sending (e.g. no news found today). Not an error.
            return { sent: false, reason: "nothing-to-send" };
        }
        const body = u.attributeToScheduler(t.kind, text, via);
        // The "— via @George" credit, and anyone named in the text, become real
        // tags where the gateway renders them; the archived copy keeps full names.
        const tagged = deps.supportsMentions
            ? u.tagMembers(body, await getNamedMembers(t.chat_id))
            : { sent: body, mentions: [], archived: body };
        sentId = await deps.sendMessage(t.chat_id, tagged.sent, tagged.mentions);
        if (!sentId) throw new Error("send failed");
        sentText = tagged.archived;
    }

    // Context without noise: this lands in the unread backlog and gets ingested
    // the next time he actually replies. It does NOT touch lastReplyAt or
    // messagesSinceLastSend, so the reply gate and the gossip cadence are both
    // left exactly as they were.
    const forContext = describeSentForContext(t.kind, t.payload, sentText);
    await saveMessage(t.chat_id, "Gepetel", forContext);
    // He just said something in the group, so the next five minutes are a
    // follow-up window like after any other line of his: "care 3?" a minute
    // after a scheduled joke went unanswered when this was left untouched.
    // The announcement path is used on purpose — it opens the window and tells
    // the gatekeeper what he last said, without resetting the gossip counter or
    // touching the daily reply count. Reactions still go through the gatekeeper,
    // so people voting on a poll don't get him commenting on every choice.
    await recordGroupAnnouncement(t.chat_id, forContext);
    // …and into the conversation window, under the id the gateway gave it, so the
    // next time he wakes up in that group he can see he posted it (and a reply
    // quoting it resolves). Posts used to skip this and were invisible to him.
    if (typeof sentId === "string") await archiveMessage(t.chat_id, sentId, "Gepetel", forContext);

    // A one-off has now done its job — retire it so it can never fire again.
    // Deactivated rather than deleted, so it stays visible (and its votes
    // reachable) instead of vanishing the moment it runs.
    if (t.run_on_date) {
        await ScheduledTask.updateOne({ _id: t._id }, { $set: { active: false } });
    }

    await logInteraction({
        chatId: t.chat_id, groupName: group.name || "", isGroup: true, author: "(scheduled)",
        incoming: `(scheduled ${t.kind})`, action: "scheduled", reply: sentText,
    });
    return { sent: true, text: sentText };
}

// Who is in a group — but only for someone who is actually in it.
//
// The check is deliberately the same code-level gate the scheduling tools use:
// assertGroupAccess re-queries the database and throws unless the caller is a
// stored participant. It is NOT a prompt rule, so no amount of persuasion,
// injected text or invented chat id gets a non-member an answer; a group they
// aren't in simply doesn't match. A non-member gets the same wording as a group
// that doesn't exist, so the reply doesn't confirm the group is real either.
//
// Returns names only. Phone numbers are never handed back — the caller asked who
// is in the group, not for everyone's contact details.
async function listGroupMembers(chatId: string, ctx: TaskContext) {
    const group: any = await assertGroupAccess(chatId, ctx);
    const known = await getKnownMembers(chatId);
    const total = u.stripBot(group.participants || []).length;
    return {
        group_name: group.name || "",
        known_names: known,
        // Most members stay unknown until they speak, so say so rather than
        // letting the list read as the full roster.
        total_members: total,
        unknown_count: Math.max(0, total - known.length),
    };
}

// Post a poll into a group right now, with no schedule behind it at all.
// Goes through the same delivery path as a scheduled one, so it inherits the
// whole contract: votes are tracked, the sender is credited, and — importantly —
// it does NOT wake Gepetel up in that group.
async function sendPollNow(
    chatId: string,
    payload: { question: string; options: string[]; allow_multiple?: boolean },
    deps: ScheduledTaskDeps,
    ctx: TaskContext,
    createdByName = ""
) {
    await assertGroupAccess(chatId, ctx);
    return await deliverScheduledTask({
        chat_id: chatId,
        kind: "poll",
        payload: u.validateTaskPayload("poll", payload),
        created_by: ctx?.requesterChatId || "",
        created_by_name: createdByName,
        // No _id and no run_on_date: nothing is stored, nothing to retire.
    }, deps);
}

// Post a plain message into a group right now — the text twin of sendPollNow.
// Same delivery path, same contract: membership is re-checked against the
// database, the sender is credited, the line lands in Gepetel's own context for
// that group, and it does NOT wake him up there. Nothing is stored: there is no
// schedule to retire, only a message that either went out or didn't.
async function sendMessageNow(
    chatId: string,
    payload: { text: string },
    deps: ScheduledTaskDeps,
    ctx: TaskContext,
    createdByName = ""
) {
    await assertGroupAccess(chatId, ctx);
    return await deliverScheduledTask({
        chat_id: chatId,
        kind: "text",
        payload: u.validateTaskPayload("text", payload),
        created_by: ctx?.requesterChatId || "",
        created_by_name: createdByName,
        // No _id and no run_on_date: nothing is stored, nothing to retire.
    }, deps);
}

// Post a task immediately, ignoring its schedule. Used by the admin "run now"
// button to test a task without waiting for its hour. Deliberately does NOT set
// last_fired_at, so a manual test never eats the day's real slot.
async function runScheduledTaskNow(taskId: string, deps: ScheduledTaskDeps, ctx: TaskContext) {
    const task = await getScheduledTask(taskId, ctx);
    return await deliverScheduledTask(task.toObject(), deps);
}

// Fire every scheduled task that is due right now.
//
// A post opens the same 5-minute follow-up window as any other line of his (see
// deliverScheduledTask), but it is still something he was told to publish rather
// than a reply he chose to make: it never increments the daily reply counter and
// never resets the gossip cadence. Concretely, this path calls
// recordGroupAnnouncement and never markGroupReplied.
//
// I/O is injected so this stays testable and mongo.ts keeps its one-way
// dependency on util only (same shape as fireDueReminders above).
async function fireDueScheduledTasks(deps: ScheduledTaskDeps, now: Date = new Date()) {
    const candidates: any[] = await ScheduledTask.find({ active: true }).limit(500).lean();
    const due = candidates.filter(t => u.isTaskDue(t, now));
    let fired = 0, skipped = 0, failed = 0;

    for (const t of due) {
        // Claim the slot atomically: the update only applies if last_fired_at is
        // still what we read. Two overlapping cron runs can't both win, so a
        // retrying scheduler can never double-post.
        const claimed = await ScheduledTask.findOneAndUpdate(
            { _id: t._id, last_fired_at: t.last_fired_at ?? null },
            { $set: { last_fired_at: now } },
            { new: true }
        );
        if (!claimed) { skipped++; continue; }

        // Release the claim so a later run in the SAME hour can retry. We never
        // spill into the next hour: isTaskDue stops matching once the hour turns,
        // which is the right call for a 9am poll — better skipped than sent at 10.
        const releaseClaim = async () => {
            await ScheduledTask.updateOne({ _id: t._id }, { $set: { last_fired_at: t.last_fired_at ?? null } });
        };

        try {
            const outcome = await deliverScheduledTask(t, deps);
            if (outcome.sent) fired++; else skipped++;
        } catch (err: any) {
            console.error(`Scheduled task ${t.task_id} failed:`, err?.message || err);
            await releaseClaim();
            failed++;
        }
    }
    return { due: due.length, fired, skipped, failed };
}

// Send every reminder whose due_date has passed, then remove it.
// A reminder is only deleted once it has been delivered successfully, so a
// failed send is retried on the next run instead of being silently dropped.
async function fireDueReminders(sendFn: (to: string, message: string) => Promise<any>) {
    const due = await Reminder.find({ due_date: { $lte: new Date() } }).sort({ due_date: 1 }).limit(100);
    let fired = 0;
    for (const reminder of due) {
        const to = reminder.is_individual && reminder.phone_number
            ? reminder.phone_number.replace(/\D/g, "")
            : reminder.chat_id;
        if (!to) {
            // No deliverable destination — drop it to avoid an endless retry loop.
            await reminder.deleteOne();
            continue;
        }
        const ok = await sendFn(to, `⏰ Reminder: ${reminder.title}`);
        if (ok) {
            if (reminder.recurrence) {
                // Re-arm: advance to the next future occurrence instead of deleting.
                let next = u.nextOccurrence(reminder.due_date, reminder.recurrence as any);
                const now = new Date();
                while (next <= now) next = u.nextOccurrence(next, reminder.recurrence as any);
                reminder.due_date = next;
                await reminder.save();
            } else {
                await reminder.deleteOne();
            }
            fired++;
        } else {
            console.error(`Failed to deliver reminder ${reminder._id}; will retry next run.`);
        }
    }
    return { due: due.length, fired };
}

export default {
    newMessage,
    isNewGroup,
    setParticipants,
    getGroupList,
    getGroupById,
    getGroupByChatId,
    recordGroupAnnouncement,
    logInteraction,
    getInteractions,
    updatePreviousMessageId,
    getLastMessagesThenDeleteThem,
    getGroupMetadata,
    saveMessage,
    markMessageProcessed,
    toolFunctions,
    updatePeople,
    recordUserMention,
    addMemory,
    listMemories,
    deleteMemory,
    getRecentMemoriesText,
    listReminders,
    listActionItems,
    searchActionItems,
    listPolls,
    fireDueReminders,
    createScheduledTask,
    listGroupMembers,
    sendPollNow,
    sendMessageNow,
    fireDueScheduledTasks,
    runScheduledTaskNow,
    listScheduledTasks,
    getScheduledTask,
    updateScheduledTask,
    deleteScheduledTask,
    setPollWaMessageId,
    recordPollVotes,
    markGroupReplied,
    getCachedMessages,
    getKnownMembers,
    getNamedMembers,
    setBotPresent,
    setLastImage,
    getLastImage,
    recordActivity,
    getGroupActiveHoursUTC,
    inferRegion,
    inferLanguage,
    getGroupsDueForUnprompted,
    scheduleNextUnprompted,
    checkDailyLimit,
    incrementDailyReplyCount,
    claimDailyLimitWarning,
    claimCreditsNotice,
    claimInjectionAlert,
    claimDmMessage,
    archiveMessage,
    getArchivedMessage,
    getRecentMessages,
    resolveMentionNames,
    getGroupsByParticipant,
    setDailyReplyLimit,
    extendDailyLimitOnce,
    getPersonName,
 };
