// The tools Gepetel offers over MCP, and the one rule they all obey:
//
//   a token is a person, and a person gets exactly what they already have in
//   their chat with him — no more.
//
// None of these functions decides anything. assertGroupAccess, which has always
// guarded scheduled tasks and group posts, is what decides, and it is reached
// by handing it the same TaskContext a 1:1 would build: { requesterChatId }.
// A group chat id invented by a model, or passed by a client that guessed it,
// stops there exactly as it does today. That is the whole security design, and
// it is why these wrappers are thin: a new door into the same house, not a new
// house with its own locks.
import m from "../mongo.js";
import u from "../util.js";
import say from "../say.js";
import cron from "../cron.js";

export type Caller = { chatId: string };

export type ToolDef = { name: string; description: string; inputSchema: any };

const str = (x: unknown, max = 4000) => String(x ?? "").trim().slice(0, max);

/** The context every guarded call gets. Never `admin`: a person reaching in
 *  over MCP is themselves, with their own reach, and nothing here should be
 *  able to hand out more than the chat does. */
const ctxOf = (caller: Caller) => ({ requesterChatId: caller.chatId });

/** How a post is credited in the group — "with my signature", the same way a
 *  message asked for in the 1:1 is. Falls back to nothing rather than to a
 *  wrong name, which the group would read as someone else posting. */
async function signatureOf(caller: Caller): Promise<string> {
    const digits = u.phoneDigits(caller.chatId);
    try { return (await m.getPersonName(digits)) || ""; } catch { return ""; }
}

/** Shared by the schedule tools. A one-off date, or weekdays, plus the hour in
 *  the group's own clock — the same shape the chat accepts, described here in
 *  the words a model will have to fill in. */
const SCHEDULE_PROPS = {
    hour_local: { type: "number", description: "Hour of day, 0-23, in the GROUP's local time." },
    run_on_date: { type: "string", description: "For a one-off: the date, YYYY-MM-DD, in the group's local time. Use this OR days_of_week, never both." },
    days_of_week: { type: "array", items: { type: "number" }, description: "For something repeating: 0=Sunday .. 6=Saturday. Every workday is [1,2,3,4,5]." },
    timezone: { type: "string", description: "IANA timezone the hour is in, e.g. Europe/Bucharest. Defaults to the group's own." },
};

export const TOOLS: ToolDef[] = [
    {
        name: "send_me_a_message",
        description: "Send a WhatsApp message to yourself — the person this connection belongs to. Use it to deliver a result, a reminder of what you just did, or anything you want on your phone.",
        inputSchema: {
            type: "object",
            properties: { message: { type: "string", description: "The text, as it should appear in WhatsApp." } },
            required: ["message"], additionalProperties: false,
        },
    },
    {
        name: "list_my_groups",
        description: "The WhatsApp groups you and Gepetel are both in, with the id each of the group tools needs.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "send_group_message",
        description: "Post a message to one of your groups now, signed with your name so the group knows it is from you.",
        inputSchema: {
            type: "object",
            properties: {
                group_chat_id: { type: "string", description: "From list_my_groups." },
                message: { type: "string" },
            },
            required: ["group_chat_id", "message"], additionalProperties: false,
        },
    },
    {
        name: "schedule_group_message",
        description: "Post a message to one of your groups later — once on a date, or repeating on given weekdays. Signed with your name.",
        inputSchema: {
            type: "object",
            properties: {
                group_chat_id: { type: "string", description: "From list_my_groups." },
                message: { type: "string" },
                ...SCHEDULE_PROPS,
            },
            required: ["group_chat_id", "message", "hour_local"], additionalProperties: false,
        },
    },
    {
        name: "send_group_poll",
        description: "Put a poll in one of your groups now, signed with your name.",
        inputSchema: {
            type: "object",
            properties: {
                group_chat_id: { type: "string", description: "From list_my_groups." },
                question: { type: "string" },
                options: { type: "array", items: { type: "string" }, description: "2-12 distinct answers." },
                allow_multiple: { type: "boolean", description: "Whether people may pick more than one." },
            },
            required: ["group_chat_id", "question", "options"], additionalProperties: false,
        },
    },
    {
        name: "schedule_group_poll",
        description: "Put a poll in one of your groups later — once on a date, or repeating on given weekdays.",
        inputSchema: {
            type: "object",
            properties: {
                group_chat_id: { type: "string", description: "From list_my_groups." },
                question: { type: "string" },
                options: { type: "array", items: { type: "string" }, description: "2-12 distinct answers." },
                allow_multiple: { type: "boolean" },
                ...SCHEDULE_PROPS,
            },
            required: ["group_chat_id", "question", "options", "hour_local"], additionalProperties: false,
        },
    },
    {
        name: "list_scheduled",
        description: "What you have scheduled: messages and polls waiting to go out, with the id needed to cancel one.",
        inputSchema: {
            type: "object",
            properties: { group_chat_id: { type: "string", description: "Optional: only this group's." } },
            additionalProperties: false,
        },
    },
    {
        name: "cancel_scheduled",
        description: "Cancel one of your scheduled messages or polls, by the id from list_scheduled.",
        inputSchema: {
            type: "object",
            properties: { task_id: { type: "string" } },
            required: ["task_id"], additionalProperties: false,
        },
    },
    {
        name: "set_reminder",
        description: "Have Gepetel remind you of something on WhatsApp at a given time.",
        inputSchema: {
            type: "object",
            properties: {
                what: { type: "string", description: "What to remind you of, in your own words." },
                at: { type: "string", description: "When, in YOUR local time, as YYYY-MM-DD HH:MM." },
            },
            required: ["what", "at"], additionalProperties: false,
        },
    },
    {
        name: "list_reminders",
        description: "Your upcoming reminders, with the id needed to cancel one.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "cancel_reminder",
        description: "Cancel one of your reminders, by the id from list_reminders.",
        inputSchema: {
            type: "object",
            properties: { reminder_id: { type: "string" } },
            required: ["reminder_id"], additionalProperties: false,
        },
    },
];

