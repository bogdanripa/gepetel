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

        let participantsLength = (response.data.participants || []).length;
        if (participantsLength === 0) participantsLength = 5;

        console.log(`Group ${groupId} has ${participantsLength} members.`);
        return participantsLength;
    } catch (error: any) {
        console.error("Error retrieving group metadata:", error.response?.data || error.message);
        return null;
    }
}

async function sendWhatsAppMessage(to: String, message: String) {    
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

export default { getGroupParticipants, sendWhatsAppMessage, reactToMessage };