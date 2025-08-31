import mongoose from "mongoose";

mongoose.connect(process.env["GEPETEL_DATABASE_URL"] || '');

const GroupsSchema = new mongoose.Schema({
    chatId: { type: String, required: true },
    numParticipants: { type: Number, required: true },
    numMessages: {type: Number, default: 0},
    state: {type: String, default: 'normal'},
    lastChecked: { type: Date, default: Date.now },
    previousMessageId: {type: String, default: ""},
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

    return {np: group.numMessages, previousMessageId: group.previousMessageId}
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
    setAssistantState,
    getAssistantState,
    getGroupList,
    getGroupById,
    updatePreviousMessageId,
 };