import axios from "axios";

async function getGroupParticipants(groupId: string) {    
    if (!groupId.match(/^[\d-]{10,31}@g\.us$/)) return 2;
    const url = `https://gate.whapi.cloud/groups/${groupId}`;
    
    try {
        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${process.env.WHAPI_TOKEN}`,
                "content-type": "application/json",
                accept: "application/json"
            }
        });

        console.log(`Group ${groupId} has ${response.data.participants_count} members.`);
        return response.data.participants.map((participant: any) => participant.id);
    } catch (error: any) {
        console.error("Error retrieving group metadata for group " + groupId + ":", error.response?.data || error.message);
        return null;
    }
}

async function sendWhatsAppMessage(to: String, message: String) {
    message = message
        .replace(/\[[^\]]+\]\((http[^\)]+)\)/g, '$1')
        .replace(/^\s*#{1,6}\s*(.+)$/gm, '*$1*')
        .replace(/(\*\*)(.*?)\1/g, '*$2*')
        .replace(/\?utm_source=openai&/g, '?')
        .replace(/\?utm_source=openai/g, '')

    const url = `https://gate.whapi.cloud/messages/text`;

    try {
        await axios.post(
            url,
            {
                to,
                body: message
            },
            { 
                headers: { 
                    Authorization: `Bearer ${process.env.WHAPI_TOKEN}`,
                    "content-type": "application/json",
                    accept: "application/json"
                }
             }
        );
        console.log("Message sent!");
        return true;
    } catch (error:any) {
        console.error("Error sending message:", error.response?.data || error.message || error);
        return false;
    }
}

async function reactToMessage(messageId: string, emoji: string) {
    const url = `https://gate.whapi.cloud/messages/${messageId}/reaction`;

    try {
        await axios.put(
            url,
            {
                emoji
            },
            { 
                headers: { 
                    Authorization: `Bearer ${process.env.WHAPI_TOKEN}`,
                    "content-type": "application/json",
                    accept: "application/json"
                }
             }
        );
        console.log("Reacted to message");
        return true;
    } catch (error:any) {
        console.error("Error emoji'ing message");
        return false;
    }    
}

async function sendWhatsAppPoll(to: string, question: string, options: string[], allowMultiple: boolean = false) {
    const cleanedOptions = (options || []).map(o => String(o || "").trim()).filter(Boolean);
    if (cleanedOptions.length < 2) {
        throw new Error("Need at least two options for a poll");
    }

    const url = `https://gate.whapi.cloud/messages/poll`;
    const payload = {
        to,
        poll: {
            name: question,
            allow_multiple_answers: allowMultiple,
            options: cleanedOptions
        }
    };

    try {
        const res = await axios.post(url, payload, {
            headers: {
                Authorization: `Bearer ${process.env.WHAPI_TOKEN}`,
                "content-type": "application/json",
                accept: "application/json"
            }
        });
        console.log("Poll sent!", res.data);
        return true;
    } catch (error:any) {
        console.error("Error sending poll, falling back to text:", error.response?.data || error.message || error);
        // fallback to text poll if native fails
        const body = `Poll: ${question}\n${cleanedOptions.map((o, i) => `${i+1}. ${o}`).join("\n")}`;
        await sendWhatsAppMessage(to, body);
        return false;
    }
}

async function sendTypingIndicator(to: String) {
    const url = `https://gate.whapi.cloud/presences/${to}`;
    try {
        await axios.put(url, {
            presence: "typing",
            delay: 0
        }, {
            headers: { Authorization: `Bearer ${process.env.WHAPI_TOKEN}` }
        });
    } catch (error:any) {
        console.error("Error sending typing indicator");
        return false;
    }
}

export default { getGroupParticipants, sendWhatsAppMessage, reactToMessage, sendTypingIndicator, sendWhatsAppPoll };
