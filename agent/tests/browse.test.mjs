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
import { parseSnapshot, scopeSnapshot, clickAllowed, clickVerdict, looksLikeAction, buildInput, browse, labels, overlayScript, readPointing, isYes, closeAllTabs, followNewTab, parseTabs, wantsDone, updateLine, UPDATE_EVERY_MS, looksLikeLogin, MAX_STEPS, MAIN_CHARS, addLearned, goalCheckRequest, readGoalCheck, MAX_GOAL_REFUSALS, newSince, addressChange, evidence } from "../dist/browse.js";
// Made-up passwords for the tests, built at runtime so secret scanners don't
// take them for real ones (GitGuardian did, 2026-10-15).
const FAKE_PW1 = ["fake", "pw", "1"].join("-");
const FAKE_PW2 = ["fake", "pw", "2"].join("-");
const FAKE_PW3 = ["fake", "pw", "3"].join("-");
const FAKE_PW4 = ["fake", "pw", "4"].join("-");
import { McpClient } from "../dist/mcpClient.js";

/** The goal check's verdict, as the stand-in model gives it. */
const checked = (achieved, missing = "") => ({ output: [{ type: "function_call", name: "goal_check", arguments: JSON.stringify({ achieved, missing }) }], usage: { input_tokens: 120 } });

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
    assert.deepEqual(els.get("e13"), { ref: "e13", role: "link", name: "Next page", url: "/page2", pointer: true });
    assert.equal(els.get("e14").role, "button");
  });
  test("links and next-page buttons, yes", () => {
    assert.ok(ok("e3")); assert.ok(ok("e13")); assert.ok(ok("e15")); assert.ok(ok("e20"));
  });
  test("pay, unsubscribe, a javascript: link, a text box — never, in either language", () => {
    for (const ref of ["e14", "e16", "e17", "e18", "e19"]) assert.equal(ok(ref), false, ref);
    assert.match(clickAllowed(els.get("e14")).why, /action/);
  });
  test("a line single-quoted for its colon is read like any other (booking.com's guests picker)", () => {
    const e = parseSnapshot(`- generic [ref=f1e160] [cursor=pointer]:\n  - 'button "Number of travelers and rooms. Currently selected: 2 adults · 0 children · 1 room" [ref=f1e163]':\n    - generic [ref=f1e164]: 2 adults · 0 children · 1 room\n  - 'link "It''s here: now" [ref=f1e170]':\n    - /url: /x`);
    assert.equal(e.get("f1e163")?.role, "button");
    assert.equal(e.get("f1e163")?.name, "Number of travelers and rooms. Currently selected: 2 adults · 0 children · 1 room");
    assert.equal(e.get("f1e170")?.name, "It's here: now");
    assert.equal(e.get("f1e170")?.url, "/x");
  });
  test("refs after a navigation are frame-prefixed, and still read", () => {
    const later = parseSnapshot('- main [ref=f1e2]:\n  - link "Two" [ref=f1e3] [cursor=pointer]:\n    - /url: /x');
    assert.equal(later.get("f1e3")?.name, "Two");
  });
  test("a ref that is not on the page is refused, not guessed", () => {
    assert.equal(ok("e999"), false);
  });
});

describe("a goal that asks for something to be done", () => {
  // booking.com, 2026-10-14: "sign me in" was answered by the recipe of "am I
  // signed in?". Recipes only replay finding something out.
  test("doing vs finding out — what it says not to do aside", () => {
    for (const g of ["Open Booking.com and sign me in to my account", "Book a table for two at 19:00", "Trimite-i lui Andrei mesajul", "Conectează-mă pe OLX"]) assert.equal(wantsDone(g), true, g);
    for (const g of ["Check whether I am signed in to Booking.com. Do not search, book, change, or submit anything.", "what is my next trip; only read: do not book anything", "Pe OLX, verifică conversațiile. Doar citește: nu răspunde și nu modifica nimic.", "what's on my calendar tomorrow"]) assert.equal(wantsDone(g), false, g);
  });
});

describe("keeping the person in the loop", () => {
  // The owner, 2026-10-14: every 20 s or so, where we are and what's next.
  const els = parseSnapshot('- link "Superior Gourmethotel Yscla 27 Nov – 2 Dec" [ref=e5]\n- textbox "Full name" [ref=e6]');
  const page = { url: "https://secure.booking.com/mytrips.en-gb.html", title: "Your trips" };
  test("where, and the next step, in a line", () => {
    assert.equal(updateLine(page, "click", { ref: "e5" }, els, false), 'On secure.booking.com — Your trips. Next: clicking "Superior Gourmethotel Yscla 27 Nov – 2 Dec".');
    assert.equal(updateLine(page, "click", { ref: "e5" }, els, true), 'Pe secure.booking.com — Your trips. Urmează: apăs pe „Superior Gourmethotel Yscla 27 Nov – 2 Dec”.');
    assert.equal(updateLine(page, "navigate", { url: "https://www.olx.ro/myaccount/" }, els, false), "On secure.booking.com — Your trips. Next: opening olx.ro.");
  });
  test("never what's typed — only which field; nothing before an answer or a question", () => {
    const line = updateLine(page, "type", { ref: "e6", text: "Ana Maria Popescu" }, els, false);
    assert.equal(line, 'On secure.booking.com — Your trips. Next: filling in "Full name".');
    assert.ok(!/Ana Maria/.test(line));
    for (const t of ["finish", "ask_user", "handoff"]) assert.equal(updateLine(page, t, {}, els, false), null, t);
  });
  test("about every 20 s while it works, not before", async () => {
    let t = 0, k = 0; const sent = [];
    await browse({ goal: "keep reading" }, {
      call: async () => ({ content: [{ type: "text", text: `- Page URL: https://example.com/${k++}\n- Page Title: Page ${k}\n### Snapshot\n\`\`\`yaml\n- main [ref=e1]\n\`\`\`` }] }),
      llm: async () => ({ output: [{ type: "function_call", name: "wait", arguments: '{"seconds":0}' }] }),
      sleep: async () => {}, now: () => (t += 1000), human: false,
      update: line => sent.push([t, line]),
    }).catch(() => {});
    assert.ok(sent.length >= 2, `${sent.length} updates`);
    assert.ok(sent[0][0] >= UPDATE_EVERY_MS, `first at ${sent[0][0]} ms`);
    for (let i = 1; i < sent.length; i++) assert.ok(sent[i][0] - sent[i - 1][0] >= UPDATE_EVERY_MS, "spaced");
    assert.match(sent[0][1], /^On example\.com — Page \d+\. Next: waiting for the page to load\.$/);
    for (let i = 1; i < sent.length; i++) assert.notEqual(sent[i][1], sent[i - 1][1], "the same line twice in a row");
  });
});

describe("following a new tab", () => {
  // OLX, 2026-10-13: seven tabs listed after a click — the job's and six
  // kept from earlier jobs — and the job went to the last (a calendar) and
  // closed its own. A new tab is one more than before.
  const listed = { content: [{ type: "text", text: "### Open tabs\n- 0: (current) [Inbox](https://www.olx.ro/myaccount/answers/)\n" +
    [1, 2, 3, 4, 5].map(i => `- ${i}: [Trip](https://secure.booking.com/confirmation.en-gb.html?n=${i})`).join("\n") + "\n- 6: [Calendar](https://calendar.google.com/calendar/u/0/r)" }] };
  test("the same tabs as before the click: nothing to follow", async () => {
    const calls = [];
    assert.equal(await followNewTab(listed, async (t, a) => { calls.push([t, a]); return { content: [] }; }, 7), false);
    assert.deepEqual(calls, []);
  });
  test("one more than before: the newest, and the old one closed", async () => {
    const calls = [];
    assert.equal(await followNewTab(listed, async (t, a) => { calls.push([t, a.action, a.index]); return { content: [] }; }, 6), true);
    assert.deepEqual(calls, [["browser_tabs", "select", 6], ["browser_tabs", "close", 0]]);
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
    assert.deepEqual(text.match(/\[ref=[A-Za-z0-9_]+\]/g), ["[ref=e1]", "[ref=e2]"], "elements from one page only");
  });
});

