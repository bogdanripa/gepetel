import mongoose from "mongoose";

mongoose.connect(process.env["GEPETEL_DATABASE_URL"] || process.env["GEPETEL_DATABASE_URL1"] || '');

const GroupsSchema = new mongoose.Schema({
    chatId: { type: String, required: true },
    numParticipants: { type: Number, default: 2 },
    lastChecked: { type: Date, default: Date.now },
    lastMessageTimestamp: { type: Date, default: Date.now },
    previousMessageId: {type: String, default: ""},
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

const RemindersSchema = new mongoose.Schema({
    chat_id: { type: String, required: true },
    reminder_id: { type: String, required: false },
    title: { type: String, required: true },
    due_date: { type: Date, required: true },
    is_individual: { type: Boolean, default: false },
    phone_number: { type: String, required: false },
});

const Group = mongoose.model("Group", GroupsSchema);
const Reminder = mongoose.model("Reminder", RemindersSchema);
const Message = mongoose.model("Message", messagesSchema);
const Person = mongoose.model("Person", peopleSchema);

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

async function getGroupList() {
    return await Group.find();
}

async function setNumParticipants(chatId: string, numParticipants: number) {
    await Group.updateOne({chatId}, {numParticipants}, {upsert: true});
}

async function newMessage(chatId: string, from: string, text: string, cb: Function) {
    let group = await Group.findOne({ chatId });
    if (!group) group = new Group({chatId, lastChecked: new Date(Date.now() - 2000 * 60 * 60 * 24)});

    if (group.lastChecked < new Date(Date.now() - 1000 * 60 * 60 * 24)) {
        const numParticipants = await cb(chatId);
        if (numParticipants > 0) {
            group.numParticipants = numParticipants;
            group.lastChecked = new Date();
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

export default {
    newMessage,
    isNewGroup,
    setNumParticipants,
    getGroupList,
    getGroupById,
    updatePreviousMessageId,
    getLastMessagesThenDeleteThem,
    getGroupMetadata,
    saveMessage,
    toolFunctions
 };