/** Run a tool for a caller. Throws with a readable message — the caller is a
 *  model that will show it to a person, so "that group isn't one of yours"
 *  beats a stack trace. */
export async function callTool(name: string, args: any, caller: Caller): Promise<any> {
    const ctx = ctxOf(caller);
    const a = args || {};

    switch (name) {
        case "send_me_a_message": {
            const text = str(a.message);
            if (!text) throw new Error("message is empty");
            const ok = await say.sayAndRemember(caller.chatId, text);
            if (!ok) throw new Error("WhatsApp would not take that message");
            return { sent: true };
        }

        case "list_my_groups": {
            const groups = await m.getGroupsByParticipant(caller.chatId);
            return {
                groups: groups.map(g => ({ name: g.name, group_chat_id: g.chatId })),
                // Said plainly because it is the usual surprise: Gepetel has to
                // be IN the group, and so do they.
                note: groups.length ? undefined : "You and Gepetel are not in any group together yet.",
            };
        }

        case "send_group_message": {
            const text = str(a.message);
            if (!text) throw new Error("message is empty");
            const r = await m.sendMessageNow(str(a.group_chat_id, 200), { text },
                cron.scheduledTaskDeps(), ctx, await signatureOf(caller));
            return { sent: true, posted: r?.text ?? text };
        }

        case "schedule_group_message": {
            const text = str(a.message);
            if (!text) throw new Error("message is empty");
            const task = await m.createScheduledTask({
                chat_id: str(a.group_chat_id, 200), kind: "text", payload: { text },
                hour_local: Number(a.hour_local),
                days_of_week: a.days_of_week, run_on_date: a.run_on_date, timezone: a.timezone,
                created_by: caller.chatId, created_by_name: await signatureOf(caller),
            }, ctx);
            return { scheduled: true, task_id: task?.task_id, when: u.describeSchedule(task) };
        }

        case "send_group_poll": {
            const r = await m.sendPollNow(str(a.group_chat_id, 200), {
                question: str(a.question, 300),
                options: (Array.isArray(a.options) ? a.options : []).map((x: unknown) => str(x, 100)),
                allow_multiple: !!a.allow_multiple,
            }, cron.scheduledTaskDeps(), ctx, await signatureOf(caller));
            return { sent: true, posted: r?.text ?? undefined };
        }

        case "schedule_group_poll": {
            const task = await m.createScheduledTask({
                chat_id: str(a.group_chat_id, 200), kind: "poll",
                payload: {
                    question: str(a.question, 300),
                    options: (Array.isArray(a.options) ? a.options : []).map((x: unknown) => str(x, 100)),
                    allow_multiple: !!a.allow_multiple,
                },
                hour_local: Number(a.hour_local),
                days_of_week: a.days_of_week, run_on_date: a.run_on_date, timezone: a.timezone,
                created_by: caller.chatId, created_by_name: await signatureOf(caller),
            }, ctx);
            return { scheduled: true, task_id: task?.task_id, when: u.describeSchedule(task) };
        }

        case "list_scheduled": {
            const list = await m.listScheduledTasks(a.group_chat_id ? str(a.group_chat_id, 200) : undefined, ctx);
            return {
                scheduled: list.map((t: any) => ({
                    task_id: t.task_id, group_chat_id: t.chat_id, kind: t.kind,
                    when: t.schedule || u.describeSchedule(t), active: t.active !== false,
                    what: t.payload?.text || t.payload?.question || t.title || "",
                })),
            };
        }

        case "cancel_scheduled":
            return { cancelled: true, detail: await m.deleteScheduledTask(str(a.task_id, 100), ctx) };

        case "set_reminder": {
            const what = str(a.what, 300);
            if (!what) throw new Error("what is empty");
            // Their own wall clock, as everywhere else: an ISO string with no
            // zone is read as UTC and "tomorrow at 9" fires at 11.
            const when = u.localTimeToDate(str(a.at, 40), u.inferTimezone([u.phoneDigits(caller.chatId)]) || "UTC");
            if (!when) throw new Error("couldn't read that time — give it as YYYY-MM-DD HH:MM in your local time");
            if (when.getTime() < Date.now() + 60_000) throw new Error("that time has passed");
            const row: any = await m.toolFunctions.create_reminder({
                chat_id: caller.chatId, title: what, due_date: when, is_individual: false, phone_number: null,
            });
            return { set: true, reminder_id: row?.reminder_id, at: when.toISOString(), what: row?.title };
        }

        case "list_reminders":
            return { reminders: await m.toolFunctions.list_reminders({ chat_id: caller.chatId }) };

        case "cancel_reminder":
            return { cancelled: true, detail: await m.toolFunctions.delete_reminder({ chat_id: caller.chatId, reminder_id: str(a.reminder_id, 100) }) };
    }
    throw new Error(`unknown tool: ${name}`);
}

export default { TOOLS, callTool };