describe("caps end in words, never in silence", () => {
  test("a model that never finishes is stopped at the step cap with a sentence", async () => {
    // The page changes every step, so this is the step cap and not the
    // stuck-on-one-page check (which ends a job much sooner).
    let t = 0, k = 0;
    const r = await browse({ goal: "loop forever" }, {
      call: async () => ({ content: [{ type: "text", text: `- Page URL: https://example.com/${k++}\n### Snapshot\n\`\`\`yaml\n- main [ref=e1]\n\`\`\`` }] }),
      llm: async () => ({ output: [{ type: "function_call", name: "wait", arguments: "{\"seconds\":0}" }], usage: { input_tokens: 100 } }),
      sleep: async () => {}, now: () => (t += 10),
    });
    // Made to answer once at the cap (it didn't): then the sentence.
    assert.equal(r.ok, false);
    assert.ok(r.steps >= MAX_STEPS && r.steps <= MAX_STEPS + 2, String(r.steps));
    assert.match(r.content, /stopped after/);
  });
  test("at the cap, the model answers with what it read — not a bare \"I stopped\" (Stubai, 2026-10-15)", async () => {
    let t = 0, k = 0, forced = null;
    const r = await browse({ goal: "what people say" }, {
      call: async () => ({ content: [{ type: "text", text: `- Page URL: https://example.com/${k++}\n### Snapshot\n\`\`\`yaml\n- main [ref=e1]\n\`\`\`` }] }),
      llm: async req => {
        if (req.tool_choice?.name === "finish") { forced = req.input[0].content[0].text; return { output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "Skiers say the glacier is open; I didn't get to Instagram." }) }] }; }
        return { output: [{ type: "function_call", name: "wait", arguments: "{\"seconds\":0}" }], usage: { input_tokens: 100 } };
      },
      sleep: async () => {}, now: () => (t += 10),
    });
    assert.match(forced, /reached the limit of 60 steps\. Answer now with what you've found/);
    assert.equal(r.content, "Skiers say the glacier is open; I didn't get to Instagram.");
  });
  test("Chrome that doesn't connect: tried twice, then a plain sentence — no model call", async () => {
    let tries = 0, modelCalls = 0;
    const r = await browse({ goal: "x", start_url: "https://example.com/" }, {
      call: async () => { tries++; return { isError: true, content: [{ type: "text", text: "### Error\nError: Playwright extension did not connect within 30s after opening the connect page." }] }; },
      llm: async () => { modelCalls++; return { output: [] }; }, sleep: async () => {},
    });
    assert.equal(r.ok, false);
    assert.match(r.content, /Chrome on the Mac didn't answer/);
    assert.equal(tries, 2);
    assert.equal(modelCalls, 0);
  });
  test("a browser connection that dies ends the job at once, not after forty model calls", async () => {
    let calls = 0, n = 0;
    const r = await browse({ goal: "x" }, {
      call: async (tool) => { if (++n > 2) throw new Error("the browser connection ended (null)"); return { content: [{ type: "text", text: "- Page URL: https://example.com/\n### Snapshot\n```yaml\n- main [ref=e1]\n```" }] }; },
      llm: async () => { calls++; return { output: [{ type: "function_call", name: "navigate", arguments: '{"url":"https://example.com/"}' }] }; },
      sleep: async () => {},
    });
    assert.match(r.content, /lost the connection/);
    assert.ok(calls <= 2, `${calls} model calls`);
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
  let server, port, mcp, dir, paid = false, consent = null;
  before(async () => {
    server = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/paid") { paid = true; res.end("<h1>Paid</h1>"); return; }
      // A consent banner over a dark backdrop that takes every click — OLX's,
      // in miniature — and a bare see-through layer with no way out at all.
      if (req.url === "/cookies/all") { consent = "all"; res.end("ok"); return; }
      if (req.url === "/cookies/necessary") { consent = "necessary"; res.end("ok"); return; }
      if (req.url === "/account") { res.end(`<title>Account</title><main><h1>Your account</h1><p>Ad 42: active</p></main>`); return; }
      if (req.url === "/covered") { res.end(`<title>Shop</title><main><h1>Shop</h1><a href="/account"><p>Your account</p></a></main>
        <div id=sdk><div style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10"></div>
        <div style="position:fixed;bottom:0;left:0;right:0;z-index:11;background:#fff">We use cookies.
        <button onclick="fetch('/cookies/all');document.getElementById('sdk').remove()">Accept all</button>
        <button onclick="fetch('/cookies/necessary');document.getElementById('sdk').remove()">Accept necessary</button></div></div>`); return; }
      if (req.url === "/glass") { res.end(`<title>Shop</title><main><h1>Shop</h1><a href="/account">Your account</a></main>
        <div style="position:fixed;inset:0;z-index:10"></div>`); return; }
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
      const refOf = name => text.match(new RegExp(`"${name}" \\[ref=([A-Za-z0-9_]+)\\]`))?.[1];
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
    // No way to ask in this job, so an action is refused rather than taken.
    assert.match(seen[1], /Not clicked: the person did not say yes to "Pay now"/);
    assert.match(seen[2], /Older bills/);
    assert.doesNotMatch(seen[2], /142,30/, "the previous page is not carried along");
  });

  // OLX, 2026-10-12: a consent backdrop took every click, the page never
  // changed, and the model clicked the same link until the job was stopped.
  const clickAccount = async start => {
    const seen = [], logs = [];
    const llm = async req => {
      if (req.tool_choice?.name === "goal_check") return checked(true);
      const text = req.input[0].content[0].text; seen.push(text);
      if (/Your account<|Ad 42/.test(text) && /\/account/.test(text.match(/URL: (.*)/)?.[1] ?? "")) return { output: [{ type: "function_call", name: "finish", arguments: '{"answer":"Ad 42 is active."}' }] };
      const ref = text.match(/- link[^\n]*\[ref=([A-Za-z0-9_]+)\][^\n]*\n(?:[^\n]*\n)?\s*- \/url: \/account/)?.[1];
      return { output: [{ type: "function_call", name: "click", arguments: JSON.stringify({ ref }) }] };
    };
    const r = await browse({ goal: "is my ad active?", start_url: `http://127.0.0.1:${port}${start}` },
      { call: (t, a) => mcp.call(t, a), llm, allowLoopback: true, log: l => logs.push(l), sleep: ms => new Promise(res => setTimeout(res, Math.min(ms, 300))) });
    return { r, seen, logs };
  };
  test("a banner covering the page is closed the privacy-preserving way, and the click goes through", async () => {
    consent = null;
    const { r, seen, logs } = await clickAccount("/covered");
    assert.equal(r.content, "Ad 42 is active.", logs.join("\n"));
    assert.equal(seen.length, 2, "one click, not a loop");
    assert.equal(consent, "necessary", "never \"Accept all\"");
    assert.match(seen[1], /Something covered the page; it was cleared \("Accept necessary"\)/);
  });
  test("a cover with no way out: the click is made from inside the page", async () => {
    const { r, seen, logs } = await clickAccount("/glass");
    assert.equal(r.content, "Ad 42 is active.", logs.join("\n"));
    assert.equal(seen.length, 2, "one click, not a loop");
    assert.ok(logs.some(l => /from inside the page/.test(l)), logs.join("\n"));
  });
});

// --- Phase 5 ----------------------------------------------------------------

describe("a sign-in page is the person's, decided in code", () => {
  test("by address or by a password field", () => {
    for (const u of ["https://www.olx.ro/myaccount/login/", "https://login.olx.ro/", "https://myppc.ro/autentificare", "https://accounts.example.com/signin?x=1", "https://x.ro/auth/sso"])
      assert.ok(looksLikeLogin({ url: u, snapshot: "" }), u);
    assert.ok(looksLikeLogin({ url: "https://x.ro/", snapshot: '- textbox "Parolă" [ref=e4]' }));
    for (const u of ["https://www.olx.ro/d/oferte/", "https://github.com/notifications", "https://blog.example.com/authentic-recipes"])
      assert.ok(!looksLikeLogin({ url: u, snapshot: '- textbox "Search" [ref=e1]' }), u);
  });
});

describe("acting, and asking first", () => {
  const els = parseSnapshot(SNAP);
  test("a button that pays is allowed only as an action needing a yes; a field is not clickable", () => {
    assert.deepEqual(clickVerdict(els.get("e14")), { ok: true, action: true });
    assert.deepEqual(clickVerdict(els.get("e15")), { ok: true, action: false });
    assert.equal(clickVerdict(els.get("e18")).ok, false);
    assert.equal(clickVerdict(els.get("e17")).ok, false, "javascript: link");
  });
  test("a long link is where it goes, not a verb; a button or a short label is judged by any word", () => {
    assert.equal(looksLikeAction("Superior Gourmethotel Yscla 27 Nov – 2 Dec · Ischgl · Non-refundable Confirmed € 2,372.14"), false);
    assert.equal(looksLikeAction("Hotel Yscla · Ischgl · 27 nov – 2 dec · Confirmată · Plătită 2.372 €"), false);
    // A record that opens with the word stays asked about: "Order #4411 …" can't be told from "Order now …".
    assert.equal(looksLikeAction("Comanda #4411 din 3 octombrie · Livrată · Plătită 230 lei"), true);
    for (const n of ["Confirm booking", "Book now", "Pay", "Plătește acum", "Unsubscribe", "Cancel subscription"]) assert.equal(looksLikeAction(n), true, n);
    assert.equal(looksLikeAction("Pay € 2,372.14 now with the card ending 1234"), true, "first words");
    assert.equal(looksLikeAction("I agree to the terms and confirm my booking", "button"), true, "a button, any word");
  });
  test("a combobox is clicked to open it; a text box is typed into", () => {
    const e = parseSnapshot('- combobox "2 adults · 0 children · 1 room" [ref=e1]\n- textbox "Where are you going?" [ref=e2]');
    assert.deepEqual(clickVerdict(e.get("e1")), { ok: true, action: false });
    assert.equal(clickVerdict(e.get("e2")).ok, false);
  });
  test("a status isn't an action: confirmed, paid, \"De cumpărat\"; the verbs still are", () => {
    for (const n of ["De cumpărat", "De vândut", "Confirmed", "Plătită", "Booked"]) assert.equal(looksLikeAction(n, "button"), false, n);
    for (const n of ["Cumpără acum", "Confirmă", "Trimite", "Șterge anunțul", "Plătește", "Book", "Log out", "Rezervă"]) assert.equal(looksLikeAction(n, "button"), true, n);
    assert.equal(looksLikeAction("Plătește", "tab"), false, "a tab shows something else");
  });
  test("what the person writes back is read as a number and the rest", () => {
    assert.deepEqual(readPointing("3"), { n: 3, text: "" });
    assert.deepEqual(readPointing("3 Bogdan"), { n: 3, text: "Bogdan" });
    assert.deepEqual(readPointing("#12: Ana Maria"), { n: 12, text: "Ana Maria" });
    assert.equal(readPointing("the blue one"), null);
    assert.ok(isYes("yes")); assert.ok(isYes("Da, sigur")); assert.ok(isYes("ok go ahead"));
    assert.ok(!isYes("no")); assert.ok(!isYes("nu")); assert.ok(!isYes("wait, which one?"));
  });
  test("the overlay script carries numbers and coordinates, nothing from the page", () => {
    const boxed = '- main [ref=e1] [box=0,0,800,600]:\n  - button "</script><img src=x onerror=alert(1)>" [ref=e2] [box=10,20,100,30]';
    const script = overlayScript(labels(boxed));
    assert.doesNotMatch(script, /onerror|img src/);
    assert.match(script, /\[\[1,10,20,100,30\]\]/);
  });
});

const PAGES = {
  "/slots": `<title>Book</title><main><h1>Table for two</h1><p>Pick a time</p>
    <button onclick="pick('18:00')">18:00</button> <button onclick="pick('19:00')">19:00</button> <button onclick="pick('20:00')">20:00</button>
    <p id=chosen>none</p><button onclick="location='/confirm?t='+document.getElementById('chosen').textContent">Confirm booking</button>
    <script>function pick(t){document.getElementById('chosen').textContent=t}</script></main>`,
  // Not "/login": a sign-in address is now handed to the person before the
  // model acts, and this page exists to prove the type refusal on its own.
  "/verify": `<title>Sign in</title><main><h1>Sign in</h1><form onsubmit="return false"><label>Email <input type=email></label>
    <label>Code <input type=password></label><button>Sign in</button></form><a href="/help">Help</a></main>`,
  // Clickable things that are no link or button: cards a script listens to,
  // an icon with only a label, and one that pays — and a real link, which
  // the snapshot already has and clickables must leave out.
  "/cards": `<title>Listings</title><main><h1>Listings</h1>
    <div class=card style="cursor:pointer;padding:8px" onclick="location='/card/1'"><span>Apartment 1</span> <small>2 rooms</small></div>
    <div class=card style="cursor:pointer;padding:8px" onclick="location='/card/2'"><span>Apartment 2</span> <small>3 rooms</small></div>
    <div id=fav aria-label="Favourites" style="cursor:pointer;width:24px;height:24px;background:#c00"></div>
    <div style="cursor:pointer;padding:8px" onclick="location='/paid-card'">Pay 50 lei</div>
    <script>document.getElementById('fav').addEventListener('click', () => location = '/favourites')</script>
    <a href="/help">Help</a></main>`,
  "/list": `<title>Results</title><main><h1>Results</h1><ul>${[1,2,3,4,5,6].map(i => `<li><a href="/r${i}">Result ${i}</a> <button>Save ${i}</button></li>`).join("")}</ul>
    <label>Search <input type=search></label><select><option>Newest</option><option>Oldest</option></select></main>`,
};

describe("the loop acting in a real browser", chrome ? {} : { skip: "needs Google Chrome installed" }, () => {
  let server, port, mcp, dir, hits = [];
  before(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url);
      res.setHeader("content-type", "text/html");
      res.end(PAGES[req.url.split("?")[0]] || `<title>${req.url}</title><main><h1>${req.url}</h1></main>`);
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gep-act-"));
    const cli = path.join(path.dirname(createRequire(import.meta.url).resolve("@playwright/mcp/package.json")), "cli.js");
    mcp = new McpClient(process.execPath, [cli, "--browser", "chrome", "--headless", "--isolated", "--caps=vision,network,storage"], { cwd: dir });
    await mcp.start();
  });
  after(() => { mcp?.close(); server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (t, a) => mcp.call(t, a);
  const fast = ms => new Promise(r => setTimeout(r, Math.min(ms, 30)));
  const evalOut = r => JSON.parse(r.content.map(c => c.text || "").join("\n").match(/### Result\n([\s\S]*?)(\n###|$)/)[1]);

  for (const p of ["/slots", "/verify", "/list"]) {
    test(`numbers sit on the elements they map to — ${p}`, async () => {
      await call("browser_navigate", { url: `http://127.0.0.1:${port}${p}` });
      const snap = (await call("browser_snapshot", { boxes: true })).content.map(c => c.text).join("\n").match(/\`\`\`yaml\n([\s\S]*?)\`\`\`/)[1];
      const items = labels(snap);
      assert.ok(items.length >= 3, `${items.length} labels`);
      const drawn = evalOut(await call("browser_evaluate", { function: overlayScript(items) }));
      // What is actually under the middle of each numbered box, by the page's own hit test.
      const under = evalOut(await call("browser_evaluate", { function: `() => [...document.querySelectorAll('.__gepetel_label')].filter(d => !d.textContent).map(d => { const r = d.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return (el.getAttribute('aria-label') || el.innerText || el.value || el.type || '').trim().slice(0, 40); })` }));
      await call("browser_evaluate", { function: "() => { document.querySelectorAll('.__gepetel_label').forEach(e => e.remove()); return true; }" });
      const mapped = items.filter(([n]) => drawn.includes(n)).map(([, el]) => el);
      assert.equal(under.length, mapped.length);
      mapped.forEach((el, i) => {
        if (el.name && el.role !== "textbox" && el.role !== "searchbox" && el.role !== "combobox") assert.ok(under[i].includes(el.name) || el.name.includes(under[i]), `label ${i + 1}: mapped to "${el.name}", under it "${under[i]}"`);
      });
    });
  }

  const script = steps => {
    let turn = 0; const seen = [];
    return { seen, llm: async req => {
      if (req.tool_choice?.name === "goal_check") return checked(true);
      const text = req.input[0].content[0].text; seen.push(text);
      const ref = name => text.match(new RegExp(`"${name}" \\[ref=([A-Za-z0-9_]+)\\]`))?.[1];
      const s = steps[Math.min(turn++, steps.length - 1)](text, ref);
      return { output: [{ type: "function_call", name: s[0], arguments: JSON.stringify(s[1]) }], usage: { input_tokens: 300 } };
    } };
  };

  test("a yes to pressing something holds for the job: pressed again, it isn't asked again", async () => {
    hits = [];
    const asked = [];
    const { llm } = script([
      (t, ref) => ["click", { ref: ref("19:00") }],
      (t, ref) => ["click", { ref: ref("Confirm booking") }],
      () => ["back", {}],
      (t, ref) => ["click", { ref: ref("19:00") }],
      (t, ref) => ["click", { ref: ref("Confirm booking") }],
      () => ["finish", { answer: "done" }],
    ]);
    await browse({ goal: "book 19:00", start_url: `http://127.0.0.1:${port}/slots` },
      { call, llm, allowLoopback: true, sleep: fast, ask: async q => { asked.push(q); return "da"; } });
    assert.equal(asked.length, 1, JSON.stringify(asked));
    assert.equal(hits.filter(h => h.startsWith("/confirm")).length, 2, JSON.stringify(hits));
  });

  for (const answer of ["no", "yes"]) {
    test(`booking: the slot is picked, and "Confirm booking" waits for a yes — answered "${answer}"`, async () => {
      hits = [];
      const asked = [];
      const { llm, seen } = script([
        (t, ref) => ["click", { ref: ref("19:00") }],
        (t, ref) => ["click", { ref: ref("Confirm booking") }],
        t => ["finish", { answer: /\/confirm/.test(t) ? "Booked for 19:00." : "Not booked." }],
      ]);
      const r = await browse({ goal: "book 19:00", start_url: `http://127.0.0.1:${port}/slots`, may_submit: true },
        { call, llm, allowLoopback: true, sleep: fast, ask: async q => { asked.push(q); return answer; } });
      assert.equal(asked.length, 1, JSON.stringify(asked));
      assert.match(asked[0], /press "Confirm booking"/);
      if (answer === "no") {
        assert.ok(!hits.some(h => h.startsWith("/confirm")), "booked without a yes");
        assert.match(seen[2], /did not say yes/);
        assert.equal(r.content, "Not booked.");
      } else {
        assert.ok(hits.includes("/confirm?t=19:00"), JSON.stringify(hits));
        assert.equal(r.content, "Booked for 19:00.");
      }
    });
  }

  test("login: a password field is never typed into, even labelled \"Code\"; the person is handed the step", async () => {
    const asked = [];
    const { llm, seen } = script([
      (t, ref) => ["type", { ref: ref("Code"), text: "hunter2" }],
      () => ["handoff", { reason: "Please sign in." }],
      () => ["finish", { answer: "Signed in." }],
    ]);
    const r = await browse({ goal: "sign in", start_url: `http://127.0.0.1:${port}/verify` },
      { call, llm, allowLoopback: true, sleep: fast, ask: async (q, img) => { asked.push({ q, img: !!img?.b64 }); return "done"; } });
    assert.match(seen[1], /Not typed: that is a password or payment field/);
    if (process.env.SHOW) console.log(JSON.stringify(asked));
    assert.equal(asked.length, 1);
    assert.match(asked[0].q, /Please sign in\.[\s\S]*reply "done"/);
    assert.ok(asked[0].img, "the handoff carries a numbered screenshot");
    assert.equal(r.content, "Signed in.");
  });

  test("a link that opens a new tab is followed there, and the old tab closed — not clicked again", async () => {
    PAGES["/newtab"] = `<title>Home</title><main><a href="/bill-tab" target="_blank">Facturi</a></main>`;
    PAGES["/bill-tab"] = `<title>Bill</title><main><p>Total de plată: 142,30 lei</p></main>`;
    const { llm, seen } = script([
      (t, ref) => ["click", { ref: ref("Facturi") }],
      t => ["finish", { answer: /142,30 lei/.test(t) ? "142,30 lei" : "not found" }],
    ]);
    const r = await browse({ goal: "bill", start_url: `http://127.0.0.1:${port}/newtab` },
      { call, llm, allowLoopback: true, sleep: fast });
    assert.equal(r.content, "142,30 lei", seen.join("\n---\n").slice(-600));
    assert.match(seen[1], /opened a new tab/);
    const tabs = parseTabs((await call("browser_tabs", { action: "list" })).content.map(c => c.text).join("\n"));
    assert.equal(tabs.length, 1, JSON.stringify(tabs));
  });

  test("at the end, every tab the job had is closed", async () => {
    await call("browser_tabs", { action: "new", url: `http://127.0.0.1:${port}/list` }).catch(() => {});
    const closed = await closeAllTabs(call);
    assert.ok(closed >= 1, `closed ${closed}`);
  });

  test("a sign-in page is handed over before the model is asked anything", async () => {
    PAGES["/account/login"] = `<title>Sign in</title><main><h1>Sign in</h1><label>Email <input type=email></label><label>Parola <input type=password></label></main>`;
    let modelCalls = 0, before = -1;
    const asked = [];
    const llm = async () => { modelCalls++; return { output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "ok" }) }] }; };
    await browse({ goal: "my listings", start_url: `http://127.0.0.1:${port}/account/login` },
      { call, llm, allowLoopback: true, sleep: fast, ask: async (q, img, o) => { if (before < 0) before = modelCalls; asked.push({ q, takeover: !!o?.takeover, img: !!img }); return "done"; } });
    assert.equal(before, 0, "the model was asked before the person");
    assert.match(asked[0].q, /sign in on 127\.0\.0\.1/);
    assert.ok(asked[0].takeover && asked[0].img, "with the takeover link and a picture");
    assert.equal(asked.length, 1, "once per site");
  });

  test("\"not signed in\" is no answer: the job opens the page's own Sign in, hands it over, and carries on", async () => {
    PAGES["/so-home"] = `<title>Stays</title><main><h1>Stays</h1><a href="/so/login">Sign in</a> <a href="/register">Register</a></main>`;
    PAGES["/so-in"] = `<title>Stays</title><main><h1>Stays</h1><p>Signed in as Bogdan</p></main>`;
    PAGES["/so/login"] = `<title>Sign in</title><main><h1>Sign in</h1><label>Email <input type=email></label><label>Password <input type=password></label></main>`;
    const asked = [], told = [];
    let i = 0;
    const llm = async req => {
      told.push(req.input[0].content[0].text);
      const answer = i++ === 0 ? "You are not signed in to the site — the page shows Sign in and Register." : "Searched, signed in: 3 stays.";
      return { output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer }) }] };
    };
    hits = [];
    const r = await browse({ goal: "on my account, search stays", start_url: `http://127.0.0.1:${port}/so-home` },
      { call, llm, allowLoopback: true, sleep: fast, human: false, log: l => process.env.SHOW_LOGS && console.log(l), ask: async (q, img, o) => {
        asked.push({ q, takeover: !!o?.takeover });
        // The person signs in from their phone: the site sends them back, signed in.
        await call("browser_navigate", { url: `http://127.0.0.1:${port}/so-in` });
        return "done";
      } });
    assert.equal(asked.length, 1, JSON.stringify(asked));
    assert.match(asked[0].q, /sign in on 127\.0\.0\.1/);
    assert.ok(asked[0].takeover, "with the takeover link");
    assert.equal(r.content, "Searched, signed in: 3 stays.", "the job carried on to the goal");
  });

  test("asked to sign out, being signed out is the answer — no sign-in handed over", async () => {
    PAGES["/so2-home"] = `<title>Stays</title><main><h1>Stays</h1><a href="/so/login">Sign in</a></main>`;
    const asked = [];
    const llm = async () => ({ output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "Signed out successfully — you are not signed in any more." }) }] });
    const r = await browse({ goal: "Sign out of my account on the site.", asked: "now sign out of google and tripit on my computer", start_url: `http://127.0.0.1:${port}/so2-home` },
      { call, llm, allowLoopback: true, sleep: fast, human: false, ask: async q => { asked.push(q); return "done"; } });
    assert.equal(asked.length, 0, JSON.stringify(asked));
    assert.match(r.content, /Signed out successfully/);
  });

  test("a model looping on one page is told, then made to answer — never the person asked", async () => {
    const asked = [], told = [], choices = [];
    let modelCalls = 0;
    const llm = async req => { modelCalls++; told.push(req.input[0].content[0].text); choices.push(req.tool_choice); return { output: [{ type: "function_call", name: "wait", arguments: '{"seconds":0}' }] }; };
    const r = await browse({ goal: "x", start_url: `http://127.0.0.1:${port}/list` },
      { call, llm, allowLoopback: true, sleep: async () => {}, ask: async q => { asked.push(q); return "done"; } });
    assert.equal(asked.length, 0, JSON.stringify(asked));
    assert.ok(told.some(t => /That is a loop/.test(t)), "the model is told first");
    assert.ok(choices.some(c => c?.name === "finish"), "then it must answer");
    assert.equal(r.ok, false);
    assert.match(r.content, /circles/);
    assert.ok(modelCalls < 12, `${modelCalls} model calls`);
  });

  test("a second loop on the same page, however many steps later, is the same loop: it must answer (CreepJS)", async () => {
    const choices = [], told = [];
    let i = 0;
    // Waits (the page stays the same), then a run of searches, then waits again.
    const llm = async req => {
      told.push(req.input[0].content[0].text); choices.push(req.tool_choice); i++;
      if (req.tool_choice?.name === "finish") return { output: [{ type: "function_call", name: "finish", arguments: '{"answer":"not on the page"}' }] };
      const find = i > 6 && i <= 12;
      return { output: [{ type: "function_call", name: find ? "find" : "wait", arguments: find ? JSON.stringify({ text: `thing ${i}` }) : '{"seconds":0}' }] };
    };
    const r = await browse({ goal: "the trust score", start_url: `http://127.0.0.1:${port}/list` }, { call, llm, allowLoopback: true, sleep: async () => {} });
    assert.equal(told.filter(t => /That is a loop/.test(t)).length, 1, "told once");
    assert.ok(choices.some(c => c?.name === "finish"), "then made to answer");
    assert.ok(i < 22, `${i} model calls`);
    assert.match(r.content, /not on the page/);
  });

  test("fully open: JavaScript, the network log, cookies and storage reach the model with their values", async () => {
    PAGES["/api/bills.json"] = JSON.stringify({ bills: [{ month: "Sept", total: "142,30" }] });
    PAGES["/open"] = `<title>Open</title><main><table id=t><tr><td>10</td></tr><tr><td>32</td></tr></table>
      <script>document.cookie = "session_hint=abc123; path=/"; localStorage.setItem("account", "ACC-77");
      fetch("/api/bills.json").then(r => r.text());</script></main>`;
    const { llm, seen } = script([
      () => ["network", {}],
      t => ["network", { index: Number(t.match(/\[(\d+)\][^\n]*api\/bills\.json/)?.[1] ?? t.match(/(\d+)[^\n]*api\/bills\.json/)?.[1] ?? 0), part: "response-body" }],
      () => ["cookies", {}],
      () => ["storage", { kind: "local", key: "account" }],
      () => ["run_js", { code: "() => [...document.querySelectorAll('#t td')].reduce((s, td) => s + Number(td.textContent), 0)" }],
      () => ["finish", { answer: "done" }],
    ]);
    await browse({ goal: "read everything", start_url: `http://127.0.0.1:${port}/open` }, { call, llm, allowLoopback: true, sleep: fast });
    assert.match(seen[1], /api\/bills\.json/, "the API call is in the network list");
    assert.match(seen[2], /142,30/, "its response body reaches the model");
    assert.match(seen[3], /session_hint[\s\S]*abc123/, "cookie values reach the model");
    assert.match(seen[4], /ACC-77/, "localStorage values reach the model");
    assert.match(seen[5], /Result:\s*\n?\s*42/, "a script's result reaches the model");
  });

  test("run_js only takes a function — not a bare statement", async () => {
    const { llm, seen } = script([() => ["run_js", { code: "document.title" }], () => ["finish", { answer: "x" }]]);
    await browse({ goal: "x", start_url: `http://127.0.0.1:${port}/list` }, { call, llm, allowLoopback: true, sleep: fast });
    assert.match(seen[1], /needs a function/);
  });

  test("the same element clicked again and again on a page that keeps changing is a loop (OLX's \"Chat\")", async () => {
    PAGES["/redraw"] = `<title>Inbox</title><main><h1 id=t>Inbox 0</h1><button onclick="t.textContent = 'Inbox ' + (++window.n || (window.n = 1))">Chat</button></main>`;
    const told = [];
    const llm = async req => {
      const t = req.input[0].content[0].text; told.push(t);
      // [active] sits before the ref once it has been clicked.
      const ref = t.match(/button "Chat"[^\n]*\[ref=([A-Za-z0-9_]+)\]/)?.[1];
      return { output: [{ type: "function_call", name: "click", arguments: JSON.stringify({ ref }) }] };
    };
    const r = await browse({ goal: "read my messages", start_url: `http://127.0.0.1:${port}/redraw` }, { call, llm, allowLoopback: true, sleep: fast, human: false });
    assert.ok(told.some(t => /clicked button \W*Chat\W* 3 times/.test(t)), "never told: " + told.map(t => t.match(/[^\n]*loop[^\n]*/i)?.[0]).filter(Boolean).join(" | "));
    assert.match(r.content, /circles/);
    assert.ok(told.length <= 10, `${told.length} model calls`);
  });

  test("what the person adds while the work runs reaches the model, and the goal", async () => {
    const seen = []; let added = ["for 4 guests"];
    const llm = async req => {
      const t = req.input[0].content[0].text; seen.push(t);
      return { output: [{ type: "function_call", name: seen.length < 2 ? "whole_page" : "finish", arguments: '{"answer":"ok"}' }] };
    };
    await browse({ goal: "search stays in Madonna di Campiglio", start_url: `http://127.0.0.1:${port}/list` },
      { call, llm, allowLoopback: true, sleep: fast, human: false, added: () => { const a = added; added = []; return a; } });
    assert.match(seen[0], /They added: for 4 guests/, "in the goal");
    assert.match(seen[0], /The person just added: "for 4 guests"/, "told as news");
    assert.match(seen[1], /They added: for 4 guests/, "and kept in the goal after");
    assert.ok(!/The person just added/.test(seen[1]), "told once");
  });

  test("no guessed addresses: a link on the page or the front page, yes; a made-up path, no", async () => {
    PAGES["/guess-home"] = `<title>Home</title><main><h1>Home</h1><a href="/account">Account</a></main>`;
    PAGES["/account"] = `<title>Account</title><main><h1>Your account</h1></main>`;
    const told = []; const opened = [];
    const steps = [
      () => ["navigate", { url: `http://127.0.0.1:${port}/signin.html` }],
      () => ["navigate", { url: `http://127.0.0.1:${port}/account` }],
      () => ["finish", { answer: "done" }],
    ];
    let i = 0;
    const llm = async req => { told.push(req.input[0].content[0].text); const [name, args] = steps[Math.min(i++, steps.length - 1)](); return { output: [{ type: "function_call", name, arguments: JSON.stringify(args) }] }; };
    hits = [];
    await browse({ goal: "open my account", start_url: `http://127.0.0.1:${port}/guess-home` }, { call, llm, allowLoopback: true, sleep: fast, human: false });
    assert.ok(!hits.includes("/signin.html"), "the guess was opened");
    assert.match(told[1], /is a guess/);
    assert.ok(hits.includes("/account"), "the page's own link was");
  });

  test("an address in a part of the site it has been in is no guess: /search/posts after /search/top", async () => {
    PAGES["/search/top"] = `<title>Search</title><main><h1>Top results</h1></main>`;
    PAGES["/search/posts"] = `<title>Posts</title><main><h1>Posts</h1></main>`;
    const told = [];
    const steps = [() => ["navigate", { url: `http://127.0.0.1:${port}/search/posts?q=ski` }], () => ["finish", { answer: "done" }]];
    let i = 0;
    const llm = async req => { told.push(req.input[0].content[0].text); const [name, args] = steps[Math.min(i++, 1)](); return { output: [{ type: "function_call", name, arguments: JSON.stringify(args) }] }; };
    hits = [];
    await browse({ goal: "posts about ski", start_url: `http://127.0.0.1:${port}/search/top?q=ski` }, { call, llm, allowLoopback: true, sleep: fast, human: false });
    assert.ok(hits.some(h => h.startsWith("/search/posts")), JSON.stringify(hits));
    assert.ok(!/is a guess/.test(told[1] || ""));
  });

  test("search after search on one site, each worded differently, is a loop: told, then made to answer", async () => {
    PAGES["/s"] = `<title>Search</title><main><form onsubmit="event.preventDefault(); document.getElementById('r').textContent = 'Results for ' + document.getElementById('q').value + ' ' + Math.random()"><label>Search <input id=q type=search></label></form><p id=r></p></main>`;
    const told = [], choices = [];
    let i = 0;
    const llm = async req => {
      const t = req.input[0].content[0].text; told.push(t); choices.push(req.tool_choice); i++;
      if (req.tool_choice?.name === "finish") return { output: [{ type: "function_call", name: "finish", arguments: '{"answer":"what I found"}' }] };
      const ref = t.match(/searchbox "Search" (?:\[\w+\] )*\[ref=([A-Za-z0-9_]+)\]/)?.[1];
      return { output: [{ type: "function_call", name: "type", arguments: JSON.stringify({ ref, text: `glacier ${i}`, submit: true }) }] };
    };
    const r = await browse({ goal: "what people say", start_url: `http://127.0.0.1:${port}/s` }, { call, llm, allowLoopback: true, sleep: fast, human: false });
    assert.ok(told.some(t => /search number 4/.test(t)), "told at the fourth");
    assert.ok(choices.some(c => c?.name === "finish"), "made to answer");
    assert.equal(r.content, "what I found");
    assert.ok(i <= 8, `${i} model calls`);
  });

  test("a sign-in link is no answer: the person is away — refused once, with why", async () => {
    PAGES["/signed-out"] = `<title>Home</title><main><h1>Home</h1><a href="/account/sign-in">Sign in</a></main>`;
    const told = [];
    const answers = [
      "You are not signed in. Please sign in here: https://account.example.com/auth/oauth2?client_id=x&prompt=signin",
      "Not signed in; I stopped.",
    ];
    let i = 0;
    const llm = async req => { told.push(req.input[0].content[0].text); return { output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: answers[Math.min(i++, 1)] }) }] }; };
    const r = await browse({ goal: "check I'm signed in, then search", start_url: `http://127.0.0.1:${port}/signed-out` }, { call, llm, allowLoopback: true, sleep: fast, human: false });
    assert.match(told[1], /sign-in link is no use to them/);
    assert.match(told[1], /handoff/);
    assert.equal(r.content, "Not signed in; I stopped.", "a second finish is let through: never a loop over it");
  });

  test("what a click opened is shown first; a search repeated is settled; the journal tells the whole story", async () => {
    PAGES["/sortable"] = `<title>Results</title><main><h1>139 properties found</h1>
      <button id=s onclick="document.getElementById('menu').hidden=false">Sort by: Top picks</button>
      <ul id=menu role=listbox hidden><li role=option>Top picks</li><li role=option>Price (lowest first)</li><li role=option>Price (highest first)</li></ul>
      <p>Signed in as Bogdan</p></main>`;
    const told = [], journal = [];
    let i = 0;
    const llm = async req => {
      const t = req.input[0].content[0].text; told.push(t);
      const ref = name => t.match(new RegExp(`button "${name}" \\[ref=([A-Za-z0-9_]+)\\]`))?.[1];
      const step = i++;
      if (step === 0) return { output: [{ type: "function_call", name: "click", arguments: JSON.stringify({ ref: ref("Sort by: Top picks") }) }] };
      if (step === 1 || step === 2) return { output: [{ type: "function_call", name: "find", arguments: JSON.stringify({ text: "Signed in" }) }] };
      if (step === 3) return { output: [{ type: "function_call", name: "note_goal", arguments: JSON.stringify({ learned: "signed in as Bogdan" }) }] };
      return { output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "sorted" }) }] };
    };
    await browse({ goal: "the cheapest stay", start_url: `http://127.0.0.1:${port}/sortable`, asked: "find me the cheapest place" },
      { call, llm, allowLoopback: true, sleep: fast, human: false, journal: l => journal.push(l) });
    assert.match(told[1], /New on this page since your last step[^]*option "Price \(lowest first\)"/, "the options the click opened, up front");
    assert.ok(!/New on this page/.test(told[0]), "nothing new on the first look");
    assert.match(told[3], /already looked for "Signed in"/, "the second search of the same thing is settled");
    const all = journal.join("\n");
    for (const want of [/journal their words: find me the cheapest place/, /journal goal passed on: the cheapest stay/, /journal step 2: click /, /journal new on the page: .*Price \(lowest first\)/, /journal learned: signed in as Bogdan/, /journal answer: sorted/])
      assert.match(all, want);
  });

  test("addressChange: what a reload changed — no tracking codes", () => {
    const a = "https://www.booking.com/searchresults.en-gb.html?ss=Neustift&label=gen173nr-xyz&aid=304142&group_adults=4";
    assert.equal(addressChange(a, a + "&order=price"), "order=price");
    assert.equal(addressChange(a, a.replace("label=gen173nr-xyz", "label=other")), "", "a tracking code isn't a change");
    assert.equal(addressChange(a + "&order=price", a), "order gone");
  });

  test("evidence: the page's lines with what the answer names — its own text before a partial snapshot", () => {
    const answer = "Cheapest: Apartment in Neustift near Ski Lift — US$745 for 1 week.";
    const text = "Neustift im Stubaital: 139 properties found\nSort by: Price (lowest first)\nApartment in Neustift near Ski Lift\n1 week, 4 adults\nUS$745\nSchönherr Haus\nUS$2,882";
    const got = evidence("- combobox \"Enter destination\": Neustift im Stubaital", answer, text);
    assert.match(got, /Apartment in Neustift near Ski Lift/);
    assert.match(got, /US\$745/);
    assert.ok(!/US\$2,882/.test(got), got);
  });

  test("newSince: only what appeared, without refs changing everything; nothing on a different page", () => {
    const before = `- button "Sort by" [ref=e1]\n- heading "139 found" [level=1] [ref=e2]`;
    const after = `- button "Sort by" [expanded] [ref=e7]\n- heading "139 found" [level=1] [ref=e8]\n- listbox [ref=e9]:\n  - option "Price (lowest first)" [ref=e10]`;
    const got = newSince(before, after);
    assert.match(got, /option "Price \(lowest first\)" \[ref=e10\]/);
    assert.ok(!/Sort by|139 found/.test(got), got);
    assert.equal(newSince(before, before.replace(/e1/g, "e5")), "", "new refs alone aren't new");
    assert.equal(newSince("", Array.from({ length: 200 }, (_, k) => `- link "L${k}" [ref=e${k}]`).join("\n")), "", "a whole new page isn't 'new on this page'");
  });

  test("site notes: shown for the page's site, kept by remember, refused when personal", async () => {
    PAGES["/notes-home"] = `<title>Shop</title><main><h1>Shop</h1></main>`;
    const { SiteNotes } = await import("../dist/siteNotes.js");
    const notes = new SiteNotes(null);
    notes.add("127.0.0.1", "The sort is under Sort by.", "job");
    const told = [];
    const plan = [["remember", { note: "Results load a second after the search." }], ["remember", { note: "Ana's phone is 0722 123 456" }], ["finish", { answer: "ok" }]];
    let i = 0;
    const llm = async req => { told.push(req.input[0].content[0].text); const [name, a] = plan[Math.min(i++, 2)]; return { output: [{ type: "function_call", name, arguments: JSON.stringify(a) }] }; };
    await browse({ goal: "look", start_url: `http://127.0.0.1:${port}/notes-home` }, { call, llm, allowLoopback: true, sleep: fast, human: false, notes });
    assert.match(told[0], /What you know about 127\.0\.0\.1[^]*The sort is under Sort by/);
    assert.ok(notes.forSite("127.0.0.1").some(n => /Results load a second/.test(n.text)), "kept");
    assert.ok(!notes.forSite("127.0.0.1").some(n => /0722/.test(n.text)), "a phone number is never a site note");
    assert.match(told[2], /Not kept: it has a long number/);
  });

  test("the person's usual way in: a note says Google, so Google is pressed — not handed over", async () => {
    PAGES["/usual/login"] = `<title>Sign in</title><main><h1>Sign in</h1><label>Email <input type=email></label><label>Password <input type=password></label><a href="/usual/google">Continue with Google</a></main>`;
    PAGES["/usual/google"] = `<title>Signed in</title><main><h1>Welcome back</h1></main>`;
    const { SiteNotes } = await import("../dist/siteNotes.js");
    const notes = new SiteNotes(null);
    notes.add("127.0.0.1", "The person signs in here with Google.", "person");
    const asked = [];
    const llm = async () => ({ output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "signed in" }) }] });
    hits = [];
    await browse({ goal: "my orders", start_url: `http://127.0.0.1:${port}/usual/login` },
      { call, llm, allowLoopback: true, sleep: fast, human: false, notes, ask: async q => { asked.push(q); return "done"; } });
    assert.ok(hits.includes("/usual/google"), "Google was pressed");
    assert.equal(asked.length, 0, "nobody was asked: " + JSON.stringify(asked));
  });

  test("how the person signed in is learned from the hand-off: Google's sign-in seen → a note", async () => {
    PAGES["/learn/login"] = `<title>Sign in</title><main><h1>Sign in</h1><label>Password <input type=password></label></main>`;
    PAGES["/learn/in"] = `<title>Home</title><main><h1>Hi</h1></main>`;
    const { SiteNotes } = await import("../dist/siteNotes.js");
    const notes = new SiteNotes(null);
    const llm = async () => ({ output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "done" }) }] });
    await browse({ goal: "my orders", start_url: `http://127.0.0.1:${port}/learn/login` },
      { call, llm, allowLoopback: true, sleep: fast, human: false, notes, handoffHosts: () => ["127.0.0.1", "accounts.google.com"],
        ask: async () => { await call("browser_navigate", { url: `http://127.0.0.1:${port}/learn/in` }); return "done"; } });
    assert.ok(notes.forSite("127.0.0.1").some(n => n.text === "The person signs in here with Google."), JSON.stringify(notes.all()));
  });

  test("people's details: the model types a placeholder, the Mac the value — never in a log; a submit asks, naming it", async () => {
    PAGES["/form"] = `<title>Form</title><main><form onsubmit="event.preventDefault(); document.title='sent'"><label>Passport number <input id=pp name=passport></label><button>Send</button></form></main>`;
    const told = [], logs = [], journal = [], asked = [];
    const plan = [
      t => ["type", { ref: t.match(/textbox "Passport number" (?:\[\w+\] )*\[ref=([A-Za-z0-9_]+)\]/)[1], text: "‹Ana: passport number›" }],
      t => ["type", { ref: t.match(/textbox "Passport number" (?:\[\w+\] )*\[ref=([A-Za-z0-9_]+)\]/)[1], text: "‹Ana: shoe size›" }],
      t => ["type", { ref: t.match(/textbox "Passport number" (?:\[\w+\] )*\[ref=([A-Za-z0-9_]+)\]/)[1], text: "‹Ana: passport number›", submit: true }],
      () => ["finish", { answer: "done" }],
    ];
    let i = 0;
    const llm = async req => { const t = req.input[0].content[0].text; told.push(t); if (process.env.SHOW) console.log("----", t); const [name, a] = plan[Math.min(i++, 3)](t); return { output: [{ type: "function_call", name, arguments: JSON.stringify(a) }] }; };
    const people = { list: async () => [{ name: "Ana", relation: "wife", labels: ["passport number", "date of birth"] }], value: async (who, label) => who === "Ana" && label === "passport number" ? "X1234567" : null };
    await browse({ goal: "fill in Ana's passport", start_url: `http://127.0.0.1:${port}/form` },
      { call, llm, allowLoopback: true, sleep: fast, human: false, people, log: l => logs.push(l), journal: l => journal.push(l), ask: async q => { asked.push(q); return "yes"; } });
    const value = await call("browser_evaluate", { function: "() => document.getElementById('pp').value" });
    assert.match(value.content.map(c => c.text).join(""), /X1234567/, "the field has the real value");
    assert.match(told[0], /Details you can type[^]*‹Ana: passport number›/);
    assert.ok(!told.some(t => /X1234567/.test(t)), "the model never sees the value");
    assert.ok(![...logs, ...journal].some(l => /X1234567/.test(l)), "no log or journal line has it");
    assert.match(told[2], /no such detail kept — ‹Ana: shoe size›/);
    assert.ok(asked.some(q => /With: ‹Ana: passport number›/.test(q)), JSON.stringify(asked));
  });

  test("a saved sign-in: typed by the Mac, never seen by the model or a log; nobody asked", async () => {
    PAGES["/pw/login"] = `<title>Sign in</title><main><h1>Sign in</h1><form onsubmit="event.preventDefault(); if (document.getElementById('e').value === 'me@site.test' && document.getElementById('p').value === '${FAKE_PW1}') location.href = '/pw/in'; else document.title = 'wrong'"><label>Email <input id=e type=email></label><label>Password <input id=p type=password></label><button>Sign in</button></form></main>`;
    PAGES["/pw/in"] = `<title>Orders</title><main><h1>Your orders</h1><p>None yet.</p></main>`;
    const told = [], logs = [], journal = [], asked = [];
    const llm = async req => { told.push(req.input[0].content[0].text); return { output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "no orders" }) }] }; };
    hits = [];
    const passwords = { get: async site => site === "127.0.0.1" ? { site, username: "me@site.test", password: FAKE_PW1 } : null, save: async () => true };
    await browse({ goal: "my orders", start_url: `http://127.0.0.1:${port}/pw/login` },
      { call, llm, allowLoopback: true, sleep: fast, human: false, passwords, log: l => logs.push(l), journal: l => journal.push(l), ask: async q => { asked.push(q); return "done"; } });
    if (process.env.SHOW) console.log(logs.join("\n"), journal.join("\n"));
    assert.ok(hits.includes("/pw/in"), "signed in: " + JSON.stringify(hits));
    assert.equal(asked.length, 0, "nobody asked: " + JSON.stringify(asked));
    assert.ok(![...told, ...logs, ...journal].some(t => (t.includes(FAKE_PW1) || /me@site\.test/.test(t))), "never the password or the username");
  });

  test("no saved sign-in: asked for on the phone's form, signed in, kept on the Mac", async () => {
    PAGES["/pw2/login"] = `<title>Sign in</title><main><form onsubmit="event.preventDefault(); if (document.getElementById('p').value === '${FAKE_PW2}') location.href = '/pw2/in'"><label>Username <input id=u></label><label>Password <input id=p type=password></label><button>Log in</button></form></main>`;
    PAGES["/pw2/in"] = `<title>Home</title><main><h1>Welcome</h1></main>`;
    const told = [], saved = [], forms = [];
    const llm = async req => { told.push(req.input[0].content[0].text); return { output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "in" }) }] }; };
    hits = [];
    await browse({ goal: "sign me in", start_url: `http://127.0.0.1:${port}/pw2/login` },
      { call, llm, allowLoopback: true, sleep: fast, human: false,
        passwords: { get: async () => null, save: async l => { saved.push(l); return true; } },
        askSignIn: async (q, f) => { forms.push([q, f]); return { username: "bogdan", password: FAKE_PW2, remember: true }; },
        ask: async () => "done" });
    assert.ok(hits.includes("/pw2/in"), JSON.stringify(hits));
    assert.equal(forms.length, 1);
    assert.deepEqual(forms[0][1], { site: "127.0.0.1", username: "", need_user: true });
    assert.match(forms[0][0], /not through the chat/);
    assert.deepEqual(saved, [{ site: "127.0.0.1", username: "bogdan", password: FAKE_PW2 }]);
    assert.ok(!told.some(t => t.includes(FAKE_PW2)));
  });

  test("a saved password the site calls wrong: deleted, asked for on the phone, then in; username and password on two pages", async () => {
    PAGES["/two/login"] = `<title>Sign in</title><main><form onsubmit="event.preventDefault(); location.href = '/two/password?u=' + encodeURIComponent(document.getElementById('u').value)"><label>Email <input id=u type=email></label><button>Next</button></form></main>`;
    PAGES["/two/password"] = `<title>Sign in</title><main><p id=m></p><form onsubmit="event.preventDefault(); if (document.getElementById('p').value === '${FAKE_PW4}') location.href = '/two/in'; else document.getElementById('m').textContent = 'Wrong password. Try again.'"><label>Password <input id=p type=password></label><button>Sign in</button></form></main>`;
    PAGES["/two/in"] = `<title>Home</title><main><h1>Welcome</h1></main>`;
    const forgot = [], saved = [], forms = [];
    const llm = async () => ({ output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "in" }) }] });
    hits = [];
    await browse({ goal: "sign me in", start_url: `http://127.0.0.1:${port}/two/login` },
      { call, llm, allowLoopback: true, sleep: fast, human: false,
        passwords: { get: async site => ({ site, username: "me@site.test", password: FAKE_PW3 }), save: async l => { saved.push(l); return true; }, forget: async (site, user) => { forgot.push([site, user]); return true; } },
        askSignIn: async (q, f) => { forms.push([q, f]); return { username: "", password: FAKE_PW4, remember: true }; },
        ask: async () => "done" });
    assert.ok(hits.includes("/two/in"), JSON.stringify(hits));
    assert.deepEqual(forgot, [["127.0.0.1", "me@site.test"]]);
    assert.equal(forms.length, 1);
    assert.match(forms[0][0], /didn't work \(I deleted it\)/);
    assert.equal(forms[0][1].need_user, false, "the password page has no username box");
    assert.equal(saved.length, 1);
  });

  test("a sign-in hand-off before the form is open: told to open it; then the job signs in itself (Facebook's \"Continue\")", async () => {
    PAGES["/fb"] = `<title>Facebook</title><main><h1>Bogdan</h1><a href="/fb/pw">Continue</a> <a href="/fb/other">Use another profile</a></main>`;
    PAGES["/fb/pw"] = `<title>Facebook</title><main><form onsubmit="event.preventDefault(); if (document.getElementById('p').value === '${FAKE_PW1}') location.href = '/fb/home'"><label>Password <input id=p type=password></label><button>Log in</button></form></main>`;
    PAGES["/fb/home"] = `<title>Feed</title><main><h1>Feed</h1></main>`;
    const told = [], asked = [];
    let i = 0;
    const llm = async req => {
      const t = req.input[0].content[0].text; told.push(t); i++;
      if (i === 1) return { output: [{ type: "function_call", name: "handoff", arguments: JSON.stringify({ reason: "Please sign in to Facebook." }) }] };
      const cont = t.match(/link "Continue" \[ref=([A-Za-z0-9_]+)\]/)?.[1];
      if (cont && i === 2) return { output: [{ type: "function_call", name: "click", arguments: JSON.stringify({ ref: cont }) }] };
      return { output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "in" }) }] };
    };
    hits = [];
    await browse({ goal: "my feed", start_url: `http://127.0.0.1:${port}/fb` },
      { call, llm, allowLoopback: true, sleep: fast, human: false,
        passwords: { get: async site => ({ site, username: "", password: FAKE_PW1 }), save: async () => true, forget: async () => true },
        ask: async (q, img, o) => { asked.push([q, o]); return "done"; } });
    assert.match(told[1], /open the site's own sign-in form first/);
    assert.ok(hits.includes("/fb/home"), JSON.stringify(hits));
    assert.equal(asked.length, 0, JSON.stringify(asked));
  });

  test("a code page whose tab Chrome takes (a password manager's frame): no code asked for — the hand-off says to type it there", async () => {
    PAGES["/sms/verify"] = `<meta charset=utf-8><title>Verify</title><main><h1>Enter the code</h1><p>We texted a verification code to •••• ••34.</p><form onsubmit="event.preventDefault()"><label>Code <input id=c inputmode=numeric></label><button>Verify</button></form></main>`;
    const llm = async () => ({ output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "ok" }) }] });
    let looks = 0;
    const own = { connected: true, ready: async () => true,
      takenAway: async () => (++looks >= 3 ? [{ tabId: 9, url: `http://127.0.0.1:${port}/sms/verify` }] : []),
      capture: async () => ({ b64: "", w: 1, h: 1 }) };
    // Anything else the job asks the extension: nothing to report.
    const bridge = new Proxy(own, { get: (t, k) => k in t ? t[k] : async () => [] });
    const asked = [];
    await browse({ goal: "sign in", start_url: `http://127.0.0.1:${port}/sms/verify`, their_phone_end: "1234" },
      { call, llm, allowLoopback: true, sleep: fast, human: false, bridge, lostTab: () => {}, log: l => process.env.SHOW && console.log(l), journal: l => process.env.SHOW && console.log(l), ask: async (q, img, o) => { asked.push([q, o]); return "stop"; } });
    assert.ok(!asked.some(([q]) => /Reply with the code/.test(q)), "the code wasn't asked for: " + JSON.stringify(asked));
    assert.ok(asked.some(([q, o]) => o?.takeover && /Type the code 127\.0\.0\.1:\d+ sent you there/.test(q)), JSON.stringify(asked));
  });

  test("a code page taken by a password manager's frame: read by the extension, the code asked for, typed with the Mac's keys (Instagram)", async () => {
    PAGES["/ig/2fa"] = `<meta charset=utf-8><title>Verify</title><main><p>Enter the 6-digit code we sent to the number ending in 34.</p><label>Security code <input id=c></label><button>Confirm</button></main>`;
    const llm = async () => ({ output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "in" }) }] });
    let looks = 0, typed = false;
    const reading = { url: `http://127.0.0.1:${port}/ig/2fa`, innerW: 1000, innerH: 800, text: "Enter the 6-digit code we sent to the number ending in 34.",
      boxes: [{ kind: "code", name: "Security code", rect: [100, 200, 300, 40] }], buttons: [{ name: "Confirm", rect: [100, 260, 120, 40] }] };
    const own = { connected: true, ready: async () => true,
      takenAway: async () => (++looks >= 3 && !typed ? [{ tabId: 9, url: reading.url }] : []),
      page: async () => reading, capture: async () => ({ b64: "", w: 1, h: 1 }) };
    const bridge = new Proxy(own, { get: (t, k) => k in t ? t[k] : async () => [] });
    const ops = [], asked = [], logs = [];
    const osInput = async req => { ops.push(req); if (req.op === "key" && req.key === "Enter") typed = true; return { ok: true, why: "" }; };
    await browse({ goal: "sign in", start_url: reading.url, their_phone_end: "1234" },
      { call, llm, allowLoopback: true, sleep: fast, human: false, bridge, lostTab: () => {}, osInput, log: l => logs.push(l),
        ask: async (q, img, o) => { asked.push([q, o]); return "it's 482913"; } });
    assert.ok(asked.some(([q, o]) => /texted a code to your number ending in 34/.test(q) && !o?.takeover), JSON.stringify(asked));
    assert.ok(!asked.some(([, o]) => o?.takeover), "no hand-off");
    const tap = ops.find(o => o.op === "tap" && o.x === 250 && o.y === 220);
    assert.ok(tap, "tapped the code box's middle: " + JSON.stringify(ops.filter(o => o.op !== "check" && o.op !== "passkey")));
    assert.equal(ops.filter(o => o.op === "text").map(o => o.text).join(""), "482913");
    assert.ok(!logs.some(l => /482913/.test(l)), "the code isn't logged");
  });

  test("a sign-in answered in the chat instead (\"phone\"): handed over as before", async () => {
    PAGES["/pw3/login"] = `<title>Sign in</title><main><label>Password <input type=password></label></main>`;
    const asked = [];
    const llm = async () => ({ output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "x" }) }] });
    await browse({ goal: "sign in", start_url: `http://127.0.0.1:${port}/pw3/login` },
      { call, llm, allowLoopback: true, sleep: fast, human: false, askSignIn: async () => ({ reply: "phone" }), ask: async (q, img, o) => { asked.push([q, o]); return "done"; } });
    assert.ok(asked.some(([q, o]) => o?.takeover && /sign in/.test(q)), JSON.stringify(asked));
  });

  test("a code texted to their number: asked for in the chat, typed; not their number: handed over", async () => {
    PAGES["/sms/verify"] = `<meta charset=utf-8><title>Verify</title><main><h1>Enter the code</h1><p>We texted a verification code to •••• ••34.</p><form onsubmit="event.preventDefault(); if (document.getElementById('c').value === '482913') location.href = '/sms/ok'"><label>Code <input id=c inputmode=numeric></label><button>Verify</button></form></main>`;
    PAGES["/sms/ok"] = `<title>Done</title><main><h1>Verified</h1></main>`;
    const llm = async () => ({ output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "ok" }) }] });
    let asked = [];
    hits = [];
    const smslog = [];
    await browse({ goal: "sign in", start_url: `http://127.0.0.1:${port}/sms/verify`, their_phone_end: "1234" },
      { call, llm, allowLoopback: true, sleep: fast, human: false, journal: l => smslog.push(l), log: l => smslog.push(l), ask: async (q, img, o) => { asked.push([q, o]); return "the code is 482913"; } });
    if (process.env.SHOW) console.log(JSON.stringify(asked), smslog.join("\n"));
    assert.ok(hits.includes("/sms/ok"), JSON.stringify(hits));
    assert.match(asked[0][0], /texted a code to your number ending in 34/);
    asked = [];
    await browse({ goal: "sign in", start_url: `http://127.0.0.1:${port}/sms/verify`, their_phone_end: "9999" },
      { call, llm, allowLoopback: true, sleep: fast, human: false, ask: async (q, img, o) => { asked.push([q, o]); return "done"; } });
    assert.ok(!asked.some(([q]) => /Reply with the code/.test(q)), "not their number: no code asked for");
  });

  test("a list and its items, back to the list each time, is reading — not a loop", async () => {
    PAGES["/hub"] = `<title>Trips</title><main><h1>Trips</h1><a href="/t1">Ski</a> <a href="/t2">Lisbon</a> <a href="/t3">Paris</a></main>`;
    for (const k of ["1", "2", "3"]) PAGES["/t" + k] = `<title>Trip ${k}</title><main><h1>Trip ${k}</h1><a href="/hub">All trips</a></main>`;
    const order = ["Ski", "All trips", "Lisbon", "All trips", "Paris", "All trips"];
    let i = 0; const told = [];
    const llm = async req => {
      const t = req.input[0].content[0].text; told.push(t);
      if (i >= order.length) return { output: [{ type: "function_call", name: "finish", arguments: '{"answer":"three trips"}' }] };
      const ref = t.match(new RegExp(`link "${order[i++]}" \\[ref=([A-Za-z0-9_]+)\\]`))?.[1];
      return { output: [{ type: "function_call", name: "click", arguments: JSON.stringify({ ref }) }] };
    };
    const r = await browse({ goal: "list my trips", start_url: `http://127.0.0.1:${port}/hub` }, { call, llm, allowLoopback: true, sleep: fast });
    assert.equal(r.content, "three trips");
    assert.ok(!told.some(t => /loop/.test(t)), "told it was a loop");
  });

  test("going round in circles between different pages is caught once the laps bring nothing new", async () => {
    for (const k of ["a", "b", "c"]) PAGES["/ring-" + k] = `<title>${k}</title><main><h1>Page ${k}</h1><a href="/ring-${k === "a" ? "b" : k === "b" ? "c" : "a"}">next</a></main>`;
    const asked = []; let calls = 0;
    const llm = async req => { calls++; const t = req.input[0].content[0].text; const ref = t.match(/link "next" \[ref=([A-Za-z0-9_]+)\]/)?.[1]; return { output: [{ type: "function_call", name: "click", arguments: JSON.stringify({ ref }) }] }; };
    const r = await browse({ goal: "x", start_url: `http://127.0.0.1:${port}/ring-a` },
      { call, llm, allowLoopback: true, sleep: fast, ask: async q => { asked.push(q); return "done"; } });
    assert.equal(asked.length, 0, JSON.stringify(asked));
    assert.equal(r.ok, false);
    assert.match(r.content, /circles/);
    // a→b→c→a…: the first lap is all new pages (a hub and its spokes look
    // the same — TripIt's list and its trips); laps with nothing new count.
    // Told, then made to answer, and it doesn't. Bounded — not sixty.
    assert.ok(calls <= 18, `${calls} model calls`);
  });

  // The user's idea (2026-10-12): JS can see what the accessibility
  // snapshot can't — clickable divs and icons — so the model can ask for it.
  const listed = t => t.match(/Note: Clickable without a ref[\s\S]*?\n\nCurrent page:/)?.[0] ?? "";
  const cid = (t, re) => t.match(new RegExp(`- (c\\d+): \\w+ "[^"]*${re}`))?.[1];
  test("clickables finds the cards and the icon a script listens to, not the real link, and click opens one", async () => {
    hits = [];
    const logs = [];
    const { llm, seen } = script([
      () => ["clickables", {}],
      t => ["click", { ref: cid(t, "Apartment 2") }],
      t => ["finish", { answer: /card\/2/.test(t) ? "Apartment 2 opened." : "not opened" }],
    ]);
    const r = await browse({ goal: "open apartment 2", start_url: `http://127.0.0.1:${port}/cards` },
      { call, llm, allowLoopback: true, sleep: fast, log: l => logs.push(l) });
    assert.equal(r.content, "Apartment 2 opened.", logs.join("\n"));
    assert.match(listed(seen[1]), /c\d+: div "Apartment 1/);
    assert.match(listed(seen[1]), /c\d+: div "Favourites"/);
    assert.doesNotMatch(listed(seen[1]), /"Help"/, "a real link is the snapshot's, not clickables'");
    assert.doesNotMatch(listed(seen[1]), /: span "Apartment/, "the card, not its parts");
    assert.ok(hits.includes("/card/2"), hits.join());
    assert.ok(logs.some(l => /clicked c\d+ "Apartment 2.*at \d+,\d+/.test(l)), "a real mouse click");
  });
  test("an icon found by clickables, with only a label, is clicked too; text narrows the list", async () => {
    hits = [];
    const { llm, seen } = script([
      () => ["clickables", { text: "favour" }],
      t => ["click", { ref: cid(t, "Favourites") }],
      t => ["finish", { answer: "ok" }],
    ]);
    await browse({ goal: "open favourites", start_url: `http://127.0.0.1:${port}/cards` }, { call, llm, allowLoopback: true, sleep: fast });
    assert.match(listed(seen[1]), /- c1: div "Favourites"/);
    assert.doesNotMatch(listed(seen[1]), /Apartment/);
    assert.ok(hits.includes("/favourites"), hits.join());
  });
  test("a found clickable that pays still waits for a yes — and no means no", async () => {
    hits = [];
    const asked = [];
    const { llm, seen } = script([
      () => ["clickables", {}],
      t => ["click", { ref: cid(t, "Pay 50") }],
      t => ["finish", { answer: "not paid" }],
    ]);
    await browse({ goal: "pay", start_url: `http://127.0.0.1:${port}/cards` },
      { call, llm, allowLoopback: true, sleep: fast, ask: async q => { asked.push(q); return "no"; } });
    assert.match(asked[0] || "", /Pay 50 lei/);
    assert.match(seen[2], /did not say yes to "Pay 50 lei"/);
    assert.ok(!hits.includes("/paid-card"), hits.join());
  });
  test("a c-id that was never listed is refused", async () => {
    const { llm, seen } = script([() => ["click", { ref: "c7" }], () => ["finish", { answer: "x" }]]);
    await browse({ goal: "x", start_url: `http://127.0.0.1:${port}/cards` }, { call, llm, allowLoopback: true, sleep: fast });
    assert.match(seen[1], /there is no c7 — call clickables first/);
  });

  // A real Mac, 2026-10-12: a click took the tab to OLX's sign-in page, Chrome
  // detached the debugger on the way, and Playwright — told the page had
  // closed — carried on in a new blank tab it called current. Made to happen
  // here the same way: after the click lands, Playwright opens a blank tab.
  test("a tab lost from under Playwright is found again — not a blank page, not a second tab", async () => {
    PAGES["/lost-start"] = `<title>Shop</title><main><h1>Shop</h1><a href="/lost-account">My account</a></main>`;
    PAGES["/lost-account"] = `<title>Sign in</title><main><h1>Your account page</h1></main>`;
    let dropped = false; const logs = [];
    const lossy = async (t, a) => {
      const r = await call(t, a);
      // A click, Playwright's or the person-like one (human.ts).
      if ((t === "browser_click" || t === "browser_run_code_unsafe" && /aria-ref/.test(a.code)) && !dropped) { dropped = true; await call("browser_tabs", { action: "new" }); }
      return r;
    };
    const { llm, seen } = script([
      (t, ref) => ["click", { ref: ref("My account") }],
      t => ["finish", { answer: /Your account page/.test(t) ? "on the account page" : /about:blank/.test(t) ? "blank" : "elsewhere" }],
    ]);
    const r = await browse({ goal: "open my account", start_url: `http://127.0.0.1:${port}/lost-start` },
      { call: lossy, llm, allowLoopback: true, sleep: fast, log: l => logs.push(l) });
    assert.equal(r.content, "on the account page", logs.join("\n"));
    assert.ok(logs.some(l => /a blank tab took over; carrying on in .*lost-account/.test(l)), logs.join("\n"));
    const tabs = (await call("browser_tabs", { action: "list" })).content.map(c => c.text).join("\n");
    assert.equal((tabs.match(/^- \d+:/gm) || []).length, 1, tabs);
    assert.match(tabs, /\(current\) .*lost-account/);
  });

  // A slider check (OLX's "slide to the right", 2026-10-13), solved from the
  // phone: the person's drag is replayed as a real mouse. Like real checks,
  // this one accepts only real (trusted) events, dragged all the way.
  test("a drag from the phone moves a slider like a real mouse would", async () => {
    PAGES["/slider"] = `<title>Check</title><body style="margin:0"><div id=track style="position:absolute;left:20px;top:100px;width:300px;height:40px;background:#eee">
      <div id=knob style="position:absolute;left:0;top:0;width:40px;height:40px;background:#c00"></div></div>
      <script>let down = false, trusted = true, x0 = 0;
      knob.addEventListener('pointerdown', e => { down = true; trusted = trusted && e.isTrusted; x0 = e.clientX; });
      addEventListener('pointermove', e => { if (!down) return; trusted = trusted && e.isTrusted; knob.style.left = Math.max(0, Math.min(260, e.clientX - x0)) + 'px'; });
      addEventListener('pointerup', e => { if (!down) return; down = false; fetch('/slid?at=' + parseInt(knob.style.left) + '&trusted=' + (trusted && e.isTrusted)); });</script></body>`;
    hits = [];
    await call("browser_navigate", { url: `http://127.0.0.1:${port}/slider` });
    const { Takeover } = await import("../dist/takeover.js");
    const t = new Takeover(call, () => {});
    const pts = []; for (let i = 0; i <= 12; i++) pts.push([40 + i * 23, 120 + (i % 2), i * 40]);
    await t.input({ kind: "drag", points: pts });
    await new Promise(r => setTimeout(r, 500));
    const seen = await call("browser_evaluate", { function: "() => ({ left: knob.style.left, at: document.elementFromPoint(40, 120)?.id })" });
    const slid = hits.find(h => h.startsWith("/slid?")) || `(none; page says ${seen.content.map(c => c.text).join(" ").match(/### Result\n([^#]*)/)?.[1]?.replace(/\s+/g, " ")})`;
    assert.ok(slid, hits.join());
    assert.match(slid, /trusted=true/, "a real mouse, not a script's events");
    assert.ok(Number(slid.match(/at=(\d+)/)[1]) >= 250, `the knob ended at ${slid}`);
  });

  test("ask_user with options maps the reply to the option, without a model in between", async () => {
    const { llm, seen } = script([
      () => ["ask_user", { question: "Which order?", options: ["Newest", "Oldest"] }],
      () => ["finish", { answer: "ok" }],
    ]);
    await browse({ goal: "sort", start_url: `http://127.0.0.1:${port}/list` },
      { call, llm, allowLoopback: true, sleep: fast, ask: async () => "2" });
    assert.match(seen[1], /They chose 2: Oldest/);
  });

  // 2026-10-14: "find accommodations in Madonna for my ski trip, 2 hotel
  // rooms, use my booking account" became "sign in to Booking.com; do not
  // search yet", and the job answered "You're signed in, no search done".
  const ASKED = "find accommodations in Madonna for my ski trip, 2 hotel rooms, use my booking account";
  PAGES["/stays"] = `<title>Stays</title><main><h1>Stays</h1><p>Signed in as Bogdan</p><a href="/stays/results">Search stays</a></main>`;
  PAGES["/stays/results"] = `<title>Results</title><main><h1>3 stays in Madonna di Campiglio</h1><p>Hotel Spinale — 2 rooms, € 2,140</p></main>`;

  test("signed in is not done when they asked to search: the goal check sends the job on, and the next answer goes through", async () => {
    const checks = [], seen = [];
    const llm = async req => {
      if (req.tool_choice?.name === "goal_check") { checks.push(req); return checks.length === 1 ? checked(false, "the search") : checked(true); }
      const text = req.input[0].content[0].text; seen.push(text);
      const ref = name => text.match(new RegExp(`"${name}" \\[ref=([A-Za-z0-9_]+)\\]`))?.[1];
      const call = /Hotel Spinale/.test(text) ? ["finish", { answer: "3 stays in Madonna di Campiglio; Hotel Spinale has 2 rooms for € 2,140." }]
        : /still missing: the search/.test(text) ? ["click", { ref: ref("Search stays") }]
        : ["finish", { answer: "You're signed in; I didn't search." }];
      return { output: [{ type: "function_call", name: call[0], arguments: JSON.stringify(call[1]) }], usage: { input_tokens: 300 } };
    };
    const r = await browse({ goal: "Sign in to Booking.com; do not search yet", asked: ASKED, start_url: `http://127.0.0.1:${port}/stays` },
      { call, llm, allowLoopback: true, sleep: fast, human: false, ask: async () => "done" });
    assert.equal(r.content, "3 stays in Madonna di Campiglio; Hotel Spinale has 2 rooms for € 2,140.", seen.join("\n---\n").slice(-800));
    assert.equal(checks.length, 2, "each finish was checked");
    assert.match(seen[1], /Not finished yet — still missing: the search\. Do the next step towards it\./);
    assert.match(seen[0], new RegExp(`The person asked: "${ASKED}"`));
    // The check is small: their words, the goal, the answer, where — not the page.
    const c = checks[0].input[0].content[0].text;
    assert.match(c, new RegExp(`The person asked: "${ASKED}"`));
    assert.match(c, /Goal passed on: Sign in to Booking\.com/);
    assert.match(c, /Proposed answer: You're signed in; I didn't search\./);
    assert.match(c, /Page now: http:\/\/127\.0\.0\.1:\d+\/stays — Stays/);
    assert.doesNotMatch(c, /\[ref=/);
    assert.deepEqual(checks[0].tool_choice, { type: "function", name: "goal_check" });
    assert.equal(r.calls, 5, "3 steps and 2 checks");
    assert.equal(r.inputTokens, 3 * 300 + 2 * 120);
  });

  test("what the job learns about the goal is shown under it on the next steps", async () => {
    const { llm, seen } = script([
      () => ["note_goal", { learned: "Madonna = Madonna di Campiglio; 13–20 Dec; 4 adults; 2 rooms" }],
      () => ["finish", { answer: "ok" }],
    ]);
    await browse({ goal: "find a hotel", asked: ASKED, start_url: `http://127.0.0.1:${port}/stays` },
      { call, llm, allowLoopback: true, sleep: fast, human: false });
    assert.doesNotMatch(seen[0], /Learned so far/);
    assert.match(seen[1], /The person asked: "find accommodations in Madonna[^"]*"\n\nGoal: find a hotel\n\nLearned so far:\n- Madonna = Madonna di Campiglio; 13–20 Dec; 4 adults; 2 rooms/);
  });

  test(`the goal check says "not yet" at most ${MAX_GOAL_REFUSALS} times; then the answer goes through`, async () => {
    let checks = 0, finishes = 0;
    const llm = async req => {
      if (req.tool_choice?.name === "goal_check") { checks++; return checked(false, "the booking"); }
      finishes++;
      return { output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "Here are 3 stays." }) }] };
    };
    const r = await browse({ goal: "find stays", asked: ASKED, start_url: `http://127.0.0.1:${port}/stays` },
      { call, llm, allowLoopback: true, sleep: fast, human: false });
    assert.equal(r.ok, true);
    assert.equal(r.content, "Here are 3 stays.");
    assert.equal(checks, MAX_GOAL_REFUSALS);
    assert.equal(finishes, MAX_GOAL_REFUSALS + 1);
  });

  test("a goal check that fails lets the answer through", async () => {
    let checks = 0;
    const llm = async req => {
      if (req.tool_choice?.name === "goal_check") { checks++; throw new Error("the relay said 502"); }
      return { output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "Here are 3 stays." }) }], usage: { input_tokens: 300 } };
    };
    const r = await browse({ goal: "find stays", asked: ASKED, start_url: `http://127.0.0.1:${port}/stays` },
      { call, llm, allowLoopback: true, sleep: fast, human: false });
    assert.equal(r.content, "Here are 3 stays.");
    assert.equal(checks, 1);
    assert.equal(r.calls, 1);
  });

  test("an answer that says it's blocked is not argued with — no goal check", async () => {
    let checks = 0;
    const llm = async req => {
      if (req.tool_choice?.name === "goal_check") { checks++; return checked(false, "the search"); }
      return { output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "I couldn't search: the site shows a captcha." }) }] };
    };
    const r = await browse({ goal: "find stays", asked: ASKED, start_url: `http://127.0.0.1:${port}/stays` },
      { call, llm, allowLoopback: true, sleep: fast, human: false });
    assert.match(r.content, /captcha/);
    assert.equal(checks, 0);
  });
});

