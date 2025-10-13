import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function cleanUpAnswer(answer: string): string {
    return answer.replace(/^"(.*)"$/, '$1');
}

async function generateReply(author: string, message: string, previousMessageId: string): Promise<{ answer: string, responseId: string }> {
  let response;
  try {
    response = await openai.responses.create({
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
  const response = await openai.responses.create({
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

export async function generateGroupReply(
  state: string,
  groupName: string,
  numberOfParticipants: number,
  previousMessageId: string | null,
  message: string
): Promise<{ answer: string; responseId: string; tool: "respond" | "donotrespond" }> {
  const promptNormal = 'pmpt_68b43360244881948e1a04d4891bf893013272150dec4936';

  const tools: OpenAI.Responses.Tool[] = [
    { type: "web_search" },
    {
      type: "function",
      name: "respond",
      description: "Trimite un raspuns scurt si util in grup.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Textul exact de trimis." } },
        required: ["text"],
        additionalProperties: false
      },
      strict: true
    },
    {
      type: "function",
      name: "donotrespond",
      description: "Alege tacerea pentru acest mesaj.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      strict: true
    }
  ];

  // 1) Ask model to pick exactly one tool (no free text)
  let first;
  try {
    first = await openai.responses.create({
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
    });
  } catch(e) {
    console.error(e);
    if (previousMessageId)
      return await generateGroupReply(state, groupName, numberOfParticipants, "", message)
    throw(e);
  }

  const call = extractFirstToolCall(first); // { name, call_id, args }
  // If somehow no tool is returned, fail-safe to donotrespond
  const toolName = call?.name ?? "donotrespond";

  // 2) Execute locally + decide the “answer” string you expose
  let answer = "nu raspund";
  if (toolName === "respond") {
    const text = String(call.args?.text ?? "").trim();
    answer = cleanUpAnswer(text);
    // your real runtime.respond(text) would happen here
  } else {
    // your real runtime.donotrespond() would happen here
  }

  // 3) **Submit tool output** to close the loop (MANDATORY for chaining)
  // The Responses API expects you to feed back a function/tool result.
  // Use the *same* call_id you received.
  const followupInput = [
    {
      // per docs: use "function_call_output" with the tool's call_id
      type: "custom_tool_call_output" as const,
      call_id: call.call_id,
      output: "ok"
    }
  ];

  const second = await openai.responses.create({
    model: "gpt-5-mini",
    previous_response_id: first.id,
    input: followupInput
  });

  // Return the second response id for the next turn in `previous_response_id`
  return { answer, responseId: second.id, tool: toolName as any };
}

/** Extract the first tool call, grabbing its call_id (required to submit output). */
function extractFirstToolCall(resp: any): { name: "respond" | "donotrespond"; call_id: string; args: any } {
  const items = resp?.output ?? [];
  for (const it of items) {
    // newer shapes may be "tool_call" or "function_call"
    if (it?.type === "tool_call" || it?.type === "function_call") {
      return {
        name: (it?.name ?? it?.tool_name) as any,
        call_id: it?.call_id,
        args: parseArgs(it?.arguments)
      };
    }
    if (Array.isArray(it?.content)) {
      for (const c of it.content) {
        if (c?.type === "tool_call" || c?.type === "function_call") {
          return {
            name: (c?.name ?? c?.tool_name) as any,
            call_id: c?.call_id,
            args: parseArgs(c?.arguments)
          };
        }
      }
    }
  }
  // Fallback (shouldn’t happen because tool_choice:"required")
  return { name: "donotrespond", call_id: "missing", args: {} };
}

function parseArgs(maybe: unknown) {
  if (!maybe) return {};
  if (typeof maybe === "object") return maybe as any;
  try { return JSON.parse(String(maybe)); } catch { return {}; }
}


async function getImageDescription(imageUrl: string): Promise<string> {
    const response = await openai.chat.completions.create({
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