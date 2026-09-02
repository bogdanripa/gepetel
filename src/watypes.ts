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
    // A file someone dropped in the chat. No link, by design: wa-gateway follows
    // Meta's two-step media flow and never downloads a document on receipt, so all
    // that arrives is a description of it. `mediaId` is the opaque handle to
    // exchange for a URL if we ever do read them — it expires after about a week.
    document?: { mediaId: string; filename: string; mimeType?: string; size?: number; caption?: string };
    linkPreview?: { title: string; description?: string; preview?: string };
    // Set when this message is a REPLY to another. Providers give us the quoted
    // message's id (and sometimes its sender) but not its content — resolving the
    // id to text is Gepetel's job, via the message archive.
    quoted?: { id: string; from?: string };
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
    // Does this gateway report poll votes back to us? whapi does (as message
    // updates); wa-gateway does not, so Gepetel must not pretend to see a tally.
    observesPollVotes: boolean;
    // Can an outbound text carry real @-mentions? When it can, `mentions` on
    // sendWhatsAppMessage lists the numbers whose `@<digits>` in the body should
    // render as tags. When it can't, callers keep names as names — a body full of
    // `@40712345678` that never turns into a tag is worse than "George".
    supportsMentions(): boolean;
    getGroupInfo(groupId: string): Promise<{ participants: string[]; name: string } | null>;
    // Resolves to the sent message's id when the provider reports one, else true;
    // false on failure. Both success shapes are truthy, so callers that only check
    // for success are unaffected — the id lets a reply quoting Gepetel be resolved.
    sendWhatsAppMessage(to: String, message: String, mentions?: string[]): Promise<string | boolean>;
    reactToMessage(messageId: string, emoji: string, to?: string): Promise<boolean>;
    sendWhatsAppPoll(to: string, question: string, options: string[], allowMultiple?: boolean): Promise<string | null>;
    sendTypingIndicator(to: String, messageId?: string): Promise<boolean | void>;
    sendWhatsAppImage(to: String, image: string, caption?: string): Promise<boolean>;
    markAsRead(messageId: string): Promise<boolean>;
    parseWebhook(body: any): WaEvents;
};

export const EMPTY_EVENTS: WaEvents = { groups: [], contacts: [], polls: [], messages: [] };