describe("the goal, as the person asked it", () => {
  test("what's learned is kept short: the newest six, within 600 characters, no repeats", () => {
    let l = [];
    for (let i = 1; i <= 8; i++) l = addLearned(l, `note ${i}`);
    assert.deepEqual(l, ["note 3", "note 4", "note 5", "note 6", "note 7", "note 8"]);
    assert.deepEqual(addLearned(l, "note 8"), l);
    assert.deepEqual(addLearned(l, "   "), l);
    let big = [];
    for (let i = 0; i < 6; i++) big = addLearned(big, String(i).repeat(190));
    assert.ok(big.join("\n").length <= 600, `${big.join("\n").length}`);
    assert.equal(big[big.length - 1], "5".repeat(190), "the newest stays");
  });
  test("the check's verdict is read from its call; anything else is no verdict", () => {
    assert.deepEqual(readGoalCheck(checked(false, "the  search ")), { achieved: false, missing: "the search" });
    assert.equal(readGoalCheck({ output: [{ type: "function_call", name: "finish", arguments: "{}" }] }), null);
    assert.equal(readGoalCheck({ output: [{ type: "function_call", name: "goal_check", arguments: "not json" }] }), null);
    assert.equal(readGoalCheck({}), null);
  });
  test("their words are on every step, before the goal; without them, the goal alone", () => {
    const page = { url: "https://x.com/", title: "X", snapshot: "- main [ref=e1]" };
    assert.match(buildInput("g", [], page, "main", "", undefined, { asked: "their words", learned: ["a"] })[0].content[0].text, /^The person asked: "their words"\n\nGoal: g\n\nLearned so far:\n- a\n/);
    assert.match(buildInput("g", [], page, "main")[0].content[0].text, /^Goal: g\n/);
    const req = goalCheckRequest({ asked: "", goal: "g", learned: [], answer: "a", page: null });
    assert.doesNotMatch(req.input[0].content[0].text, /person asked/);
  });
});
