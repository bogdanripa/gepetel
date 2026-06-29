import OpenAI, { toFile } from "openai";
import axios from "axios";
import m from "./mongo.js";
import wa from "./whapi.js";
import p from "./prompts.js";
import u from "./util.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const cleanUpAnswer = u.cleanUpAnswer;

// When Gepetel wakes up after staying quiet, how many of the messages it observed
// while silent get pulled into the OpenAI conversation. Bounds token cost/context
// when a group has been very chatty during a long quiet spell.
const WAKE_INGEST_LIMIT = 10;

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

async function generateReply(
  author: string,
  message: string,
  previousMessageId: string,
  timezone: string = "UTC",
  userId: string = "",
  groups: { name: string; chatId: string; dailyReplyLimit: number }[] = []
): Promise<{ answer: string, responseId: string }> {
  const groupsText = groups.length
    ? groups.map(g => {
        const payUrl = `https://gepetel.bogdanripa.com/pay?groupId=${encodeURIComponent(g.chatId)}&userId=${encodeURIComponent(userId)}`;
        return `- "${g.name}" | current limit: ${g.dailyReplyLimit} msgs/day | payment link: ${payUrl}`;
      }).join("\n")
    : "(none — you do not share any group with this person yet)";

  const req: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
    model: "gpt-5-mini",
    tools: [CONTACT_CREATOR_TOOL],   // DM is purpose-limited; no web_search/research here
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

  while (true) {
    if (!out.output_text && out.output && out.output.length) {
      const toolResults: { call_id: string; output: string }[] = [];
      for (const item of out.output) {
        if (item?.type === "function_call") {
          const name = (item as any).name ?? (item as any).tool_name;
          const args = u.parseToolArgs((item as any).arguments);
          const callId = (item as any).call_id;
          let result: any;
          try {
            if (name === "contact_creator") {
              const tag = args.reason === "build_request" ? "BUILD REQUEST" : args.reason === "relay_message" ? "MESSAGE" : "NOTE";
              await wa.notifyCreator(`📩 [${tag}] from a 1:1 chat with ${author}${userId ? ` (${userId})` : ""}:\n${args.message}`);
              result = "Done — passed it to my creator privately. I won't share his contact details.";
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

// Generate an unprompted, gossipy conversation starter for a group, using
// web_search to find something hot/controversial in the group's region.
async function generateGossip(region: string, language: string, topics: string, previousMessageId?: string | null, timezone: string = "UTC"): Promise<{ answer: string; responseId: string }> {
  const res = await client.responses.create({
    model: "gpt-5-mini",
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    instructions: withNow(p.loadPrompt("gossip", { region, language, topics: topics || "(nothing notable yet)" }), timezone),
    input: [{ role: "user", content: "Start a conversation in the group now." }],
    ...(previousMessageId ? { previous_response_id: previousMessageId } : {})
  });
  return { answer: cleanUpAnswer(res.output_text || "no answer"), responseId: res.id };
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

const tools: OpenAI.Responses.Tool[] = [
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
      numberofparticipants: numberOfParticipants.toString()
    }), timezone),
    input: [
      { role: "user", content: message }
    ],
    tools,
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

  while (true) {
    // If there are tool calls, execute them and send back the results
    if (!out.output_text && out.output && out.output.length) {
      const toolResults = [];
      for (const item of out.output) {
        if (item?.type === "function_call") {
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

export default { generateReply, generateGroupGreeting, generateGroupReply, getImageDescription, shouldRespondToGroup, generateGossip, generateDailyLimitMessage, generateGrowthNudge, generatePaymentGroupMessage, generatePaymentDmConfirmation, transcribeVoice };
