// Recipes: the second time costs no model — and they never keep a secret.
//
// The acceptance run is the spec's own: the same bill check twice, counting
// model calls by model, in a real (headless, throwaway) Chrome against a
// fixture site whose numbers change between runs — and then the site changes,
// and the recipe has to repair itself.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { cleanUrl, parameterize, anchorFacts, readFacts, fill, readMatch, RecipeStore, Recorder } from "../dist/recipes.js";
import { browse } from "../dist/browse.js";
import { McpClient } from "../dist/mcpClient.js";

const BILL = (amount, due) => `- main [ref=e1]:
  - heading "Facturi" [level=1] [ref=e2]
  - table [ref=e3]:
    - row [ref=e4]:
      - cell "Total de plată" [ref=e5]
      - cell "${amount}" [ref=e6]
    - row [ref=e7]:
      - cell "Scadență" [ref=e8]
      - cell "${due}" [ref=e9]`;

describe("the pieces", () => {
  test("addresses lose anything that looks like a credential, and keep the rest", () => {
    assert.equal(cleanUrl("https://x.ro/a?token=s3cret&acct=12&sid=9#frag"), "https://x.ro/a?acct=12");
    assert.equal(cleanUrl("https://x.ro/a?code=1&state=2&page=3"), "https://x.ro/a?page=3");
  });
  test("typed text from the goal becomes a parameter; other typing stays literal", () => {
    const { steps, params } = parameterize("find hotels in Cluj for Friday", [
      { do: "type", role: "searchbox", name: "Search", text: "hotels in Cluj" },
      { do: "type", role: "textbox", name: "Guests", text: "2" },
    ]);
    assert.deepEqual(params, [{ name: "p1", example: "hotels in Cluj" }]);
    assert.equal(steps[0].text, "{p1}");
    assert.equal(steps[1].text, "2");
  });
  test("facts are pinned to their labels, and read back with today's values", () => {
    const answer = "Factura: 142,30 lei, scadentă pe 15 oct 2026.";
    const pinned = anchorFacts(BILL("142,30 lei", "15 oct 2026"), answer, { amount: "142,30 lei", due: "15 oct 2026" });
    assert.deepEqual(pinned.anchors, [{ fact: "amount", label: "Total de plată", role: "cell" }, { fact: "due", label: "Scadență", role: "cell" }]);
    assert.equal(pinned.template, "Factura: {amount}, scadentă pe {due}.");
    const now = readFacts(BILL("131,05 lei", "15 nov 2026"), pinned.anchors);
    assert.equal(fill(pinned.template, now), "Factura: 131,05 lei, scadentă pe 15 nov 2026.");
  });
  test("a fact that isn't in the answer, or isn't on the page, means no recipe at all", () => {
    assert.equal(anchorFacts(BILL("1 lei", "x"), "Total: 1 lei", { amount: "2 lei" }), null);
    assert.equal(anchorFacts(BILL("1 lei", "x"), "Total: 9 lei", { amount: "9 lei" }), null);
  });
  test("nano's answer: a pick with every parameter, or nothing", () => {
    const r = [{ intent: "a", params: [{ name: "p1", example: "x" }] }];
    assert.deepEqual(readMatch({ output_text: '{"pick":1,"params":{"p1":"Cluj"}}' }, r).params, { p1: "Cluj" });
    assert.equal(readMatch({ output_text: '{"pick":1,"params":{}}' }, r), null, "missing parameter");
    assert.equal(readMatch({ output_text: '{"pick":0}' }, r), null);
    assert.equal(readMatch({ output_text: '{"pick":7}' }, r), null);
    assert.equal(readMatch({ output_text: "sure! number one" }, r), null);
  });
});

