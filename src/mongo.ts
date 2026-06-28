import mongoose from "mongoose";

mongoose.connect(process.env["GEPETEL_DATABASE_URL"] || process.env["GEPETEL_DATABASE_URL1"] || '')
    .catch((err) => console.error("MongoDB connection error:", err.message));

const GroupsSchema = new mongoose.Schema({
    chatId: { type: String, required: true },
    numParticipants: { type: Number, default: 2 },
    lastChecked: { type: Date, default: Date.now },
    lastMessageTimestamp: { type: Date, default: Date.now },
    previousMessageId: {type: String, default: ""},
    participants: {type: Array, default: []},
});

const messagesSchema = new mongoose.Schema({
    chatId: { type: String, required: true },
    from: { type: String, required: true },
    text: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
});

const peopleSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true },
    name: { type: String, required: true },
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

const Group = mongoose.model("Group", GroupsSchema);
const Reminder = mongoose.model("Reminder", RemindersSchema);
const Message = mongoose.model("Message", messagesSchema);
const Person = mongoose.model("Person", peopleSchema);
const ActionItem = mongoose.model("ActionItem", ActionItemSchema);
const Memory = mongoose.model("Memory", memorySchema);
const Poll = mongoose.model("Poll", PollSchema);

const toolFunctions:any = {};

toolFunctions.create_reminder = async ({chat_id, title, due_date, is_individual, phone_number}: {chat_id: string, title: string, due_date: Date, is_individual: boolean, phone_number: string | null}) => {
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
    if (is_individual) reminder.is_individual = is_individual;
    if (is_individual) {
        if (phone_number) reminder.phone_number = phone_number;
    } else {
        reminder.phone_number = null;
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

async function setParticipants(chatId: string, participants: string[]) {
    await Group.updateOne({chatId}, {participants, numParticipants: participants.length}, {upsert: true});
}

async function newMessage(chatId: string, from: string, text: string, cb: Function) {
    let group = await Group.findOne({ chatId });
    if (!group) group = new Group({chatId, lastChecked: new Date(Date.now() - 2000 * 60 * 60 * 24)});

    if (group.lastChecked < new Date(Date.now() - 1000 * 60 * 60 * 24)) {
        const participants = await cb(chatId);
        if (participants.length > 0) {
            group.lastChecked = new Date();
            group.numParticipants = participants.length;
            group.participants = participants;
        }
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

async function getGroupMetadata(chatId: string) {
    const group = await Group.findOne({chatId});
    if (!group) throw new Error(`Group ${chatId} not found`);
    return {
        numUnsentMessages: await Message.countDocuments({chatId}),
        numberOfParticipants: group.numParticipants,
        lastMessageTimestamp: group.lastMessageTimestamp,
        previousMessageId: group.previousMessageId,
    }
}

async function getLastMessagesThenDeleteThem(chatId: string) {
    const messages = await Message.find({chatId}).sort({timestamp: -1}).lean();
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

async function updatePeople({phoneNumber, name}: {phoneNumber: string, name: string}) {
    await Person.updateOne({ phoneNumber }, { name }, { upsert: true });
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

async function listPolls(chatId: string) {
    const polls = await Poll.find({ chat_id: chatId }).sort({ createdAt: -1 }).limit(50);
    return polls.map(p => p.toJSON());
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
            await reminder.deleteOne();
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
    updatePreviousMessageId,
    getLastMessagesThenDeleteThem,
    getGroupMetadata,
    saveMessage,
    toolFunctions,
    updatePeople,
    addMemory,
    listMemories,
    deleteMemory,
    getRecentMemoriesText,
    listReminders,
    listActionItems,
    searchActionItems,
    listPolls,
    fireDueReminders,
    setPollWaMessageId,
    recordPollVotes
 };
