import mongoose from "mongoose";

mongoose.connect(process.env["GEPETEL_DATABASE_URL"] || process.env["GEPETEL_DATABASE_URL1"] || '');

const GroupsSchema = new mongoose.Schema({
    chatId: { type: String, required: true },
    numParticipants: { type: Number, default: 2 },
    numMessages: {type: Number, default: 0},
    lastChecked: { type: Date, default: Date.now },
    previousMessageId: {type: String, default: ""},
});

const RemindersSchema = new mongoose.Schema({
    chat_id: { type: String, required: true },
    reminder_id: { type: String, required: false },
    title: { type: String, required: true },
    due_date: { type: Date, required: true },
    is_individual: { type: Boolean, default: false },
});

const Group = mongoose.model("Group", GroupsSchema);
const Reminder = mongoose.model("Reminder", RemindersSchema);

const toolFunctions:any = {};

toolFunctions.create_reminder = async ({chat_id, title, due_date, is_individual}: {chat_id: string, title: string, due_date: Date, is_individual: boolean}) => {
    const reminder = new Reminder({chat_id, title, due_date, is_individual});
    reminder.reminder_id = reminder._id.toString();
    await reminder.save();
    return reminder.toJSON();
}

toolFunctions.get_group_future_reminders = async ({chat_id}: {chat_id: string}) => {
    const reminders = await Reminder.find({chat_id, due_date: {$gt: new Date()}});
    return reminders.map(reminder => reminder.toJSON());
}

toolFunctions.update_reminder = async ({chat_id, reminder_id, title, due_date, is_individual}: {chat_id: string, reminder_id: string, title: string, due_date: Date, is_individual: boolean}) => {
    const reminder = await Reminder.findOne({chat_id, reminder_id});
    if (!reminder) throw new Error(`Reminder id ${reminder_id} not found`);
    if (title) reminder.title = title;
    if (due_date) reminder.due_date = due_date;
    if (is_individual) reminder.is_individual = is_individual;
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

async function newMessage(chatId: string, cb: Function) {
    let group = await Group.findOne({ chatId });
    if (!group) group = new Group({chatId, lastChecked: new Date(Date.now() - 2000 * 60 * 60 * 24)});

    if (group.lastChecked < new Date(Date.now() - 1000 * 60 * 60 * 24)) {
        const numParticipants = await cb(chatId);
        if (numParticipants > 0) {
            group.numParticipants = numParticipants;
            group.lastChecked = new Date();
        }
    }
    group.numMessages++;
    await group.save();

    return {
        np: group.numMessages, 
        previousMessageId: group.previousMessageId
    };
}

async function updatePreviousMessageId(chatId: string, previousMessageId: string) {
    let group = await Group.findOne({ chatId });
    if (!group) return;
    group.previousMessageId = previousMessageId;
    await group.save();
}

async function hasMessages(chatId: string) {
    const group = await Group.findOne({ chatId });
    if (!group) return false;
    return group.numMessages > 0;
}

async function getGroupById(_id: string) {
    return await Group.findOne({ _id });
}

export default {
    newMessage,
    hasMessages,
    setNumParticipants,
    getGroupList,
    getGroupById,
    updatePreviousMessageId,
    toolFunctions
 };