const chrome = ["/Applications/Google Chrome.app", path.join(os.homedir(), "Applications", "Google Chrome.app")].some(p => fs.existsSync(p));
describe("twice: the second time costs no luna", chrome ? {} : { skip: "needs Google Chrome installed" }, () => {
  let server, port, mcp, dir, store, site = { link: "Facturi", amount: "142,30 lei", due: "15 oct 2026" };
  before(async () => {
    server = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url.startsWith("/facturi")) return res.end(`<title>Facturi</title><main><h1>Facturi</h1><table><tr><td>Total de plată</td><td>${site.amount}</td></tr><tr><td>Scadență</td><td>${site.due}</td></tr></table></main>`);
      res.end(`<title>Contul meu</title><main><h1>Contul meu</h1><a href="/facturi">${site.link}</a></main>`);
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gep-rec-"));
    store = new RecipeStore(path.join(dir, "recipes"));
    const cli = path.join(path.dirname(createRequire(import.meta.url).resolve("@playwright/mcp/package.json")), "cli.js");
    mcp = new McpClient(process.execPath, [cli, "--browser", "chrome", "--headless", "--isolated"], { cwd: path.join(dir, "mcp") });
    await mcp.start();
  });
  after(() => { mcp?.close(); server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  // The stand-in models. luna: open the bills, answer with intent and facts.
  // nano: pick the first saved recipe.
  const run = async (goal = "cât am de plată la Enel?") => {
    const calls = { luna: 0, nano: 0 }, seen = [];
    let checks = 0;
    const llm = async req => {
      // The goal check before an answer: a luna call of its own, counted apart.
      if (req.tool_choice?.name === "goal_check") { checks++; return { output: [{ type: "function_call", name: "goal_check", arguments: '{"achieved":true,"missing":""}' }], usage: { input_tokens: 120 } }; }
      if (req.model === "gpt-5-nano") { calls.nano++; return { output_text: '{"pick":1,"params":{}}', output: [], usage: { input_tokens: 180 } }; }
      calls.luna++;
      const text = req.input[0].content[0].text; seen.push(text);
      const link = text.match(/link "(Facturi[^"]*)" \[ref=([A-Za-z0-9_]+)\]/);
      if (link && !/Total de plată/.test(text)) return { output: [{ type: "function_call", name: "click", arguments: JSON.stringify({ ref: link[2] }) }], usage: { input_tokens: 900 } };
      const amount = text.match(/cell "(\d[^"]* lei)"/)?.[1], due = text.match(/cell "(\d+ \w+ \d{4})"/)?.[1];
      return { output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({
        answer: `Factura: ${amount}, scadentă pe ${due}.`, intent: "check the latest bill amount and due date on enel",
        facts: { amount, due } }) }], usage: { input_tokens: 900 } };
    };
    const r = await browse({ goal, start_url: `http://127.0.0.1:${port}/?token=SECRET123&acct=42`, chat_lang: "Romanian" },
      { call: (t, a) => mcp.call(t, a), llm, allowLoopback: true, recipes: store, sleep: ms => new Promise(res => setTimeout(res, Math.min(ms, 30))) });
    return { r, calls, seen, checks };
  };

  test("1st: the model does it, and a recipe is saved", async () => {
    const { r, calls, checks } = await run();
    assert.equal(r.content, "Factura: 142,30 lei, scadentă pe 15 oct 2026.");
    assert.equal(r.recipe, "saved");
    assert.deepEqual(calls, { luna: 2, nano: 0 });
    assert.equal(checks, 1, "the model's answer is checked against the goal");
    assert.equal(store.all().length, 1);
  });

  test("2nd, with new numbers: one nano call, no luna, and today's values", async () => {
    site.amount = "131,05 lei"; site.due = "15 nov 2026";
    const { r, calls, checks } = await run();
    assert.equal(r.recipe, "hit");
    assert.deepEqual(calls, { luna: 0, nano: 1 });
    assert.equal(checks, 0, "a replayed recipe's answer is not checked — no model");
    assert.equal(r.content, "Factura: 131,05 lei, scadentă pe 15 nov 2026.");
  });

  test("the site changes: the replay stops at the broken step, the model finishes, the recipe is repaired", async () => {
    site.link = "Facturile mele"; site.amount = "98,00 lei";
    const { r, calls, seen } = await run();
    assert.equal(r.recipe, "repaired");
    assert.equal(calls.nano, 1);
    assert.ok(calls.luna >= 1);
    assert.match(seen[0], /saved procedure .* couldn't find the link "Facturi"/);
    assert.match(r.content, /98,00 lei/);
    const saved = store.all()[0];
    assert.ok(saved.steps.some(s => s.do === "click" && s.name === "Facturile mele"), JSON.stringify(saved.steps));
    assert.equal(saved.repaired, 1);
  });

  test("and after the repair, no luna again", async () => {
    site.amount = "77,10 lei";
    const { r, calls } = await run();
    assert.equal(r.recipe, "hit");
    assert.deepEqual(calls, { luna: 0, nano: 1 });
    assert.match(r.content, /77,10 lei/);
  });

  test("no recipe file holds the start address's token", () => {
    const raw = fs.readdirSync(path.join(dir, "recipes")).map(f => fs.readFileSync(path.join(dir, "recipes", f), "utf8")).join("\n");
    assert.doesNotMatch(raw, /SECRET123|token=/);
    assert.match(raw, /acct=42/);
  });

  test("a job where the person was asked something is not saved", async () => {
    const other = new RecipeStore(path.join(dir, "other"));
    let turn = 0;
    const llm = async req => {
      if (req.model === "gpt-5-nano") return { output_text: '{"pick":0}', output: [] };
      turn++;
      if (turn === 1) return { output: [{ type: "function_call", name: "ask_user", arguments: JSON.stringify({ question: "Which account?", options: ["A", "B"] }) }] };
      return { output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "Account A: 77,10 lei", intent: "x", facts: { amount: "77,10 lei" } }) }] };
    };
    const r = await browse({ goal: "bill", start_url: `http://127.0.0.1:${port}/facturi` },
      { call: (t, a) => mcp.call(t, a), llm, allowLoopback: true, recipes: other, ask: async () => "1", sleep: async () => {} });
    assert.equal(r.ok, true);
    assert.equal(other.all().length, 0);
  });
});
