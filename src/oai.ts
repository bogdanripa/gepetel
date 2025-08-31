import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function cleanUpAnswer(answer: string): string {
    return answer.replace(/^"(.*)"$/, '$1');
}

async function generateReply(author: string): Promise<{ answer: string, responseId: string }> {
  const response = await openai.responses.create({
    model: "gpt-4.1-mini", // or gpt-3.5-turbo, gpt-4.1
    input: [
      {
        role: "system",
        content: `
Te cheama Gepetel, ai 28 de ani. Esti prietenos, putin satrcastic, uneori ironic, dar si util cand e cazul. Ai un umor foarte fin.
Participi la o conversatie 1:1 pe WhatsApp cu un prieten pe care il cheama ${author}.
Raspunde doar daca ai ceva amuzant, interesant sau util de spus.
Daca mesajul nu necesita un raspuns, raspunde strict cu expresia "nu raspund".  
Pastreaza raspunsurile scurte si naturale. Uneori un singur cuvant sau 2 sunt suficiente.  
Nu depasi 10 cuvinte decat daca este necesar pentru a explica ceva mai complex.  
Fii relaxat si placut in conversatie, fara sa pari rece sau prea sarcastic.`
      }
    ]
  });

  return {
    answer: cleanUpAnswer(response.output_text),
    responseId: response.id // <-- save this for next call
  };
}

async function generateGroupGreeting(groupName: string, numberOfParticipants: number): Promise<{ answer: string, responseId: string }> {
  const response = await openai.responses.create({
    model: "gpt-4.1-mini", // or gpt-3.5-turbo, gpt-4.1, etc.
    input: [
      {
        role: "system",
        content: `
Te cheama Gepetel. Esti prietenos, putin satrcastic, uneori ironic, dar si util cand e cazul.  
Ai fost tocmai adaugat in grupul "${groupName}" cu ${numberOfParticipants} membri.  
Trebuie sa te prezinti scurt si prietenos, facand o prima impresie placuta.
Poti face o gluma usoara daca se potriveste, dar nu exagera.  
Nu folosi mesaje prea lungi. Pastreaza raspunsul intre 3 si 10 de cuvinte.  
Evita sa pari prea formal, dar nici excesiv de familiar.
Daca grupul are un nume care sugereaza un subiect clar, poti face o mica referire la el.
Nu mentiona numarul de participanti din grup in raspunsul tau.
        `
      }
    ]
  });

  return {
    answer: cleanUpAnswer(response.output_text),
    responseId: response.id // <-- save this for next call
  };
}

type BotState = "normal" | "pause";

export async function generateGroupReply(
  state: BotState,
  groupName: string,
  numberOfParticipants: number,
  previousMessageId: string | null,
  message: string
): Promise<{ answer: string; responseId: string; tool: "respond" | "donotrespond" | "pauseresponses" }> {
  const promptNormal = `
Te cheama Gepetel, ai 23 de ani. Esti usor sarcastic, uneori ironic, dar si util cand e cazul. Umor fin.
Esti intr-un grup de WhatsApp numit ${groupName} cu ${numberOfParticipants} persoane.

NU ai voie sa generezi text liber. Trebuie sa alegi EXACT un tool:
- respond(text): daca ai ceva util si ti s-a adresat direct ("Gepetel") sau e clar ca ajuti.
- donotrespond(): daca nu e clar ca e nevoie de raspuns.
- pauseresponses(): daca ti se cere explicit sa te opresti ("taci", "nu te mai baga").
IMPORTANT: Intoarce DOAR un tool call.
`;

  const promptPause = `
Esti in pauza deoarece ai raspuns prea des.
Reguli (alege EXACT un tool): respond(text) DOAR la mentionare directa; pauseresponses() daca ti se cere din nou sa te opresti; altfel donotrespond().
IMPORTANT: Intoarce DOAR un tool call.
`;

  const system = state === "pause" ? promptPause : promptNormal;

  const tools: OpenAI.Responses.FunctionTool[] = [
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
    },
    {
      type: "function",
      name: "pauseresponses",
      description: "Pauzeaza postarile botului pana e reactivat.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      strict: true
    }
  ];

  // 1) Ask model to pick exactly one tool (no free text)
  const first = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: system },
      { role: "user", content: message }
    ],
    tools,
    tool_choice: "required",
    ...(previousMessageId ? { previous_response_id: previousMessageId } : {})
  });

  console.log(first);

  const call = extractFirstToolCall(first); // { name, call_id, args }
  // If somehow no tool is returned, fail-safe to donotrespond
  const toolName = call?.name ?? "donotrespond";

  // 2) Execute locally + decide the “answer” string you expose
  let answer = "nu raspund";
  if (toolName === "respond") {
    const text = String(call.args?.text ?? "").trim();
    answer = cleanUpAnswer(text);
    // your real runtime.respond(text) would happen here
  } else if (toolName === "pauseresponses") {
    answer = "iau pauza";
    // your real runtime.pauseresponses() would happen here
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
      // You can send an empty object for "no-op" tools, or a JSON string with the result.
      output: "ok"
    }
  ];

  const second = await openai.responses.create({
    model: "gpt-4.1-mini",
    previous_response_id: first.id,
    input: followupInput
  });

  console.log(second);

  // Return the second response id for the next turn in `previous_response_id`
  return { answer, responseId: second.id, tool: toolName as any };
}

/** Extract the first tool call, grabbing its call_id (required to submit output). */
function extractFirstToolCall(resp: any): { name: "respond" | "donotrespond" | "pauseresponses"; call_id: string; args: any } {
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
        model: 'gpt-4o-mini',
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
    console.log(description);
    return description;
}

export default { generateReply, generateGroupGreeting, generateGroupReply, getImageDescription };