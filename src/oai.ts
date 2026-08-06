import OpenAI, { toFile } from "openai";
import axios from "axios";
import m from "./mongo.js";
import wa from "./wa.js";
import p from "./prompts.js";
import u from "./util.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const cleanUpAnswer = u.cleanUpAnswer;

// When Gepetel wakes up after staying quiet, how many of the messages it observed
// while silent get pulled into the OpenAI conversation. Bounds token cost/context
// when a group has been very chatty during a long quiet spell.
const WAKE_INGEST_LIMIT = 10;

// How many rounds of tool calls one reply may take. Tools stay available on every
// round (a request often needs "look it up, then act on it"), so this is what
// stops a model that keeps calling them from looping forever.
const MAX_TOOL_ROUNDS = 6;

// Append the group's current local date/time to the instructions so the model can
// reason about "today", "tomorrow", "in 2 hours", recency of news, etc.
function withNow(instructions: string, timezone: string): string {
    return `${instructions}\n\n[Context] Right now it is ${u.currentTimeString(timezone)}. Use this for any date/time reasoning.`;
}

// DM-only tool: relay a message to Gepetel's creator (never reveals his contact).
const CONTACT_CREATOR_TOOL: any = {
  type: "function",
  name: "contact_creator",
  description: "Send a private message to Gepetel's creator (the person who built him). Use ONLY when: (a) the user explicitly asks you to pass a message to your creator, or (b) the user asks whether you or your creator could help them build something similar / work together. NEVER reveal the creator's phone number or any contact details to the user.",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string", enum: ["relay_message", "build_request", "other"] },
      message: { type: "string", description: "What to tell the creator — summarize the user's request/interest and include any contact info THEY voluntarily shared." }
    },
    required: ["reason", "message"],
    additionalProperties: false
  },
  strict: false
};

