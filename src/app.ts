import express from "express";
import wa from "./whapi.js";
import oai from "./oai.js";
import m from "./mongo.js";

// app
const app = express();
app.use(express.json());

async function processIncomingMessage(chatId: string, text: string, author: string, groupName: string | undefined, messageId: string) {
    text = text.replace(/@?\+?\s*4\s*0\s*7\s*5\s*0\s*2\s*7\s*1\s*0\s*9\s*9/g, "Gepetel");
    console.log(`Message from ${author}: ${text}`);
    let reply;

    const {np, previousMessageId} = await m.newMessage(chatId, wa.getGroupParticipants);
    if (chatId.match(/^[\d-]{10,31}@g\.us$/)) {
        reply = await oai.generateGroupReply(chatId, groupName || '', np, previousMessageId, `${author}: ${text}`);
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
                res.status(200).json({ status: 'success' });
                return;
            }
        }
    }

    const messages = req.body.messages;
    if (messages && messages.length) {
        for (const message of messages) {
            if (!message.from_me) {
                const chatId = message.chat_id;//.split('@')[0];  // Extracting phone number from chat_id
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
                
                await processIncomingMessage(chatId, text, author, groupName, message.id);
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
            <p><strong>Messages:</strong> ${group.numMessages}</p>
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
    const reply = await processIncomingMessage(g?.chatId || '', text, from, 'groupName', '1234567890');
    res.send(reply);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
