// browse: read-only, one page in context, caps that end in words.
//
// The rules are tested on their own, then the loop runs for real: Playwright
// MCP driving a headless, throwaway Chrome (never the person's) against
// fixture pages on 127.0.0.1, with a scripted stand-in for the model.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { parseSnapshot, scopeSnapshot, clickAllowed, buildInput, browse, MAX_STEPS, MAIN_CHARS } from "../dist/browse.js";
import { McpClient } from "../dist/mcpClient.js";

const SNAP = `- generic [ref=e1]:
  - navigation [ref=e2]:
    - link "Home" [ref=e3] [cursor=pointer]:
      - /url: /
  - main [ref=e5]:
    - heading "Your bills" [level=1] [ref=e6]
    - cell "142,30 lei" [ref=e11]
    - link "Next page" [ref=e13] [cursor=pointer]:
      - /url: /page2
    - button "Pay now" [ref=e14]
    - button "Next" [ref=e15]
    - link "Unsubscribe" [ref=e16]:
      - /url: /unsub
    - link "Run" [ref=e17]:
      - /url: javascript:doIt()
    - textbox "Search" [ref=e18]
    - button "Plătește" [ref=e19]
    - link "Pagina următoare" [ref=e20]:
      - /url: /p3`;

describe("what may be clicked", () => {
  const els = parseSnapshot(SNAP);
  const ok = ref => clickAllowed(els.get(ref)).ok;
  test("the snapshot is read into role, name and address", () => {
    assert.deepEqual(els.get("e13"), { ref: "e13", role: "link", name: "Next page", url: "/page2" });
    assert.equal(els.get("e14").role, "button");
  });
  test("links and next-page buttons, yes", () => {
    assert.ok(ok("e3")); assert.ok(ok("e13")); assert.ok(ok("e15")); assert.ok(ok("e20"));
  });
  test("pay, unsubscribe, a javascript: link, a text box — never, in either language", () => {
    for (const ref of ["e14", "e16", "e17", "e18", "e19"]) assert.equal(ok(ref), false, ref);
    assert.match(clickAllowed(els.get("e14")).why, /action/);
  });
  test("a ref that is not on the page is refused, not guessed", () => {
    assert.equal(ok("e999"), false);
  });
});

describe("what the model sees", () => {
  test("the main region, not the navigation, unless asked", () => {
    const main = scopeSnapshot(SNAP, "main");
    assert.match(main, /Your bills/);
    assert.doesNotMatch(main, /"Home"/);
    assert.match(scopeSnapshot(SNAP, "full"), /"Home"/);
  });
  test("a huge page is cut, and the cut is named", () => {
    const big = "- main [ref=e1]:\n" + "  - cell \"x\" [ref=e2]\n".repeat(5000);
    const s = scopeSnapshot(big, "main");
    assert.ok(s.length < MAIN_CHARS + 300);
    assert.match(s, /more characters of this page not shown/);
  });
  test("only the latest page is ever in context — however many came before", () => {
    const steps = Array.from({ length: 30 }, (_, i) => `${i + 1}. opened https://example.com/${i}`);
    const input = buildInput("find the bill", steps, { url: "https://example.com/now", title: "Now", snapshot: "- main [ref=e1]:\n  - cell \"THE-CURRENT-PAGE\" [ref=e2]" }, "main");
    const text = JSON.stringify(input);
    assert.equal(input.length, 1, "one message");
    assert.equal((text.match(/THE-CURRENT-PAGE/g) || []).length, 1);
    // The current page has two elements (e1, e2); nothing else may carry any.
    assert.deepEqual(text.match(/\[ref=e\d+\]/g), ["[ref=e1]", "[ref=e2]"], "elements from one page only");
  });
});