// DM-only tools for setting up recurring posts into a group. Scheduling is done
// here rather than in the group itself, which would be noisy for everyone else.
//
// group_chat_id is taken from the list injected into the prompt, but that list is
// NOT what authorizes anything: mongo re-checks membership against the database
// on every call, so an invented or coaxed id simply fails.
const SCHEDULE_TOOLS: any[] = [
  {
    type: "function",
    name: "create_scheduled_task",
    description: "Set up something to be posted into one of this person's groups on a repeating schedule. Only use when they ask for it.",
    parameters: {
      type: "object",
      properties: {
        group_chat_id: { type: "string", description: "The id of the target group, exactly as given in the group list." },
        kind: {
          type: "string", enum: ["poll", "text", "generated"],
          description: "poll = a WhatsApp poll. text = the exact same message every time. generated = you write it fresh each time from `instruction` (a joke, an update on a topic, a nudge — anything open-ended)."
        },
        hour_local: { type: "number", description: "Hour of day 0-23, in the GROUP's local time." },
        days_of_week: {
          type: "array", items: { type: "number" },
          description: "RECURRING only: days it repeats on, 0=Sunday .. 6=Saturday. Every workday is [1,2,3,4,5]. Omit when run_on_date is given."
        },
        days_of_month: {
          type: "array", items: { type: "number" },
          description: "MONTHLY only: days of the month it repeats on, 1-31, e.g. [21, 25] for the 21st and 25th of every month. Use INSTEAD of days_of_week. A day past the end of a short month runs on that month's last day."
        },
        timezone: {
          type: "string",
          description: "IANA timezone the hour is in, e.g. Europe/Bucharest. Defaults to the group's own (shown in the group list). Pass it explicitly whenever the person names a city or country, or when the group list flags MIXED countries."
        },
        run_on_date: {
          type: "string",
          description: "ONE-OFF only: the single date it should run, as YYYY-MM-DD in the GROUP's local time (today is allowed). Use this INSTEAD of days_of_week when they want it just once — 'vineri', 'pe 12', 'mâine'. Work the actual date out from the current date given to you."
        },
        question: { type: "string", description: "poll only: the poll question." },
        options: { type: "array", items: { type: "string" }, description: "poll only: 2-12 distinct answers." },
        allow_multiple: { type: "boolean", description: "poll only: true if people may pick several answers, false if only one. Ask them which they want — never assume." },
        text: { type: "string", description: "text only: the exact message to post each time." },
        instruction: {
          type: "string",
          description: "generated only: what to write each time, in your own words, self-contained — it is read fresh with no memory of this chat. E.g. 'Post a short made-up joke about cats' or 'Check what is new in Formula 1 in the last day or two and mention it casually'. Describe the SUBJECT only; tone, length and language are already handled."
        },
        needs_web_search: {
          type: "boolean",
          description: "generated only: true if it needs looking something up online (news, scores, weather), false for anything you can write from your own head (jokes, prompts, nudges)."
        }
      },
      required: ["group_chat_id", "kind", "hour_local"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "send_poll_now",
    description: "Create ONE poll and post it into a group immediately. Nothing is scheduled and nothing repeats — use this whenever they want a poll sent now, rather than every day/week. This is the ONLY way to post a one-off poll; without calling it, nothing is sent.",
    parameters: {
      type: "object",
      properties: {
        group_chat_id: { type: "string", description: "The id of the target group, exactly as given in the group list." },
        question: { type: "string", description: "The poll question." },
        options: { type: "array", items: { type: "string" }, description: "2-12 distinct answers." },
        allow_multiple: { type: "boolean", description: "true if people may pick several answers, false if only one. Ask them which they want — never assume." }
      },
      required: ["group_chat_id", "question", "options"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "list_scheduled_tasks",
    description: "List what is already scheduled for this person's groups. Use before changing or deleting something, to find its id.",
    parameters: {
      type: "object",
      properties: { group_chat_id: { type: "string", description: "Optional: only this group." } },
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "update_scheduled_task",
    description: "Change an existing scheduled task: its time, days, content, or pause/resume it (active).",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "From list_scheduled_tasks (internal_id_do_not_show). Never show this to the user." },
        hour_local: { type: "number" },
        days_of_week: { type: "array", items: { type: "number" } },
        days_of_month: { type: "array", items: { type: "number" }, description: "1-31; replaces days_of_week." },
        timezone: { type: "string", description: "IANA timezone, e.g. Europe/Bucharest." },
        active: { type: "boolean", description: "false pauses it, true resumes it." },
        question: { type: "string" },
        options: { type: "array", items: { type: "string" } },
        allow_multiple: { type: "boolean" },
        text: { type: "string" },
        instruction: { type: "string" },
        needs_web_search: { type: "boolean" }
      },
      required: ["task_id"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "run_scheduled_task_now",
    description: "Post an existing scheduled task into its group RIGHT NOW, on top of its normal schedule. Use when someone asks to send it immediately, or to test it. Does not change or consume the schedule. This is the ONLY way to send something immediately — without calling it, nothing is sent.",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string", description: "From list_scheduled_tasks (internal_id_do_not_show). Never show this to the user." } },
      required: ["task_id"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "delete_scheduled_task",
    description: "Permanently remove a scheduled task.",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string", description: "From list_scheduled_tasks (internal_id_do_not_show). Never show this to the user." } },
      required: ["task_id"],
      additionalProperties: false
    },
    strict: false
  },
];

// How a scheduled task reaches WhatsApp when fired from a 1:1 ("send it now").
// Mirrors the cron's wiring in app.ts so a manual send behaves identically.
function scheduledDeps() {
  return {
    sendMessage: wa.sendWhatsAppMessage,
    sendPoll: wa.sendWhatsAppPoll,
    generate: async (task: any, group: any) => {
      const members = u.stripBot(group?.participants || []);
      return await generateScheduledContent(task.kind, task.payload, {
        groupName: group?.name || "",
        region: u.inferRegion(members),
        language: u.inferLanguage(members),
        timezone: task.timezone || u.inferTimezone(members),
      });
    },
  };
}

// The group tool list, minus anything the active gateway can't back up. Resolved
// per request, not once at import: WA_PROVIDER decides it and the provider can
// change under us. `get_poll_results` is the only conditional one so far — on
// wa-gateway no votes ever arrive, so offering it would have Gepetel reporting
// "0 votes" on a poll people have actually answered.
function groupTools(): OpenAI.Responses.Tool[] {
  if (wa.observesPollVotes()) return ALL_TOOLS;
  return ALL_TOOLS.filter(t => (t as any).name !== "get_poll_results");
}

// Shape a stored task into what the model is allowed to see. Raw documents leak
// straight into replies — the model happily prints `last_fired_at: null` and a
// chat jid at a human who wanted "the lunch poll, weekdays at 9". So hand it only
// what a person would say out loud, plus the id it needs to make follow-up calls
// (which the prompt forbids it from ever printing).
function taskForModel(t: any, groupName?: string): any {
    const p = t.payload || {};
    const what = t.kind === "poll"
        ? `poll: "${p.question}" — options: ${(p.options || []).join(", ")} (${p.allow_multiple ? "several answers allowed" : "one answer only"})`
        : t.kind === "text"
        ? `message: "${p.text}"`
        : `written fresh each time: ${p.instruction}`;
    return {
        internal_id_do_not_show: t.task_id,
        group: groupName || t.group_name || "",
        what,
        when: t.schedule || u.describeSchedule(t),
        paused: t.active === false ? true : undefined,
    };
}

// Fold the flat tool arguments into the payload shape mongo stores. Kept flat in
// the schema because models handle flat arguments far more reliably than nested
// objects; validation of what's required per kind happens in util.validateTaskPayload.
function taskPayloadFromArgs(kind: string, a: any): any {
  const fields = kind === "poll" ? ["question", "options", "allow_multiple"]
    : kind === "text" ? ["text"]
    : ["instruction", "web_search"];
  // The tool calls it needs_web_search (clearer for the model); storage calls it web_search.
  const src = { ...a, web_search: a.needs_web_search };
  const out: any = {};
  // Only copy what was actually supplied: on an edit the result is merged over
  // the stored payload, and an explicit `undefined` would wipe the existing value.
  for (const f of fields) if (src[f] !== undefined) out[f] = src[f];
  return out;
}

async function generateReply(
  author: string,
  message: string,
  previousMessageId: string,
  timezone: string = "UTC",
  userId: string = "",
  groups: { name: string; chatId: string; dailyReplyLimit: number; timezone?: string; timezoneConfident?: boolean }[] = []
): Promise<{ answer: string, responseId: string }> {
  const groupsText = groups.length
    ? groups.map(g => {
        const payUrl = `https://gepetel.bogdanripa.com/pay?groupId=${encodeURIComponent(g.chatId)}&userId=${encodeURIComponent(userId)}`;
        // The id and link are here for the model's own use — passing an id to a
        // tool, or handing over ONE link when asked. They are internal plumbing
        // and must never be recited back at the user; see the rules in dm.txt.
        // The timezone matters for scheduling: trust it when everyone's number
        // points at the same country, and flag it for confirmation when they don't.
        const tz = g.timezone
          ? (g.timezoneConfident
              ? ` | timezone: ${g.timezone}`
              : ` | timezone: probably ${g.timezone} — MIXED countries, ASK before scheduling`)
          : "";
        return `- "${g.name}" [internal id: ${g.chatId}] [internal payment link: ${payUrl}] current limit: ${g.dailyReplyLimit} msgs/day${tz}`;
      }).join("\n")
    : "(none — you do not share any group with this person yet)";

  const req: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
    model: "gpt-5-mini",
    tools: [CONTACT_CREATOR_TOOL, ...SCHEDULE_TOOLS],   // DM is purpose-limited; no web_search/research here
    tool_choice: "auto",
    instructions: withNow(p.loadPrompt("dm", { author, groups: groupsText, userId, botPhone: u.BOT_PHONE_DISPLAY }), timezone),
    input: [{ role: "user", content: message }],
    ...(previousMessageId ? { previous_response_id: previousMessageId } : {})
  };

  let out: any;
  try {
    out = await client.responses.create(req);
  } catch (e) {
    console.error(e);
    if (previousMessageId) return await generateReply(author, message, "", timezone, userId, groups);
    throw (e);
  }

  for (let round = 0; ; round++) {
    // Run the tools whenever the model asked for them — NOT only when it stayed
    // silent. Guarding on "no text yet" meant that a reply like "sure, sending
    // it now!" plus a tool call would return the text and quietly drop the call:
    // Gepetel announced things he then never did.
    const calls = (out.output || []).filter((i: any) => i?.type === "function_call");
    if (calls.length && round < MAX_TOOL_ROUNDS) {
      const toolResults: { call_id: string; output: string }[] = [];
      for (const item of calls) {
        {
          const name = (item as any).name ?? (item as any).tool_name;
          const args = u.parseToolArgs((item as any).arguments);
          const callId = (item as any).call_id;
          let result: any;
          try {
            if (name === "contact_creator") {
              const tag = args.reason === "build_request" ? "BUILD REQUEST" : args.reason === "relay_message" ? "MESSAGE" : "NOTE";
              await wa.notifyCreator(`📩 [${tag}] from a 1:1 chat with ${author}${userId ? ` (${userId})` : ""}:\n${args.message}`);
              result = "Done — passed it to my creator privately. I won't share his contact details.";
            } else if (name === "send_poll_now") {
              const r = await m.sendPollNow(
                args.group_chat_id,
                { question: args.question, options: args.options, allow_multiple: args.allow_multiple },
                scheduledDeps(), { requesterChatId: userId }, author
              );
              // Report the truth: a failed send must never be narrated as success.
              result = r.sent ? { sent: true } : { sent: false, reason: r.reason, tell_the_user: "it could not be posted" };
            } else if (name.endsWith("_scheduled_task") || name === "list_scheduled_tasks" || name === "run_scheduled_task_now") {
              // The caller is whoever this 1:1 chat belongs to — taken from the
              // verified chat id, never from anything the model produced. Every
              // one of these re-checks group membership in the database.
              const ctx = { requesterChatId: userId };
              if (name === "create_scheduled_task") {
                const task = await m.createScheduledTask({
                  chat_id: args.group_chat_id,
                  kind: args.kind,
                  payload: taskPayloadFromArgs(args.kind, args),
                  hour_local: args.hour_local,
                  days_of_week: args.days_of_week,
                  days_of_month: args.days_of_month,
                  run_on_date: args.run_on_date,
                  timezone: args.timezone,
                  created_by_name: author,
                }, ctx);
                result = taskForModel(task, groups.find(g => g.chatId === args.group_chat_id)?.name);
              } else if (name === "list_scheduled_tasks") {
                const list = await m.listScheduledTasks(args.group_chat_id || undefined, ctx);
                result = list.map((t: any) => taskForModel(t));
              } else if (name === "update_scheduled_task") {
                const existing = await m.getScheduledTask(args.task_id, ctx);
                const patch: any = {};
                for (const k of ["hour_local", "days_of_week", "days_of_month", "timezone", "active"]) {
                  if (args[k] !== undefined) patch[k] = args[k];
                }
                // Only rebuild the payload if a content field actually changed —
                // otherwise a time-only edit would wipe the stored content.
                if (["question", "options", "allow_multiple", "text", "instruction", "needs_web_search"].some(k => args[k] !== undefined)) {
                  patch.payload = taskPayloadFromArgs(existing.kind, args);
                }
                const task = await m.updateScheduledTask(args.task_id, patch, ctx);
                result = taskForModel(task, groups.find(g => g.chatId === task.chat_id)?.name);
              } else if (name === "run_scheduled_task_now") {
                const r = await m.runScheduledTaskNow(args.task_id, scheduledDeps(), ctx);
                // Report the real outcome — the model must never claim a send
                // that didn't happen.
                result = r.sent
                  ? { sent: true, posted: r.text }
                  : { sent: false, reason: r.reason, tell_the_user: "it could not be posted" };
              } else {
                result = await m.deleteScheduledTask(args.task_id, ctx);
              }
            } else {
              result = { error: `unknown tool: ${name}` };
            }
          } catch (err: any) {
            result = { error: String(err?.message || err || "tool error") };
          }
          toolResults.push({ call_id: callId, output: JSON.stringify(result) });
        }
      }
      out = await client.responses.create({
        model: "gpt-5-mini",
        previous_response_id: out.id,
        // Keep the tools available: most real requests need more than one round
        // ("send it now" = look it up, THEN run it). Without this the model can
        // only describe the second step, which reads as a lie.
        tools: req.tools,
        tool_choice: "auto",
        input: toolResults.map(r => ({ type: "function_call_output" as const, call_id: r.call_id, output: r.output })),
      });
      continue;
    }
    return { answer: cleanUpAnswer(out.output_text || ""), responseId: out.id };
  }
}

async function generatePaymentGroupMessage(memberName: string, newLimit: number, language: string, previousMessageId: string | null, timezone: string = "UTC"): Promise<{ answer: string; responseId: string }> {
  const res = await client.responses.create({
    model: "gpt-5-mini",
    instructions: withNow(p.loadPrompt("payment-confirm-group", { memberName, newLimit: String(newLimit), language }), timezone),
    input: [{ role: "user", content: "Announce the limit extension now." }],
    ...(previousMessageId ? { previous_response_id: previousMessageId } : {})
  });
  return { answer: cleanUpAnswer(res.output_text || ""), responseId: res.id };
}

async function generatePaymentDmConfirmation(memberName: string, groupName: string, newLimit: number, language: string, previousMessageId: string | null, timezone: string = "UTC"): Promise<{ answer: string; responseId: string }> {
  const res = await client.responses.create({
    model: "gpt-5-mini",
    instructions: withNow(p.loadPrompt("payment-confirm-dm", { memberName, groupName, newLimit: String(newLimit), language }), timezone),
    input: [{ role: "user", content: "Confirm the payment now." }],
    ...(previousMessageId ? { previous_response_id: previousMessageId } : {})
  });
  return { answer: cleanUpAnswer(res.output_text || ""), responseId: res.id };
}

async function generateGroupGreeting(groupName: string, language: string, timezone: string = "UTC"): Promise<{ answer: string, responseId: string }> {
  const response = await client.responses.create({
    model: "gpt-5-mini",
    tools: [
      { type: "web_search" },
    ],
    tool_choice: "auto",
    instructions: withNow(p.loadPrompt("group-greeting", {
      groupname: groupName,
      language
    }), timezone),
    input: [
      { role: "user", content: "You were just added to the group. Greet the group now." }
    ]
  });

  return {
    answer: cleanUpAnswer(response.output_text),
    responseId: response.id // <-- save this for next call
  };
}

// Gate: should Gepetel chime in on a non-mention group message? He should only
// speak if the new message is a genuine follow-up to HIS OWN last line (or is
// addressed to him). `lastReply` is Gepetel's previous message (may be empty).
async function shouldRespondToGroup(conversation: string, lastReply: string = ""): Promise<boolean> {
  try {
    const context = (lastReply ? `Gepetel (me) just said: "${lastReply}"\n\n` : "")
      + `Latest group messages (last line is the new one):\n${conversation}`;
    const res = await client.responses.create({
      model: "gpt-5-nano",
      reasoning: { effort: "medium" },
      instructions: p.loadPrompt("should-reply"),
      input: [{ role: "user", content: context }],
    });
    const ans = (res.output_text || "").trim().toLowerCase();
    return ans.startsWith("yes");
  } catch (e) {
    console.error("shouldRespondToGroup error:", e);
    return false; // on error / uncertainty, stay quiet
  }
}

// Generate an unprompted conversation starter for a group, using web_search to
// find something recent and specific to what the group is about (their trip,
// team, neighborhood...), anchored in the recent conversation and memories.
async function generateGossip(groupName: string, region: string, language: string, topics: string, conversation: string, previousMessageId?: string | null, timezone: string = "UTC"): Promise<{ answer: string; responseId: string }> {
  const res = await client.responses.create({
    model: "gpt-5-mini",
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    instructions: withNow(p.loadPrompt("gossip", {
      groupname: groupName || "(unknown)",
      region,
      language,
      topics: topics || "(nothing notable yet)",
      conversation: conversation || "(no recent messages)",
    }), timezone),
    input: [{ role: "user", content: "Start a conversation in the group now." }],
    ...(previousMessageId ? { previous_response_id: previousMessageId } : {})
  });
  return { answer: cleanUpAnswer(res.output_text || "no answer"), responseId: res.id };
}

// Content for a `generated` scheduled task — written fresh each time from the
// instruction captured when the task was set up.
//
// Deliberately NOT threaded onto the group's previous_response_id: a scheduled
// post is published on a timer, not said in a conversation, and threading it
// would make Gepetel treat his own timer output as his last conversational turn.
// What was sent is fed back separately as a cached message (see mongo.ts).
//
// Returns null when there's nothing worth sending, and the caller skips the send.
async function generateScheduledContent(
  kind: string,
  payload: any,
  opts: { groupName?: string; region?: string; language?: string; timezone?: string } = {}
): Promise<string | null> {
  const { groupName = "", region = "", language = "English", timezone = "UTC" } = opts;

  const instruction = String(payload?.instruction || "").trim();
  if (!instruction) return null;

  const req: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
    model: "gpt-5-mini",
    // Live lookup is opt-in per task, decided when it was set up: a joke has no
    // business paying for a web search.
    ...(payload?.web_search ? { tools: [{ type: "web_search" as const }], tool_choice: "auto" as const } : {}),
    instructions: withNow(p.loadPrompt("scheduled-generated", {
      instruction,
      groupname: groupName || "(unknown)",
      region,
      language,
    }), timezone),
    input: [{ role: "user", content: "Write this round's message now." }],
  };

  try {
    const res = await client.responses.create(req);
    const answer = cleanUpAnswer((res.output_text || "").trim());
    // Same convention as the group reply and gossip paths.
    if (!answer || answer.toLowerCase().includes("no answer")) return null;
    return answer;
  } catch (e) {
    console.error(`generateScheduledContent (${kind}) failed:`, e);
    return null;   // a bad day for the API is not a reason to post garbage
  }
}

// Structured place/business lookup via web_search (powers the get_place_info tool).
async function lookupPlace(name: string, location: string = ""): Promise<string> {
  const q = location ? `${name} in ${location}` : name;
  const res = await client.responses.create({
    model: "gpt-5-mini",
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    instructions: "Look up the place/business and return a SHORT factual block with whatever you can find: name, address, phone, opening hours, website, and what it's known for (signature dishes / rating). Plain text, no markdown links. If you can't find it, say so plainly.",
    input: [{ role: "user", content: `Find info about: ${q}` }],
  });
  return res.output_text || "Couldn't find info on that place.";
}

const ALL_TOOLS: OpenAI.Responses.Tool[] = [
  { type: "web_search" },
  {
    type: "function",
    name: "remember_fact",
    description: "Save an important fact for the group (decisions, dates, recurring details).",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Short, factual phrase, easy to find again." },
        details: { type: "string", description: "Optional details (max 2 sentences)." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags (e.g. 'meeting', 'deadline')." }
      },
      required: ["summary"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "list_memories",
    description: "List the facts saved for the group.",
    parameters: {
      type: "object",
      properties: { tag: { type: "string", description: "Optional filter by tag." } },
      required: [],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "delete_memory",
    description: "Delete a saved fact by id.",
    parameters: {
      type: "object",
      properties: { memory_id: { type: "string" } },
      required: ["memory_id"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "create_action_item",
    description: "Create a task / action item.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "The task title/description." },
        assignee: { type: "string", description: "Who is responsible (optional)." },
        status: { type: "string", description: "open/doing/done or short text." },
        due_date: { type: "string", format: "date-time", description: "Optional deadline." }
      },
      required: ["title"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "list_action_items",
    description: "List the group tasks.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "search_action_items",
    description: "Search tasks by text or assignee.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "Word/fragment to search in title/assignee/status." } },
      required: [],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "update_action_item",
    description: "Update a task.",
    parameters: {
      type: "object",
      properties: {
        action_item_id: { type: "string" },
        title: { type: "string" },
        assignee: { type: "string" },
        status: { type: "string" },
        due_date: { type: "string", format: "date-time" }
      },
      required: ["action_item_id"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "delete_action_item",
    description: "Delete a task.",
    parameters: {
      type: "object",
      properties: { action_item_id: { type: "string" } },
      required: ["action_item_id"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "create_poll",
    description: "Create a poll for the group.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" }, description: "List of options (min 2, max 12)." },
        allow_multiple: { type: "boolean", description: "Allow multiple votes" }
      },
      required: ["question", "options"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "list_polls",
    description: "List the group polls.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "search_polls",
    description: "Search polls by question.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: [],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "update_poll",
    description: "Update a poll.",
    parameters: {
      type: "object",
      properties: {
        poll_id: { type: "string" },
        question: { type: "string" },
        options: { type: "array", items: { type: "string" } },
        allow_multiple: { type: "boolean" }
      },
      required: ["poll_id"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "delete_poll",
    description: "Delete a poll.",
    parameters: {
      type: "object",
      properties: { poll_id: { type: "string" } },
      required: ["poll_id"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "get_poll_results",
    description: "See a poll results/votes (vote count per option and total).",
    parameters: {
      type: "object",
      properties: { poll_id: { type: "string" } },
      required: ["poll_id"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "create_reminder",
    description: "Add a reminder for the group. Example: @gepetel, remind us to join the meeting tomorrow at 8pm",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        due_date: { type: "string", format: "date-time" },
        is_individual: { type: "boolean", description: "True if the reminder is just for a user, false if it's for the entire group" },
        phone_number: { type: "string", description: "The phone number of the user to whom the reminder is addressed, in international format (e.g. +40750271099). To be used only if is_individual is true." }
      },
      required: ["title", "due_date", "is_individual"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "list_reminders",
    description: "List the group active (upcoming) reminders.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "search_reminders",
    description: "Search reminders by text.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "Word/fragment to search in the title." } },
      required: [],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "update_reminder",
    description: "Update a reminder",
    parameters: {
      type: "object",
      properties: {
        reminder_id: { type: "string" },
        title: { type: "string" },
        due_date: { type: "string", format: "date-time" },
        is_individual: { type: "boolean" },
        phone_number: { type: "string", description: "The phone number of the user to whom the reminder is addressed, in international format (e.g. +40750271099). To be used only if is_individual is true." }
      },
      required: ["reminder_id"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "delete_reminder",
    description: "Delete a reminder",
    parameters: {
      type: "object",
      properties: { reminder_id: { type: "string" } },
      required: ["reminder_id"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "create_recurring_reminder",
    description: "Create a repeating reminder (daily/weekly/monthly). due_date is the first occurrence. Example: water the plants every week.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        due_date: { type: "string", format: "date-time", description: "First occurrence." },
        recurrence: { type: "string", enum: ["daily", "weekly", "monthly"] },
        is_individual: { type: "boolean" },
        phone_number: { type: "string", description: "Required only if is_individual is true; international format e.g. +40750271099." }
      },
      required: ["title", "due_date", "recurrence"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "split_bill",
    description: "Split a bill among people. Give the total and either a head count (people) or a list of names. Optional tip percentage and currency.",
    parameters: {
      type: "object",
      properties: {
        total: { type: "number", description: "The total amount of the bill." },
        people: { type: "number", description: "Number of people splitting (use this OR names)." },
        names: { type: "array", items: { type: "string" }, description: "Names of the people splitting (use this OR people)." },
        tip_percent: { type: "number", description: "Optional tip percentage to add before splitting." },
        currency: { type: "string", description: "Optional currency label, e.g. RON, EUR." }
      },
      required: ["total"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "get_place_info",
    description: "Look up a specific business/venue (restaurant, bar, shop, etc.) and get its phone, address, hours, website and what it's known for. Use when the group is talking about going somewhere and needs details.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the place." },
        location: { type: "string", description: "Optional city/area to disambiguate." }
      },
      required: ["name"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "read_url",
    description: "Fetch a specific web page / URL and read its text content. Use when someone shares a link or asks what a specific page says.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full URL to read (https://...)." }
      },
      required: ["url"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "generate_image",
    description: "Create a brand-new image from a text description and send it to the chat. Use when someone asks you to draw/generate/make an image.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed description of the image to create." },
        caption: { type: "string", description: "Optional short caption to send with the image." }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "edit_image",
    description: "Modify the most recent image someone sent in this chat and send the edited version back. Use when someone shares an image and asks for a change (e.g. 'make the sky blue', 'remove the background').",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to change in the image." },
        caption: { type: "string", description: "Optional short caption to send with the edited image." }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    strict: false
  }
];

export async function generateGroupReply(
  chatId: string,
  groupName: string,
  numberOfParticipants: number,
  previousMessageId: string | null,
  message: string,
  numUnprocessedGropMessages: number,
  iWasMentioned: boolean,
  timezone: string = "UTC"
): Promise<{ answer: string; responseId: string; consumedMessages: { from: string; text: string; timestamp?: Date }[]; }> {
  let consumedMessages: { from: string; text: string; timestamp?: Date }[] = [];

  const req: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
    model: "gpt-5-mini",
    instructions: withNow(p.loadPrompt("group-reply", {
      groupname: groupName,
      numberofparticipants: numberOfParticipants.toString(),
      pollvotes: wa.observesPollVotes()
        ? "- `get_poll_results` (see the votes)."
        : "- You CANNOT see poll votes: no gateway sends them here. Never state, guess or imply a tally, a winning option, or who voted. If asked, say you can't see the results — people can tap the poll themselves."
    }), timezone),
    input: [
      { role: "user", content: message }
    ],
    tools: groupTools(),
    tool_choice: "auto",
    ...(previousMessageId ? { previous_response_id: previousMessageId } : {})
  }
  if (numUnprocessedGropMessages>0) {
    // Waking up: pull the messages observed while quiet (capped at the most recent
    // N) and add them to the conversation before the line that triggered the reply.
    const lastMessage = await m.getLastMessagesThenDeleteThem(chatId, WAKE_INGEST_LIMIT);
    consumedMessages = lastMessage.slice().reverse(); // oldest-first for readability
    req.input = [
      ...consumedMessages.map(message => ({ role: "user" as const, content: `${message.from} (at ${message.timestamp}): ${message.text}` })),
      { role: "user", content: message }
    ];
  }

  // Tell the model who it actually knows in the group, so it never invents members.
  const known = await m.getKnownMembers(chatId);
  const roster = known.length
    ? `You only recognise these members by name so far: ${known.join(", ")}. There are ${numberOfParticipants} people total, so there are others whose names you do NOT know.`
    : `You do NOT know anyone's name in this group yet — you only learn names as people speak.`;
  req.instructions = `${req.instructions}\n\n[Group roster] ${roster} NEVER invent, guess, or make up the names of group members or who did something. If a question needs a member you don't know (e.g. "guess who won"), say honestly/playfully that you don't actually know who's in the group — do not produce fake names.`;

  let out: any = await client.responses.create(req);

  for (let round = 0; ; round++) {
    // Execute the tools whenever the model asked for them — NOT only when it
    // produced no text. The old guard dropped every tool call that came with a
    // sentence attached, so a reminder or poll the group asked for would be
    // cheerfully confirmed and never actually created.
    const calls = (out.output || []).filter((i: any) => i?.type === "function_call");
    if (calls.length && round < MAX_TOOL_ROUNDS) {
      const toolResults = [];
      for (const item of calls) {
        {
          const name = (item as any)?.name ?? (item as any)?.tool_name;
          const args = u.parseToolArgs((item as any)?.arguments);
          const callId = (item as any)?.call_id;
          args.chat_id = chatId;
          console.log(`Tool call: ${name} with args: ${JSON.stringify(args)}`);
          try {
            let result: any;
            if (name === "get_place_info") {
              // Web-search-backed lookup, handled here (no DB op).
              result = await lookupPlace(args.name, args.location);
            } else if (name === "read_url") {
              // Fetch a specific URL and return its readable text.
              result = await wa.readUrl(args.url);
            } else if (name === "generate_image") {
              const b64 = await generateImage(args.prompt);
              if (b64) { await wa.sendWhatsAppImage(chatId, b64, args.caption || ""); result = "Image generated and sent to the chat."; }
              else result = "Image generation failed.";
            } else if (name === "edit_image") {
              const src = await m.getLastImage(chatId);
              if (!src) { result = "There's no recent image in this chat to edit."; }
              else {
                const b64 = await editImage(src, args.prompt);
                if (b64) { await wa.sendWhatsAppImage(chatId, b64, args.caption || ""); result = "Edited image sent to the chat."; }
                else result = "Image edit failed.";
              }
            } else {
            if (!m.toolFunctions[name as keyof typeof m.toolFunctions]) {
              throw new Error(`Function not implemented: ${name}`);
            }
            result = await m.toolFunctions[name as keyof typeof m.toolFunctions](args);
            if (name === "create_poll") {
              const opts = Array.isArray(args.options) ? args.options : [];
              // best-effort send of native poll; fallback to text inside helper
              const waMessageId = await wa.sendWhatsAppPoll(chatId, args.question || result?.question || "Poll", opts, !!args.allow_multiple);
              // Persist the WhatsApp message id so incoming votes can be matched to this poll.
              if (waMessageId && result?.poll_id) {
                await m.setPollWaMessageId(result.poll_id, waMessageId);
              }
            }
            }
            toolResults.push({
              tool_call_id: callId,
              output: JSON.stringify(result ?? null)
            });
          } catch (err: any) {
            toolResults.push({
              tool_call_id: callId,
              output: JSON.stringify({
                error: String(err?.message || err || "Tool error")
              })
            });
          }
        }
      }

      // Send tool outputs as a follow-up turn
      out = await client.responses.create({
        model: "gpt-5-mini",
        // Continue the same threaded exchange
        previous_response_id: out.id,
        // Tools stay available: a request often needs several rounds (look
        // something up, then act on it). Dropping them here left the model able
        // to describe the next step but not to perform it.
        tools: groupTools(),
        tool_choice: "auto",
        input: toolResults.map(r => ({
          type: "function_call_output" as const,
          call_id: r.tool_call_id,
          output: r.output
        }))
      });

      continue; // check if more tool calls or final text
    }

    // No tool calls → take assistant text (or "no answer")
    const answer = cleanUpAnswer(out.output_text?.trim() || "no answer");

    return { answer, responseId: out.id, consumedMessages };
  }
}

// One-time growth DM: thanks a frequent group member and nudges them to add
// Gepetel to their other group chats. Cold 1:1 message, no conversation thread.
async function generateGrowthNudge(memberName: string, language: string, timezone: string = "UTC"): Promise<{ answer: string; responseId: string }> {
  const res = await client.responses.create({
    model: "gpt-5-mini",
    instructions: withNow(p.loadPrompt("growth-nudge", { memberName: memberName || "", language }), timezone),
    input: [{ role: "user", content: "Write the message now." }],
  });
  return { answer: cleanUpAnswer(res.output_text || ""), responseId: res.id };
}

async function generateDailyLimitMessage(language: string, previousMessageId: string | null, timezone: string = "UTC"): Promise<{ answer: string; responseId: string }> {
  const res = await client.responses.create({
    model: "gpt-5-mini",
    instructions: withNow(p.loadPrompt("daily-limit", { language }), timezone),
    input: [{ role: "user", content: "Tell the group you've hit your daily limit." }],
    ...(previousMessageId ? { previous_response_id: previousMessageId } : {})
  });
  return { answer: cleanUpAnswer(res.output_text || ""), responseId: res.id };
}

// Exhaustively extract everything from an image. This text becomes the ONLY
// record of the image (the original isn't kept), so later questions must be
// answerable from it alone — transcribe text, math, tables, diagrams, etc.
async function getImageDescription(imageUrl: string): Promise<string> {
    const prompt = `Extract EVERYTHING from this image into text. This text is the only record of the image and must be enough to answer any later question about it, so be exhaustive, not a summary.
- Transcribe all visible text VERBATIM (preserve numbers, labels, captions, handwriting).
- If there is math: write out every formula, equation, and expression exactly (use LaTeX), including sub/superscripts, units, and any given values.
- If it's a figure/diagram/chart: describe the type, every axis/label/legend, and read off the data points or relationships.
- If it's a table: reproduce its rows and columns.
- If it's a photo/screenshot/scene: describe objects, people, actions, and any text on signs/screens/labels.
Start the output with a one-line tag of what it is (e.g. "Math problem:", "Screenshot:", "Photo:"), then the full extraction.`;
    const response = await client.chat.completions.create({
        model: 'gpt-5-mini',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `${imageUrl}` } },
            ],
          },
        ],
    });

    const description = response.choices[0].message.content || 'image';
    return description;
}

// Generate an image from a text prompt. Returns base64 PNG (or null on failure).
async function generateImage(prompt: string): Promise<string | null> {
    try {
        const r: any = await client.images.generate({ model: "gpt-image-1", prompt, size: "1024x1024", n: 1 });
        return r?.data?.[0]?.b64_json || null;
    } catch (e: any) {
        console.error("generateImage failed:", e?.message || e);
        return null;
    }
}

// Load an image (http url, data-uri, or raw base64) into an OpenAI file.
async function loadImageFile(src: string) {
    let buf: Buffer, ct = "image/jpeg";
    if (src.startsWith("http")) {
        const resp = await axios.get(src, { responseType: "arraybuffer", timeout: 30000 });
        buf = Buffer.from(resp.data);
        ct = resp.headers["content-type"] || ct;
    } else {
        const m = src.match(/^data:([^;]+);base64,(.*)$/);
        buf = Buffer.from(m ? m[2] : src, "base64");
        if (m) ct = m[1];
    }
    const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
    return await toFile(buf, `source.${ext}`, { type: ct });
}

// Edit an existing image with a text instruction. Returns base64 PNG (or null).
async function editImage(imageSrc: string, prompt: string): Promise<string | null> {
    try {
        const file = await loadImageFile(imageSrc);
        const r: any = await client.images.edit({ model: "gpt-image-1", image: file, prompt });
        return r?.data?.[0]?.b64_json || null;
    } catch (e: any) {
        console.error("editImage failed:", e?.message || e);
        return null;
    }
}

// Download a voice/audio file and transcribe it to text.
async function transcribeVoice(audioUrl: string): Promise<string> {
    const resp = await axios.get(audioUrl, { responseType: "arraybuffer", timeout: 30000 });
    const file = await toFile(Buffer.from(resp.data), "voice.ogg", { type: "audio/ogg" });
    const tr = await client.audio.transcriptions.create({ file, model: "gpt-4o-transcribe" });
    return (tr.text || "").trim();
}

export default { generateReply, generateGroupGreeting, generateGroupReply, getImageDescription, shouldRespondToGroup, generateGossip, generateDailyLimitMessage, generateGrowthNudge, generatePaymentGroupMessage, generatePaymentDmConfirmation, transcribeVoice, generateScheduledContent };
