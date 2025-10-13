import OpenAI from "openai";
import m from "./mongo.js";

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
      prompt: {
        id: "pmpt_68b46ac4761c81909a6eb1f60afbf38507e3f24377f8baa8",
        variables: {
          author
        }
      },
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
    prompt: {
      "id": "pmpt_68b4326559b48190a749332aefa6c7f304b6f6cc514633aa",
      "variables": {
        "groupname": groupName,
        "numberofparticipants": numberOfParticipants.toString()
      }
    }
  });

  return {
    answer: cleanUpAnswer(response.output_text),
    responseId: response.id // <-- save this for next call
  };
}

const tools:OpenAI.Responses.Tool[] = [
  {
    type: "web_search"
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
        is_individual: { type: "boolean", description: "True if the reminder is just for a user, false if it's for the entiregroup" }
      },
      required: ["title", "due_date", "is_individual"],
      additionalProperties: false
    },
    strict: true
  },
  {
    type: "function",
    name: "get_group_future_reminders",
    description: "Get all future reminders for the group",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    },
    strict: true
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
        is_individual: { type: "boolean" }
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
      properties: { 
        reminder_id: { type: "string" } 
      },
      required: ["reminder_id"],
      additionalProperties: false
    },
    strict: true
  }
];

export async function generateGroupReply(
  chatId: string,
  groupName: string,
  numberOfParticipants: number,
  previousMessageId: string | null,
  message: string
): Promise<{ answer: string; responseId: string; }> {
  const promptNormal = 'pmpt_68b43360244881948e1a04d4891bf893013272150dec4936';

  const req: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
    model: "gpt-5-mini",
    prompt: {
      "id": promptNormal,
      "variables": {
        "groupname": groupName,
        "numberofparticipants": numberOfParticipants.toString()
      }
    },
    input: [
      { role: "user", content: message }
    ],
    tools,
    tool_choice: "auto",
    ...(previousMessageId ? { previous_response_id: previousMessageId } : {})
  }

  let out: any = await client.responses.create(req);

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
          try {
            if (!m.toolFunctions[name as keyof typeof m.toolFunctions]) {
              throw new Error(`Function not implemented: ${name}`);
            }
            const result = await m.toolFunctions[name as keyof typeof m.toolFunctions](args);
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

    return { answer, responseId: out.id };
  }
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

export default { generateReply, generateGroupGreeting, generateGroupReply, getImageDescription };