describe("caps end in words, never in silence", () => {
  test("a model that never finishes is stopped at the step cap with a sentence", async () => {
    let t = 0;
    const r = await browse({ goal: "loop forever" }, {
      call: async () => ({ content: [{ type: "text", text: "- Page URL: https://example.com/\n### Snapshot\n```yaml\n- main [ref=e1]\n```" }] }),
      llm: async () => ({ output: [{ type: "function_call", name: "wait", arguments: "{\"seconds\":0}" }], usage: { input_tokens: 100 } }),
      sleep: async () => {}, now: () => (t += 10),
    });
    assert.equal(r.ok, false);
    assert.equal(r.steps, MAX_STEPS);
    assert.match(r.content, /stopped after 40 steps/);
  });
  test("a home-network address is refused before the browser goes anywhere", async () => {
    const calls = [];
    const r = await browse({ goal: "look at the router", start_url: "http://192.168.1.1/" }, {
      call: async (tool, a) => { calls.push(tool); return { content: [] }; },
      llm: async () => { throw new Error("must not be asked"); },
    });
    assert.equal(r.ok, false);
    assert.deepEqual(calls, []);
  });
});

// --- for real: headless throwaway Chrome, fixture pages, scripted model -----
const chrome = ["/Applications/Google Chrome.app", path.join(os.homedir(), "Applications", "Google Chrome.app")].some(p => fs.existsSync(p));
describe("the loop, in a real browser", chrome ? {} : { skip: "needs Google Chrome installed" }, () => {
  let server, port, mcp, dir, paid = false;
  before(async () => {
    server = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/paid") { paid = true; res.end("<h1>Paid</h1>"); return; }
      if (req.url === "/bills2") { res.end(`<title>Bills, page 2</title><main><h1>Older bills</h1><table><tr><td>Aug 2026</td><td>131,05 lei</td><td>due 15 Sep</td></tr></table></main>`); return; }
      res.end(`<title>Bills</title><main><h1>Your bills</h1><table><tr><td>Sept 2026</td><td>142,30 lei</td></tr></table>
        <a href="/bills2">Next page</a> <button onclick="location='/paid'">Pay now</button></main>`);
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gep-browse-"));
    const cli = path.join(path.dirname(createRequire(import.meta.url).resolve("@playwright/mcp/package.json")), "cli.js");
    mcp = new McpClient(process.execPath, [cli, "--browser", "chrome", "--headless", "--isolated"], { cwd: dir });
    await mcp.start();
  });
  after(() => { mcp?.close(); server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test("it reads, follows a link, refuses to pay, and answers", async () => {
    const seen = [];
    let turn = 0;
    // The stand-in model: tries to pay (must be refused), follows "Next page",
    // then answers from what is on the page in front of it.
    const llm = async req => {
      const text = req.input[0].content[0].text;
      seen.push(text);
      const refOf = name => text.match(new RegExp(`"${name}" \\[ref=(e\\d+)\\]`))?.[1];
      turn++;
      if (turn === 1) return { output: [{ type: "function_call", name: "click", arguments: JSON.stringify({ ref: refOf("Pay now") }) }], usage: { input_tokens: 500 } };
      if (turn === 2) return { output: [{ type: "function_call", name: "click", arguments: JSON.stringify({ ref: refOf("Next page") }) }], usage: { input_tokens: 500 } };
      return { output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: /131,05 lei/.test(text) ? "August: 131,05 lei, due 15 Sep." : "not found" }) }], usage: { input_tokens: 500 } };
    };
    const r = await browse({ goal: "how much was last month's bill?", start_url: `http://127.0.0.1:${port}/` },
      { call: (t, a) => mcp.call(t, a), llm, allowLoopback: true, sleep: ms => new Promise(res => setTimeout(res, Math.min(ms, 50))) });
    assert.equal(r.ok, true, r.content);
    assert.equal(r.content, "August: 131,05 lei, due 15 Sep.");
    assert.equal(paid, false, "Pay now was clicked");
    assert.match(seen[1], /Not clicked: "Pay now" looks like an action/);
    assert.match(seen[2], /Older bills/);
    assert.doesNotMatch(seen[2], /142,30/, "the previous page is not carried along");
  });
});
