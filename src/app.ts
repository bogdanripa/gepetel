import express from "express";
import wa from "./whapi.js";
import oai from "./oai.js";
import m from "./mongo.js";
import e from "express";
import { modelNames } from "mongoose";

// app
const app = express();
app.use(express.json());

async function processIncomingMessage(chatId: string, text: string, author: string, groupName: string | undefined, messageId: string, debug = false, timestamp: Date) {
    text = text.replace(/@?\+?\s*4\s*0\s*7\s*5\s*0\s*2\s*7\s*1\s*0\s*9\s*9/g, "Gepetel");
    console.log(`Message from ${author}: ${text}`);
    const {np, previousMessageId} = await m.newMessage(chatId, wa.getGroupParticipants);

    // let state = await m.getAssistantState(chatId);
    // if (state == 'pause' && numAssistantAnswers == 0) {
    //     if (!debug) await m.setAssistantState(chatId, 'normal');
    //     state = 'normal';
    // }

    const reply = await oai.generateGroupReply('normal', groupName || '', np, previousMessageId, `${author}: ${text}`);
    if (reply.answer.toLowerCase().replace('ă', '').includes("nu raspund")) {
        console.log("No reply generated.");
    } else if(reply.answer.toLocaleLowerCase().replace('ă', '').includes("iau pauza")) {
        console.log("Assistant was asked to pause.");
        if (!debug) await m.setAssistantState(chatId, 'pause');
        if (!debug) await wa.reactToMessage(messageId, "👍");
    } else {
        console.log(`Reply: ${reply.answer}`);
        if (!debug) {
            if (false) { //} state == 'pause') {
                await m.setAssistantState(chatId, 'normal');
            }
            await wa.sendWhatsAppMessage(chatId, reply.answer);
        }
    }
    m.updatePreviousMessageId(chatId, reply.responseId);
    return reply.answer;
}

app.post('/whapi', async (req, res) => {
    const groups = req.body.groups;
    if (groups && groups.length) {
        for (const group of groups) {
            const chatId = group.id;
            const existingMessages = await m.hasMessages(chatId);
            if (!existingMessages) {
                console.log(`Gepetel was added to a new group: ${group.name}`);
                await m.setNumParticipants(chatId, group.participants.length);
                const reply = await oai.generateGroupGreeting(group.name, group.participants.length);
                await wa.sendWhatsAppMessage(chatId, reply.answer);
                await m.updatePreviousMessageId(chatId, reply.responseId);
            }
        }
    }

    const messages = req.body.messages;
    if (messages && messages.length) {
        for (const message of messages) {
            if (!message.from_me) {
                const from = message.chat_id;//.split('@')[0];  // Extracting phone number from chat_id
                let text = '';
                if (message.text && message.text.body) {
                    text = message.text.body;
                } else if (message.gif && message.gif.preview) {
                    text = await oai.getImageDescription(message.gif.preview);
                    if (message.gif.caption) text += ` (${message.gif.caption})`;
                } else if (message.image && message.image.preview) {
                    text = await oai.getImageDescription(message.image.preview);
                    if (message.image.caption) text += ". " + message.image.caption;
                } else if (message.link_preview) {
                    text = message.link_preview.title;
                    if (message.link_preview.description) {
                        text += ". " + message.link_preview.description;
                    } else if (message.link_preview.preview) {
                        text += ". " + await oai.getImageDescription(message.link_preview.preview);
                    }
                } else {
                    console.error(message);
                    // ignore
                    continue;
                }

                const groupName = message.chat_name;
                const author = message.from_name;
                
                await processIncomingMessage(from, text, author, groupName, message.id, false, addYears(new Date(), 1));
            }
        }
    }

    res.status(200).json({ status: 'success' });
});

app.get('/groups/', async (req, res) => {
    const gl = await m.getGroupList();

    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Groups</title>
        </head>
        <body>
            <ul>
                ${gl.map(g => `
                    <li>
                        <a href="/groups/${g._id}">
                            ${g.chatId} - ${g.numParticipants}
                        </a>
                    </li>
                `).join('')}
            </ul>
        </body>
        </html>
    `);
});

app.get('/groups/:id', async (req, res) => {
    const groupId = req.params.id;

    // Fetch group details and messages
    const group = await m.getGroupById(groupId);

    if (!group) {
        res.status(404).send('Group not found');
        return;
    }

    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Group Details - ${group.chatId}</title>
        </head>
        <body>
            <h1>Group: ${group.chatId}</h1>
            <p><strong>ID:</strong> ${group._id}</p>
            <p><strong>Participants:</strong> ${group.numParticipants}</p>

            <script>
                async function sendTimestamp(timestamp) {
                    const response = await fetch(window.location.pathname, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ timestamp })
                    });

                    const text = await response.text();
                    alert(text);
                }
            </script>

            <a href="/groups/">← Back to groups list</a>
        </body>
        </html>
    `);
});

app.post('/groups/:id', async (req, res) => {
    const groupId = req.params.id;
    const g = await m.getGroupById(groupId);
    const timestamp = req.body.timestamp;
    const reply = "TBD";//await processIncomingMessage(g?.chatId || '', text, from, 'groupName', '1234567890', true, new Date(timestamp));
    res.send(reply);
});

function addYears(date: Date, years: number): Date {
    date.setFullYear(date.getFullYear() + years);
    return date;
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
