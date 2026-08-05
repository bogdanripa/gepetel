// The WhatsApp-provider-neutral shapes.
//
// Gepetel can talk to WhatsApp through more than one gateway (whapi.cloud and
// wa-gateway today), and their webhooks look nothing alike: whapi posts flat
// `{ messages, groups, contacts, messages_updates }`, wa-gateway posts Meta's
// `{ entry: [ { changes: [ { field, value } ] } ] }`. Rather than teach app.ts
// both dialects, each provider parses its own payload into the types below and
// the rest of the code only ever sees these.

export type WaGroupEvent = {
    id: string;                                   // the group jid (…@g.us)
    name: string;                                 // subject, "" when unknown
    participants: { id: string; name: string }[];
};

export type WaContactEvent = { id: string; name: string };

// One poll's current tally. `id` is the WhatsApp message id of the poll itself,
// which is what we stored when sending it.
export type WaPollEvent = {
    id: string;
    poll: { total?: number; results: { name: string; count: number; voters?: string[] }[] };
};

export type WaIncomingMessage = {
    id: string;
    chatId: string;          // group jid, or "<digits>@s.whatsapp.net" for a 1:1
    from: string;            // the sender's number (any format; callers normalize)
    fromName: string;
    chatName: string;        // group subject when the provider tells us, else ""
    text: string;            // plain body; "" when the message is media
    image?: { link: string; caption?: string };
    gif?: { link: string; caption?: string };     // also covers inbound video
    voice?: { link: string };                     // voice note or audio file
    linkPreview?: { title: string; description?: string; preview?: string };
    raw?: any;               // original payload, for logging an unsupported type
};

export type WaEvents = {
    groups: WaGroupEvent[];
    contacts: WaContactEvent[];
    polls: WaPollEvent[];
    messages: WaIncomingMessage[];
};

// What every provider module must implement.
export type WaProvider = {
    name: string;
    getGroupInfo(groupId: string): Promise<{ participants: string[]; name: string } | null>;
    sendWhatsAppMessage(to: String, message: String): Promise<boolean>;
    reactToMessage(messageId: string, emoji: string, to?: string): Promise<boolean>;
    sendWhatsAppPoll(to: string, question: string, options: string[], allowMultiple?: boolean): Promise<string | null>;
    sendTypingIndicator(to: String, messageId?: string): Promise<boolean | void>;
    sendWhatsAppImage(to: String, image: string, caption?: string): Promise<boolean>;
    markAsRead(messageId: string): Promise<boolean>;
    parseWebhook(body: any): WaEvents;
};

export const EMPTY_EVENTS: WaEvents = { groups: [], contacts: [], polls: [], messages: [] };
