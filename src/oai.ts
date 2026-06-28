import OpenAI from "openai";
import m from "./mongo.js";
import wa from "./whapi.js";
import p from "./prompts.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function cleanUpAnswer(answer: string): string {
    return answer.replace(/^"(.*)"$/, '$1');
}

async function generateReply(author: string, message: string, previousMessageId: string): Promise<{ answer: string, responseId: string }> {
  let response;
  try {
    response = await client.responses.create({
      model: "gpt-5-mini",
      tools: [
        { type: "web_search" }
      ],
      tool_choice: "auto",
      instructions: p.loadPrompt("dm", { author }),
      input: [
        { role: "user", content: message }
      ],
      ...(previousMessageId ? { previous_response_id: previousMessageId } : {})
    });
  } catch(e) {
    console.error(e);
    if (previousMessageId)
      return await generateReply(author, message, "");
    throw(e);
  }

  return {
    answer: cleanUpAnswer(response.output_text),
    responseId: response.id // <-- save this for next call
  };
}

async function generateGroupGreeting(groupName: string, numberOfParticipants: number): Promise<{ answer: string, responseId: string }> {
  const response = await client.responses.create({
    model: "gpt-5-mini",
    tools: [
      { type: "web_search" },
    ],
    tool_choice: "auto",
    instructions: p.loadPrompt("group-greeting", {
      groupname: groupName,
      numberofparticipants: numberOfParticipants.toString()
    }),
    input: [
      { role: "user", content: "Tocmai ai fost adăugat în grup. Salută grupul acum." }
    ]
  });

  return {
    answer: cleanUpAnswer(response.output_text),
    responseId: response.id // <-- save this for next call
  };
}

// Fast/cheap gate: should Gepetel chime in on a non-mention group message?
// `longGap` means it's been over a day since his last reply (the re-engage case),
// where we let him be a touch more willing to jump back in.
async function shouldRespondToGroup(conversation: string, longGap: boolean): Promise<boolean> {
  try {
    const input: any[] = [{ role: "user", content: conversation }];
    if (longGap) {
      input.unshift({
        role: "developer",
        content: "Gepetel n-a mai zis nimic de peste o zi, dar grupul e activ acum. Poate reintra in vorba daca are ceva relevant sau amuzant de adaugat la subiectul curent — dar tot fara sa fie intruziv."
      });
    }
    const res = await client.responses.create({
      model: "gpt-5-nano",
      reasoning: { effort: "minimal" },
      instructions: p.loadPrompt("should-reply"),
      input
    });
    const ans = (res.output_text || "").trim().toLowerCase();
    return ans.startsWith("da") || ans.startsWith("yes");
  } catch (e) {
    console.error("shouldRespondToGroup error:", e);
    return false; // on error / uncertainty, stay quiet
  }
}

const tools: OpenAI.Responses.Tool[] = [
  { type: "web_search" },
  {
    type: "function",
    name: "remember_fact",
    description: "Memoreaza un fapt important pentru grup (decizii, date, detalii recurente).",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Fraza scurta, factuala, usor de regasit." },
        details: { type: "string", description: "Detalii optionale (max 2 fraze)." },
        tags: { type: "array", items: { type: "string" }, description: "Etichete optionale (ex: 'meeting', 'deadline')." }
      },
      required: ["summary"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "list_memories",
    description: "Lista fapte memorate pentru grup.",
    parameters: {
      type: "object",
      properties: { tag: { type: "string", description: "Filtru optional dupa tag." } },
      required: [],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "delete_memory",
    description: "Sterge un fapt memorat dupa id.",
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
    description: "Creeaza un task / action item.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Titlul/descrierea task-ului." },
        assignee: { type: "string", description: "Cine se ocupa (optional)." },
        status: { type: "string", description: "open/doing/done sau text scurt." },
        due_date: { type: "string", format: "date-time", description: "Deadline optional." }
      },
      required: ["title"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "list_action_items",
    description: "Listeaza task-urile din grup.",
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
    description: "Cauta task-uri dupa text sau responsabil.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "Cuvant/fragment de cautat in titlu/assignee/status." } },
      required: [],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "update_action_item",
    description: "Modifica un task.",
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
    description: "Sterge un task.",
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
    description: "Creeaza un poll pentru grup.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" }, description: "Lista de optiuni (min 2, max 12)." },
        allow_multiple: { type: "boolean", description: "Permite vot multiplu" }
      },
      required: ["question", "options"],
      additionalProperties: false
    },
    strict: false
  },
  {
    type: "function",
    name: "list_polls",
    description: "Listeaza poll-urile din grup.",
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
    description: "Cauta poll-uri dupa intrebare.",
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
    description: "Modifica un poll.",
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
    description: "Sterge un poll.",
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
    description: "Vezi rezultatele/voturile unui poll (numar de voturi per optiune si total).",
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
    description: "Adauga un reminder in grup. Exemplu: @gepetel, adu-ne aminte sa intram in meeting maine la 8 seara",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        due_date: { type: "string", format: "date-time" },
        is_individual: { type: "boolean", description: "True if the reminder is just for a user, false if it's for the entiregroup" },
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
    description: "Listeaza reminderele active (viitoare) pentru grup.",
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
    description: "Cauta remindere dupa text.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "Cuvant/fragment de cautat in titlu." } },
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
  }
];

