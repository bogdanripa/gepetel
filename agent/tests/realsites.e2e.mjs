// Real websites, signed out: the sign-in wall is handed to the person before
// any model is asked anything.
//
// The first real run (2026-10-12) spent 40 model calls on OLX's sign-in page
// instead of handing it over. This runs the same starting points in a
// headless, throwaway Chrome — never anybody's own — with no account, so each
// should land on a sign-in page and be handed over at once. No model is
// needed: one that gets called before the hand-over fails the test.
//
//   node tests/realsites.e2e.mjs        (needs network and Google Chrome)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { McpClient } from "../dist/mcpClient.js";
import { browse } from "../dist/browse.js";

const SITES = [
  { name: "OLX — my account", url: "https://www.olx.ro/myaccount/" },
  { name: "myPPC — the bill", url: "https://myppc.ppcenergy.ro/" },
  { name: "GitHub — notifications", url: "https://github.com/notifications" },
];

const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
let failures = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "  ok  " : "FAIL  "}${name}${cond ? "" : " — " + extra}`); if (!cond) failures++; };

for (const site of SITES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gep-real-"));
  const mcp = new McpClient(process.execPath, [cli, "--browser", "chrome", "--headless", "--isolated"], { cwd: dir });
  await mcp.start();
  let modelCalls = 0, asked = null, steps = [];
  // A model that only explores; it must not be what decides to hand over.
  const llm = async req => {
    modelCalls++;
    steps.push(req.input[0].content[0].text.match(/URL: (.*)/)?.[1]);
    return { output: [{ type: "function_call", name: modelCalls > 6 ? "finish" : "wait", arguments: modelCalls > 6 ? '{"answer":"gave up"}' : '{"seconds":1}' }] };
  };
  const t0 = Date.now();
  const r = await browse({ goal: `${site.name}: what is there?`, start_url: site.url, chat_lang: "Romanian" }, {
    call: (t, a) => mcp.call(t, a), llm,
    ask: async (q, img, o) => { if (!asked) asked = { q, img: !!img?.b64, takeover: !!o?.takeover, calls: modelCalls }; return "stop"; },
  }).catch(e => ({ ok: false, content: `threw: ${e.message}` }));
  console.log(`\n${site.name} (${((Date.now() - t0) / 1000).toFixed(0)}s): asked=${asked ? JSON.stringify({ ...asked, q: asked.q.slice(0, 80) }) : "never"}; model calls ${modelCalls}; ended: ${String(r.content).slice(0, 100)}`);
  check(`${site.name}: handed to the person`, !!asked, `pages the model saw: ${steps.join(" → ")}`);
  check(`${site.name}: before any model call`, asked?.calls === 0, `after ${asked?.calls} model calls`);
  check(`${site.name}: with a picture and the takeover link`, !!asked?.img && !!asked?.takeover);
  check(`${site.name}: "stop" ends it, with no more model calls`, modelCalls === asked?.calls && /Stopped|M-am oprit/.test(String(r.content)), `${modelCalls} calls; ${r.content}`);
  mcp.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
// The real failure of 2026-10-12, replayed: the chat model asked to start at
// an OLX address it made up (a 404). The job must find its way through the
// front page to "my account" and hand the sign-in page over — within a few
// steps — and "stop" must end it. The stand-in model behaves like the real
// one did: deals with the cookie banner, then looks for the account link.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gep-real-"));
  const mcp = new McpClient(process.execPath, [cli, "--browser", "chrome", "--headless", "--isolated"], { cwd: dir });
  await mcp.start();
  let modelCalls = 0, asked = null; const seen = [];
  const llm = async req => {
    modelCalls++;
    const text = req.input[0].content[0].text; seen.push(text.match(/URL: (.*)/)?.[1]);
    // Like the model reads a link: by its name, its text, or its address —
    // OLX's "Contul tău" link has no name, only a paragraph and /myaccount.
    const ref = re => text.match(new RegExp(`- (?:button|link) "([^"]*${re}[^"]*)" \\[ref=([A-Za-z0-9_]+)\\]`, "i"))?.[2];
    const linkTo = re => { const lines = text.split("\n"); for (let i = 0; i < lines.length; i++) if (new RegExp(re, "i").test(lines[i])) for (let j = i; j >= Math.max(0, i - 4); j--) { const m = lines[j].match(/- link[^\[]*\[ref=([A-Za-z0-9_]+)\]/); if (m) return m[1]; } };
    const accept = ref("accept|accep|sunt de acord|permite"), account = ref("contul|my account") || linkTo("/url: /myaccount|paragraph[^:]*: Contul");
    if (accept && !seen.slice(0, -1).length) return { output: [{ type: "function_call", name: "click", arguments: JSON.stringify({ ref: accept }) }] };
    if (account) return { output: [{ type: "function_call", name: "click", arguments: JSON.stringify({ ref: account }) }] };
    if (accept) return { output: [{ type: "function_call", name: "click", arguments: JSON.stringify({ ref: accept }) }] };
    return { output: [{ type: "function_call", name: "finish", arguments: '{"answer":"could not find the account link"}' }] };
  };
  const logs = [];
  const r = await browse({ goal: "Ce status are anunțul meu pe OLX?", start_url: "https://www.olx.ro/contul-meu/anunturile-mele/", chat_lang: "Romanian" }, {
    call: (t, a) => mcp.call(t, a), llm, log: l => logs.push(l),
    ask: async (q, img, o) => { if (!asked) asked = { q, takeover: !!o?.takeover, calls: modelCalls }; return "stop"; },
  }).catch(e => ({ ok: false, content: `threw: ${e.message}` }));
  console.log(`\nOLX from the made-up address: pages ${seen.join(" → ")}; asked after ${asked?.calls} model calls: ${asked?.q?.slice(0, 70)}; ended: ${String(r.content).slice(0, 80)}`);
  if (process.env.SHOW_LOGS) console.log(logs.join("\n"));
  check("the made-up address is recognised as not found, and the front page used", logs.some(l => /not-found page; starting at https:\/\/www\.olx\.ro\//.test(l)), logs.join(" | "));
  check("it reaches the sign-in page and hands it over", !!asked && /olx/i.test(asked.q) && asked.takeover, JSON.stringify(asked));
  check("within a few model calls, not forty", (asked?.calls ?? 99) <= 4, `${asked?.calls} calls`);
  check("\"stop\" ends it", /M-am oprit|Stopped/.test(String(r.content)), String(r.content));
  mcp.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
