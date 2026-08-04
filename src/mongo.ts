import mongoose from "mongoose";
import u from "./util.js";

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
    nudgeSent: { type: Boolean, default: false },  // the one-time growth DM has been sent
    nudgeSentAt: { type: Date, default: null },
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
    days_of_week: { type: [Number], default: [] },            // 0=Sun .. 6=Sat
    timezone: { type: String, default: "UTC" },               // resolved from members at creation
    active: { type: Boolean, default: true },
    last_fired_at: { type: Date, default: null },             // guards against double-firing
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
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

toolFunctions.get_poll_results = async ({chat_id, poll_id}: {chat_id: string; poll_id: string}) => {
    const poll = await Poll.findOne({ chat_id, poll_id });
    if (!poll) throw new Error(`Poll ${poll_id} not found`);
    const j: any = poll.toJSON();
    return { question: j.question, total: j.total || 0, results: j.results || [], updatedAt: j.updatedAt };
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

async function getGroupList() {
    return await Group.find();
}

// Append a review-log entry (never throws — logging must not break handling).
async function logInteraction(entry: { chatId: string; groupName?: string; isGroup?: boolean; author?: string; incoming?: string; action: string; reply?: string }) {
    try { await Interaction.create(entry); } catch (e) { console.error("logInteraction failed:", e); }
}

// Recent interactions for a group (newest first), within the ~2-week TTL window.
async function getInteractions(chatId: string, limit = 200) {
    return await Interaction.find({ chatId }).sort({ createdAt: -1 }).limit(limit).lean();
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
const GROWTH_MENTION_THRESHOLD = 5;
const GROWTH_MIN_DAYS = 7;

// Count one group mention/tag of Gepetel by a user, then atomically decide whether
// THIS mention is the one that should trigger the one-time growth DM. Returns
// { claimedNudge: true } to exactly one caller (the nudge flag is flipped in the
// same update), so concurrent webhooks can never double-send. claimedNudge is
// false on every other mention (not yet eligible, or already nudged).
async function recordUserMention(phoneNumber: string): Promise<{ claimedNudge: boolean }> {
    const digits = String(phoneNumber || "").replace(/\D/g, "");
    if (!digits) return { claimedNudge: false };
    const now = new Date();
    // Increment the counter; stamp firstMentionAt only on the very first mention.
    await UserGrowth.updateOne(
        { phoneNumber: digits },
        { $inc: { mentionCount: 1 }, $setOnInsert: { firstMentionAt: now } },
        { upsert: true }
    );
    // Claim the nudge iff: enough mentions, a week past the first, not yet sent.
    const weekAgo = new Date(now.getTime() - GROWTH_MIN_DAYS * 24 * 60 * 60 * 1000);
    const claimed = await UserGrowth.findOneAndUpdate(
        {
            phoneNumber: digits,
            nudgeSent: { $ne: true },
            mentionCount: { $gte: GROWTH_MENTION_THRESHOLD },
            firstMentionAt: { $lte: weekAgo },
        },
        { $set: { nudgeSent: true, nudgeSentAt: now } },
        { new: true }
    );
    return { claimedNudge: !!claimed };
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

    return groups.map(g => ({
        name: friendlyName(g),
        chatId: g.chatId,
        dailyReplyLimit: typeof g.dailyReplyLimit === "number" ? g.dailyReplyLimit : 20,
    }));
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

async function createScheduledTask(input: {
    chat_id: string;
    kind: string;
    payload: any;
    hour_local: number;
    days_of_week: unknown;
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
    // Both of these throw a user-readable message when the input is unusable, so
    // a bad schedule fails here rather than silently never firing.
    const days = u.normalizeDaysOfWeek(input.days_of_week);
    const payload = u.validateTaskPayload(input.kind, input.payload);

    const task = new ScheduledTask({
        chat_id,
        kind: input.kind,
        payload,
        hour_local: hour,
        days_of_week: days,
        timezone: input.timezone || await groupTimezone(chat_id),
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
    const tasks = await ScheduledTask.find(query).sort({ createdAt: -1 }).limit(200).lean();
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
    if (patch.days_of_week !== undefined) task.set("days_of_week", u.normalizeDaysOfWeek(patch.days_of_week));
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
    sendMessage: (to: string, message: string) => Promise<any>;
    sendPoll: (to: string, question: string, options: string[], allowMultiple: boolean) => Promise<any>;
    generate?: (task: any, group: any) => Promise<string | null>;
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
    if (t.kind === "poll") {
        const question = u.attributeToScheduler("poll", t.payload.question, via);
        const waMessageId = await deps.sendPoll(
            t.chat_id, question, t.payload.options || [], !!t.payload.allow_multiple
        );
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
        const ok = await deps.sendMessage(t.chat_id, body);
        if (!ok) throw new Error("send failed");
        sentText = body;
    }

    // Context without noise: this lands in the unread backlog and gets ingested
    // the next time he actually replies. It does NOT touch lastReplyAt or
    // messagesSinceLastSend, so the reply gate and the gossip cadence are both
    // left exactly as they were.
    await saveMessage(t.chat_id, "Gepetel", describeSentForContext(t.kind, t.payload, sentText));

    await logInteraction({
        chatId: t.chat_id, groupName: group.name || "", isGroup: true, author: "(scheduled)",
        incoming: `(scheduled ${t.kind})`, action: "scheduled", reply: sentText,
    });
    return { sent: true, text: sentText };
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
// Sending here must NOT wake Gepetel up. A scheduled post is something he was
// told to publish, not something he chose to say, so the group should be able to
// react to it without him butting in. That is achieved by NOT touching
// `lastReplyAt`: the reply gate keeps measuring silence from his last real reply,
// so an unmentioned follow-up still resolves to "out-of-window" -> silent.
// Concretely, this function must never call markGroupReplied /
// recordGroupAnnouncement (both set lastReplyAt) and must never increment the
// daily reply counter. An explicit "@gepetel" still wakes him, because a mention
// short-circuits the gate before any timing is considered.
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
    getGroupsByParticipant,
    setDailyReplyLimit,
    extendDailyLimitOnce,
    getPersonName,
 };
