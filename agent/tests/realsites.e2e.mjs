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
console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
