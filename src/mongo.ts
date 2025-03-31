import mongoose from "mongoose";

mongoose.connect(process.env["GEPETEL_DATABASE_URL"] || '');

const MessageSchema = new mongoose.Schema({
    chatId: { type: String, required: true }, // Either user phone number or group ID
    role: { type: String, enum: ["system", "user", "assistant"], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    name: { type: String, required: false }, // Used for group messages
});

// Create a MongoDB model
const Message = mongoose.model("Message", MessageSchema);

const GroupsSchema = new mongoose.Schema({
    chatId: { type: String, required: true },
    numParticipants: { type: Number, required: true },
    state: {type: String, default: 'normal'},
    lastChecked: { type: Date, default: Date.now }
});

const Group = mongoose.model("Group", GroupsSchema);

async function setAssistantState(chatId: string, state: string) {
    await Group.updateOne({ chatId }, { state }, {upsert: true});
}

async function getAssistantState(chatId: string) {
    const group = await Group.findOne({ chatId });
    return group?.state || 'normal';
}

async function getGroupList() {
    return await Group.find();
}

async function getGroupParticipants(chatId: string, cb: Function) {
    const group = await Group
        .findOne({ chatId });
    if (!group || group.lastChecked < new Date(Date.now() - 1000 * 60 * 60 * 24)) {
        const numParticipants = await cb(chatId);
        if (numParticipants > 0) {
            await Group.updateOne({ chatId }, { numParticipants, lastChecked: Date.now() }, { upsert: true });
            return numParticipants;
        } else {
            if (group) {
                return group.numParticipants;
            } else {
                return 10;
            }
        }
    } else {
        return group.numParticipants;
    }
}

async function setNumParticipants(chatId: string, numParticipants: number) {
    await Group.updateOne({chatId}, {numParticipants}, {upsert: true});
}

async function saveMessage(m: { chatId: string, role: string, content: string }) {
    await Message.create(m);
}

async function hasMessages(chatId: string) {
    return await Message.exists({ chatId });
}

async function getLastMessages(chatId: string, count: number, timestamp: Date) {
    const filter = { chatId, timestamp: { $lt: timestamp } };
    const history = await Message.find(filter)
        .sort({ timestamp: -1 })
        .limit(count)
        .lean();
    history.reverse();
    return history.map(msg => ({
        role: msg.role,
        content: msg.content
    }));
}

async function getGroupById(_id: string) {
    return await Group.findOne({ _id });
}

async function getMessagesByGroupId(chatId: string) {
    const g = await getGroupById(chatId);
    return await
        Message
            .find({ chatId: g?.chatId })
            .sort({ timestamp: 1 })
            .lean();
}

async function getMessageByTimestamp(chatId: string, timestamp: Date) {
    const g = await getGroupById(chatId);
    return (await Message.findOne({ chatId: g?.chatId, timestamp }))?.content;
}

export default {
    saveMessage,
    hasMessages,
    getLastMessages,
    getGroupParticipants,
    setNumParticipants,
    setAssistantState,
    getAssistantState,
    getGroupList,
    getGroupById, 
    getMessagesByGroupId,
    getMessageByTimestamp
 };