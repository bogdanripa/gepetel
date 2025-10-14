import express from "express";
import wa from "./whapi.js";
import oai from "./oai.js";
import m from "./mongo.js";

// app
const app = express();
app.use(express.json());

async function processIncomingMessage(chatId: string, text: string, author: string, groupName: string | undefined, messageId: string) {
    text = text.replace('@279697464266959', "@gepetel");
    text = text.replace('@+40750271099', "@gepetel");
    console.log(`Message from ${author}: ${text}`);
    let isGroupMessage = chatId.match(/^[\d-]{10,31}@g\.us$/) ? true : false;
    const mentioned = !isGroupMessage || text.includes("@gepetel");
    let shouldReply, numUnsentMessages=0;

    if (mentioned) {
        await wa.sendTypingIndicator(chatId);
    }

    if (isGroupMessage) {
        const groupMetaData = await m.getGroupMetadata(chatId);
        const lastMessageTimestamp = groupMetaData.lastMessageTimestamp;
        numUnsentMessages = groupMetaData.numUnsentMessages;
        shouldReply = isGroupMessage && (mentioned || lastMessageTimestamp > new Date(Date.now() - 1000 * 60 * 5));
    } else {
        shouldReply = true;
    }

    if (!shouldReply) {
        console.log("No mention, caching message and staying quiet.");
        // save the message and stay quitet
        await m.saveMessage(chatId, author, text);

        if (numUnsentMessages > 20) {
            const {previousMessageId} = await m.newMessage(chatId, author, text, wa.getGroupParticipants);
            const reply = await oai.updateMessages(chatId, previousMessageId);
            await m.updatePreviousMessageId(chatId, reply.responseId);
        }
        return;
    }

    let reply;
    const {numberOfParticipants, previousMessageId} = await m.newMessage(chatId, author, text, wa.getGroupParticipants);
    if (isGroupMessage) {
        reply = await oai.generateGroupReply(chatId, groupName || '', numberOfParticipants, previousMessageId, `${author}: ${text}`, numUnsentMessages, mentioned);
    } else {
        reply = await oai.generateReply(author, text, previousMessageId);
    }
    if (reply.answer.toLowerCase().includes("no answer")) {
        console.log("No reply generated.");
    } else {
        console.log(`Reply: ${reply.answer}`);
        await wa.sendWhatsAppMessage(chatId, reply.answer);
    }
    await m.updatePreviousMessageId(chatId, reply.responseId);
}

app.post('/whapi', async (req, res) => {
    const groups = req.body.groups;
    if (groups && groups.length) {
        for (const group of groups) {
            const chatId = group.id;
            const isNewGroup = await m.isNewGroup(chatId);
            if (isNewGroup) {
                console.log(`Gepetel was added to a new group: ${group.name}`);
                await m.setNumParticipants(chatId, group.participants.length);
                const reply = await oai.generateGroupGreeting(group.name, group.participants.length);
                await wa.sendWhatsAppMessage(chatId, reply.answer);
                await m.updatePreviousMessageId(chatId, reply.responseId);
                res.status(200).json({ status: 'success' });
                return;
            }
        }
    }
    //console.log(JSON.stringify(req.body, null, 2));

    const messages = req.body.messages;
    if (messages && messages.length) {
        for (const message of messages) {
            if (!message.from_me) {
                const chatId = message.chat_id;
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

                try {
                    await processIncomingMessage(chatId, text, author, groupName, message.id);
                } catch (error) {
                    console.error(`Error processing message from ${author} in chat ${chatId}:`, error);
                }
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
            <p><strong>Last Checked:</strong> ${group.lastChecked}</p>
            <label for="message">Message:</label>
            <input type="text" id="message" name="message" />
            <button onclick="sendMessage()">Send</button>

            <script>
                async function sendMessage() {
                    const message = document.getElementById('message').value;
                    const timestamp = new Date().toISOString();
                    const response = await fetch(window.location.pathname, {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ timestamp, message })
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
    const text = req.body.message;
    const from = "me";
    try {
        const reply = await processIncomingMessage(g?.chatId || '', text, from, 'groupName', '1234567890');
        res.send(reply);
    } catch (error) {
        console.error(`Error processing test message in group ${groupId}:`, error);
        res.status(500).json({ error: 'Failed to process message' });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
