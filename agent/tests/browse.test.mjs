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
import { parseSnapshot, scopeSnapshot, clickAllowed, clickVerdict, looksLikeAction, buildInput, browse, labels, overlayScript, readPointing, isYes, closeAllTabs, followNewTab, parseTabs, looksLikeLogin, MAX_STEPS, MAIN_CHARS } from "../dist/browse.js";
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
  test("refs after a navigation are frame-prefixed, and still read", () => {
    const later = parseSnapshot('- main [ref=f1e2]:\n  - link "Two" [ref=f1e3] [cursor=pointer]:\n    - /url: /x');
    assert.equal(later.get("f1e3")?.name, "Two");
  });
  test("a ref that is not on the page is refused, not guessed", () => {
    assert.equal(ok("e999"), false);
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
    assert.equal(r.ok, false);
    assert.equal(r.steps, MAX_STEPS);
    assert.match(r.content, new RegExp(`stopped after ${MAX_STEPS} steps`));
  });
  test("a browser connection that dies ends the job at once, not after forty model calls", async () => {
    let calls = 0, n = 0;
    const r = await browse({ goal: "x" }, {
      call: async (tool) => { if (++n > 2) throw new Error("the browser connection ended (null)"); return { content: [{ type: "text", text: "- Page URL: https://example.com/\n### Snapshot\n```yaml\n- main [ref=e1]\n```" }] }; },
      llm: async () => { calls++; return { output: [{ type: "function_call", name: "navigate", arguments: '{"url":"https://example.com/x"}' }] }; },
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

  test("going round in circles between different pages is caught on the third visit", async () => {
    for (const k of ["a", "b", "c"]) PAGES["/ring-" + k] = `<title>${k}</title><main><h1>Page ${k}</h1><a href="/ring-${k === "a" ? "b" : k === "b" ? "c" : "a"}">next</a></main>`;
    const asked = []; let calls = 0;
    const llm = async req => { calls++; const t = req.input[0].content[0].text; const ref = t.match(/link "next" \[ref=([A-Za-z0-9_]+)\]/)?.[1]; return { output: [{ type: "function_call", name: "click", arguments: JSON.stringify({ ref }) }] }; };
    const r = await browse({ goal: "x", start_url: `http://127.0.0.1:${port}/ring-a` },
      { call, llm, allowLoopback: true, sleep: fast, ask: async q => { asked.push(q); return "done"; } });
    assert.equal(asked.length, 0, JSON.stringify(asked));
    assert.equal(r.ok, false);
    assert.match(r.content, /circles/);
    // a→b→c→a: the third visit, the model told; the next third visit, it
    // must answer, and doesn't. Bounded — not sixty.
    assert.ok(calls <= 14, `${calls} model calls`);
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
});