export async function generateGroupReply(
  chatId: string,
  groupName: string,
  numberOfParticipants: number,
  previousMessageId: string | null,
  message: string,
  numUnprocessedGropMessages: number,
  iWasMentioned: boolean
): Promise<{ answer: string; responseId: string; consumedMessages: { from: string; text: string; timestamp?: Date }[]; }> {
  let consumedMessages: { from: string; text: string; timestamp?: Date }[] = [];

  const req: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
    model: "gpt-5-mini",
    instructions: p.loadPrompt("group-reply", {
      groupname: groupName,
      numberofparticipants: numberOfParticipants.toString()
    }),
    input: [
      { role: "user", content: message }
    ],
    tools,
    tool_choice: "auto",
    ...(previousMessageId ? { previous_response_id: previousMessageId } : {})
  }
  if (numUnprocessedGropMessages>0) {
    const lastMessage = await m.getLastMessagesThenDeleteThem(chatId);
    consumedMessages = lastMessage.slice().reverse(); // oldest-first for readability
    req.input = [
      ...consumedMessages.map(message => ({ role: "user" as const, content: `${message.from} (at ${message.timestamp}): ${message.text}` })),
      { role: "user", content: message }
    ];
  }

  let out: any = await client.responses.create(req);

  console.log(`Output: ${JSON.stringify(out)}`);

  while (true) {
    // If there are tool calls, execute them and send back the results
    if (!out.output_text && out.output && out.output.length) {
      const toolResults = [];
      for (const item of out.output) {
        if (item?.type === "function_call") {
          const name = (item as any)?.name ?? (item as any)?.tool_name;
          const args = parseArgs((item as any)?.arguments);
          const callId = (item as any)?.call_id;
          args.chat_id = chatId;
          console.log(`Tool call: ${name} with args: ${JSON.stringify(args)}`);
          try {
            if (!m.toolFunctions[name as keyof typeof m.toolFunctions]) {
              throw new Error(`Function not implemented: ${name}`);
            }
            const result = await m.toolFunctions[name as keyof typeof m.toolFunctions](args);
            if (name === "create_poll") {
              const opts = Array.isArray(args.options) ? args.options : [];
              // best-effort send of native poll; fallback to text inside helper
              const waMessageId = await wa.sendWhatsAppPoll(chatId, args.question || result?.question || "Poll", opts, !!args.allow_multiple);
              // Persist the WhatsApp message id so incoming votes can be matched to this poll.
              if (waMessageId && result?.poll_id) {
                await m.setPollWaMessageId(result.poll_id, waMessageId);
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
          type: "custom_tool_call_output" as const,
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

async function updateMessages(chatId: string, previousMessageId: string) {
  const req: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
    model: "gpt-5-mini",
    instructions: p.loadPrompt("catchup"),
    ...(previousMessageId ? { previous_response_id: previousMessageId } : {})
  }
  const lastMessage = await m.getLastMessagesThenDeleteThem(chatId);
  req.input = [
    ...lastMessage.map(message => ({ role: "user" as const, content: `${message.from} (at ${message.timestamp}): ${message.text}` })),
  ];

  let out: any = await client.responses.create(req);
  return {answer: "no answer", responseId: out.id};
}

function parseArgs(maybe: unknown) {
  if (!maybe) return {};
  if (typeof maybe === "object") return maybe as any;
  try { return JSON.parse(String(maybe)); } catch { return {}; }
}


async function getImageDescription(imageUrl: string): Promise<string> {
    const response = await client.chat.completions.create({
        model: 'gpt-5-mini',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Te rog descrie ce reprezinta aceasta imagine folosind cat mai putine cuvinte.' },
              { type: 'image_url', image_url: { url: `${imageUrl}` } },
            ],
          },
        ],
    });
  
    const description = response.choices[0].message.content || 'imagine';
    return description;
}

export default { generateReply, updateMessages, generateGroupGreeting, generateGroupReply, getImageDescription, shouldRespondToGroup };
