// Gepetel for Chrome, end to end — without anybody's real Chrome.
//
// Branded Chrome no longer loads an unpacked extension from the command line,
// so this uses Playwright's test Chromium with chrome/dist loaded, headless,
// in a throwaway profile. Playwright MCP connects exactly as the agent does:
// --extension, the app's key, and bin/open-chrome standing in for Chrome to
// point the connect page at our extension. The "Allow" click is made over the
// DevTools protocol, as a person would make it.
//
//   (cd ../chrome && npm run build) && npx playwright-core install chromium
//   node tests/extension.e2e.mjs
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { McpClient } from "../dist/mcpClient.js";
import { EXTENSION_ID } from "../dist/extension.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const ext = path.resolve(here, "..", "..", "chrome", "dist");
const pwm = path.resolve(here, "fixtures", "pw-manager");
// Random, so a browser still closing from a previous run never holds it.
const PORT = 9300 + Math.floor(Math.random() * 600);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gep-ext-"));
const cli = path.join(path.dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");

let failures = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "  ok  " : "FAIL  "}${name}${cond ? "" : " — " + extra}`); if (!cond) failures++; };

// The browser, with our extension and nothing else.
const browser = spawn(chromium.executablePath(), [
  `--user-data-dir=${path.join(tmp, "profile")}`, `--remote-debugging-port=${PORT}`,
  // With a stand-in password manager beside it: on a real Mac the job's tab
  // was lost on sign-in pages, where those put frames of their own.
  `--disable-extensions-except=${ext},${pwm}`, `--load-extension=${ext},${pwm}`,
  // Recent Chromium turns --load-extension off unless asked to keep it.
  "--disable-features=DisableLoadExtensionCommandLineSwitch",
  ...(process.env.HEADFUL ? [] : ["--headless=new"]), "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: "ignore" });
const cdpUp = async () => { for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); return true; } catch { await new Promise(r => setTimeout(r, 100)); } } return false; };
check("the test browser starts", await cdpUp());

// "Real Chrome" for open-chrome: opens the address as a new tab of that
// browser, which is what a second Chrome launch does with a running one.
const real = path.join(tmp, "real-chrome");
// "Real Chrome" for open-chrome: it records the address it was given, and the
// test opens it as a new tab over the DevTools protocol — what a second Chrome
// launch does with a running one. (Chromium's /json/new endpoint was tried
// first and keeps only what comes before the address's first "&", so the
// connect page lost its protocol version and token.)
const opened = path.join(tmp, "opened.txt");
fs.writeFileSync(real, `#!/bin/sh\nfor a; do case "$a" in chrome-extension://*) printf '%s\\n' "$a" >> '${opened}' ;; esac; done\n`, { mode: 0o755 });
const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = cdp.contexts()[0];
let openedCount = 0;
const opener = setInterval(async () => {
  let lines = [];
  try { lines = fs.readFileSync(opened, "utf8").split("\n").filter(Boolean); } catch { return; }
  for (const url of lines.slice(openedCount)) {
    openedCount++;
    const s = await ctx.newCDPSession(ctx.pages()[0]);
    await s.send("Target.createTarget", { url }).catch(e => console.log("createTarget:", e.message));
  }
}, 200);

check("the extension loaded, under our id", await (async () => {
  for (let i = 0; i < 50; i++) { if (ctx.serviceWorkers().some(w => w.url().startsWith(`chrome-extension://${EXTENSION_ID}/`))) return true; await new Promise(r => setTimeout(r, 100)); }
  return false;
})(), ctx.serviceWorkers().map(w => w.url()).join(", "));

const session = (token) => new McpClient(process.execPath, [cli, "--extension"], {
  cwd: path.join(tmp, `mcp-${token.slice(0, 4)}`),
  env: { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token, PLAYWRIGHT_MCP_EXECUTABLE_PATH: path.resolve(here, "..", "bin", "open-chrome"),
         GEPETEL_REAL_CHROME: real, GEPETEL_EXTENSION_ID: EXTENSION_ID },
});
const connectPage = async (ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const p = ctx.pages().find(pg => pg.url().startsWith(`chrome-extension://${EXTENSION_ID}/connect.html`));
    if (p) return p;
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
};

const KEY_A = "AAAAkeyFromTheGepetelAppKeychain_0123456789ab";
const KEY_B = "BBBBsomeOtherKeyNobodyAllowed__0123456789abcd";

// 1. First time: Chrome asks, the person allows, it connects.
{
  const m = session(KEY_A); await m.start();
  const call = m.call("browser_tabs", { action: "list" }, 60_000);
  const page = await connectPage();
  check("Playwright opened OUR extension's connect page (via open-chrome)", !!page, ctx.pages().map(p => p.url()).join(", "));
  const asks = page && await page.getByText('Allow "Gepetel" to use this browser?').isVisible({ timeout: 10000 }).catch(() => false);
  check("the first time, it asks: Allow \"Gepetel\" to use this browser?", asks,
    page ? page.url() + " :: " + (await page.locator("body").innerText().catch(e => String(e))).slice(0, 200).replace(/\n/g, " | ") : "no page");
  await page?.getByRole("button", { name: "Allow", exact: true }).click();
  const r = await call.catch(e => ({ isError: true, content: [{ text: String(e.message) }] }));
  check("after Allow, Playwright is connected through the extension", !r.isError, JSON.stringify(r.content).slice(0, 300));
  // How many tabs does a job make? Counted the way the person sees them.
  if (!r.isError) {
    const tabsNow = () => ctx.pages().map(p => p.url()).filter(u => !u.startsWith("devtools://") && !u.startsWith("about:blank"));
    console.log("    tabs after connecting:", JSON.stringify(tabsNow()));
    await m.call("browser_navigate", { url: "https://example.com/" }, 30000);
    await new Promise(r => setTimeout(r, 800));
    console.log("    tabs after the first navigate:", JSON.stringify(tabsNow()));
    const mcpTabs = (await m.call("browser_tabs", { action: "list" }, 10000)).content.map(c => c.text).join(" ").replace(/\s+/g, " ");
    console.log("    Playwright's own tab list:", mcpTabs.slice(0, 300));
    check("a job works in ONE tab", tabsNow().length === 1, JSON.stringify(tabsNow()));
  }

  // The channel the agent learns the profile through: the extension writes
  // "#profile=<email>" into its connect page's address (this test Chromium is
  // signed in to no account, so it is written here by hand), and the agent
  // reads it from Playwright's tab list.
  if (!r.isError) {
    await page.evaluate(() => history.replaceState(null, "", location.pathname + location.search + "#profile=" + encodeURIComponent("someone@example.com")));
    const tabs = (await m.call("browser_tabs", { action: "list" }, 10000)).content.map(c => c.text).join("\n");
    check("a profile written into the connect page's address shows in the tab list", /#profile=someone%40example\.com/.test(tabs), tabs.slice(0, 300));
  }
  m.close();
}
await new Promise(r => setTimeout(r, 1500));

// 1b. When Gepetel's connection ends, its tabs close with it.
await new Promise(r => setTimeout(r, 1500));
check("Gepetel's tabs close when its connection does",
  !ctx.pages().some(p => p.url().includes(`chrome-extension://${EXTENSION_ID}/connect.html`)),
  ctx.pages().map(p => p.url()).join(", "));

// 1c. The real run of 2026-10-12, through the extension: the job starts at
//     a made-up OLX address, finds the sign-in page and hands it over. The
//     person saw an about:blank tab flashing in the takeover and three tabs.
//     Every tab is counted here — about:blank too — and the one Playwright
//     calls current (what the takeover streams) must be the sign-in page.
if (process.env.SKIP_REAL_SITES !== "1") {
  for (const p of ctx.pages()) if (p.url().includes("connect.html")) await p.close().catch(() => {});
  const mine = new Set(ctx.pages());                 // the person's own tabs
  const mineUrls = new Set([...mine].map(p => p.url().slice(0, 70)));
  const m = session(KEY_A); await m.start();
  const { browse } = await import("../dist/browse.js");
  const logs = []; let atHandover = null; let calls = 0;
  const llm = async req => {
    calls++;
    const text = req.input[0].content[0].text;
    const ref = text.match(/- link[^\n]*\[ref=([A-Za-z0-9_]+)\][^\n]*\n\s*- \/url: \/myaccount/)?.[1];
    return { output: [{ type: "function_call", ...(ref ? { name: "click", arguments: JSON.stringify({ ref }) } : { name: "finish", arguments: '{"answer":"no account link"}' }) }] };
  };
  const r = await browse({ goal: "Ce status are anunțul meu pe OLX?", start_url: "https://www.olx.ro/contul-meu/anunturile-mele/", chat_lang: "Romanian" }, {
    call: (t, a) => m.call(t, a, 60_000), llm, log: l => logs.push(l),
    ask: async (q, img, o) => {
      if (!atHandover && !o?.takeover) {
        // A sign-in page Chrome took from us (the stand-in password manager
        // put its frame there): asked to do it on the Mac — Chrome's own list
        // of tabs, since nobody's Playwright can see that page.
        const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === "page" && !t.url.includes("connect.html"));
        atHandover = { q, takeover: false, chrome: pages.map(t => t.url.slice(0, 70)) };
      }
      if (!atHandover) {
        const list = (await m.call("browser_tabs", { action: "list" }, 10000)).content.map(c => c.text).join("\n");
        atHandover = { q, takeover: !!o?.takeover, current: list.match(/^- \d+: \(current\) \[[^\]]*\]\(([^)]+)\)/m)?.[1],
          gepetel: ctx.pages().filter(p => !mine.has(p)).map(p => p.url()), playwright: list.replace(/\s+/g, " ").slice(0, 400) };
        // The person opens the takeover on their phone: frames stream, the
        // tab is set to the phone's size, they look for a few seconds.
        const { Takeover } = await import("../dist/takeover.js");
        const frames = [];
        const tk = new Takeover((t, a) => m.call(t, a, 20_000), f => frames.push(f));
        await tk.start();
        await tk.input({ kind: "viewport", w: 390, h: 844 });
        await new Promise(r => setTimeout(r, 6000));
        tk.stop();
        await new Promise(r => setTimeout(r, 1000));
        const list2 = (await m.call("browser_tabs", { action: "list" }, 10000)).content.map(c => c.text).join("\n");
        atHandover.takeover2 = { frames: frames.length, sizes: frames.map(f => Math.round(f.b64.length * 3 / 4 / 1024) + "KB " + f.w + "x" + f.h).slice(0, 6),
          current: list2.match(/^- \d+: \(current\) \[[^\]]*\]\(([^)]+)\)/m)?.[1]?.slice(0, 60),
          gepetel: ctx.pages().filter(p => !mine.has(p)).map(p => p.url().slice(0, 60)), playwright: list2.replace(/\s+/g, " ").slice(0, 300) };
      }
      return "stop";
    },
  }).catch(e => ({ content: `threw: ${e.message}` }));
  console.log(`    at hand-over: ${JSON.stringify(atHandover)}`);
  if (process.env.SHOW_LOGS) console.log(logs.join("\n"));
  if (atHandover && !atHandover.takeover) {
    // The stand-in password manager's frame on OLX's sign-in page: what a
    // real Mac with a password manager gets.
    check("OLX through the extension, with a password manager: asked to sign in on the Mac, no phone link", /altă extensie|another extension/.test(atHandover.q), `${calls} model calls; ${JSON.stringify(atHandover)}`);
    const theirs = atHandover.chrome.filter(u => !mineUrls.has(u));
    check("in ONE tab — the sign-in page, no about:blank beside it", theirs.length === 1 && /login\.olx\.ro/.test(theirs[0]), JSON.stringify(atHandover.chrome));
  } else {
    check("OLX through the extension: the sign-in page is handed over", !!atHandover && /olx/.test(atHandover.q) && atHandover.takeover, `${calls} model calls; ${r.content}; ${logs.slice(-5).join(" | ")}`);
    check("and what the takeover shows (Playwright's current tab) is the sign-in page", /login\.olx\.ro|olx\.ro\/.*login/.test(atHandover?.current || ""), JSON.stringify(atHandover));
    check("in ONE tab of Gepetel's — no about:blank, no second sign-in page", atHandover?.gepetel.filter(u => !u.includes("connect.html")).length === 1, JSON.stringify(atHandover?.gepetel));
    const t2 = atHandover?.takeover2;
    check("the takeover streams the sign-in page — frames, not a blank", t2?.frames >= 2 && t2.sizes.every(x => parseInt(x) > 8), JSON.stringify(t2));
    check("and while it does, still ONE tab, still the sign-in page", t2?.gepetel.filter(u => !u.includes("connect.html")).length === 1 && /login\.olx\.ro/.test(t2?.current || ""), JSON.stringify(t2));
  }
  check("\"stop\" ends it", /M-am oprit|Stopped/.test(String(r.content)), String(r.content));
  m.close();
  await new Promise(r => setTimeout(r, 2000));
  check("and its tabs are gone after", ctx.pages().filter(p => !mine.has(p)).length === 0, ctx.pages().filter(p => !mine.has(p)).map(p => p.url()).join(", "));
}

// 1d. A sign-in page with a password manager's frame in it (a stand-in is
//     loaded beside ours). Chrome lets no extension debug a page holding
//     another extension's frame: it took the tab from the job, and Playwright
//     carried on in a blank tab — a second tab, the site opened again, a
//     takeover streaming nothing (a real Mac, 2026-10-12). Now: the blank
//     tab goes, the person is asked to do the step on the Mac (no phone link:
//     Chrome won't show us the page), and once they're past it the job
//     carries on in that same tab.
{
  const site = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/start") return res.end(`<title>Shop</title><main><h1>Shop</h1><a href="/login">My account</a></main>`);
    if (req.url === "/login") return res.end(`<title>Sign in</title><main><h1>Sign in</h1><form><input name=u><input type=password name=p></form></main>`);
    if (req.url === "/account") return res.end(`<title>Your account</title><main><h1>Your ads</h1><p>Bicycle: active</p></main>`);
    res.end("");
  });
  await new Promise(r => site.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${site.address().port}`;
  for (const p of ctx.pages()) if (p.url().includes("connect.html")) await p.close().catch(() => {});
  const mine = new Set(ctx.pages());
  const m = session(KEY_A); await m.start();
  const { browse } = await import("../dist/browse.js");
  const logs = [], asked = []; let atAsk = null;
  // Chrome's own list: the test's Playwright can't see a page with another extension's frame.
  const minePages = new Set([...mine].map(p => p.url()));
  const gepTabs = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === "page" && !t.url.includes("connect.html") && !minePages.has(t.url)).map(t => t.url);
  const llm = async req => {
    const text = req.input[0].content[0].text;
    const ref = text.match(/link "My account" \[ref=([A-Za-z0-9_]+)\]/)?.[1];
    if (/Bicycle: active/.test(text)) return { output: [{ type: "function_call", name: "finish", arguments: '{"answer":"Bicycle is active."}' }] };
    if (ref) return { output: [{ type: "function_call", name: "click", arguments: JSON.stringify({ ref }) }] };
    return { output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "lost: " + (text.match(/URL: (.*)/)?.[1] || "?") }) }] };
  };
  const r = await browse({ goal: "is my bicycle ad active?", start_url: `${base}/start` }, {
    call: (t, a) => m.call(t, a, 30_000), llm, allowLoopback: true, log: l => logs.push(l),
    ask: async (q, img, o) => {
      asked.push({ q, img: !!img, takeover: !!o?.takeover });
      atAsk = await gepTabs();
      if (process.env.SHOW_LOGS) console.log("      chrome targets:", JSON.stringify((await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).map(t => `${t.type} ${t.url.slice(0, 60)}`)));
      // The person signs in, in that tab, on the Mac.
      // (Over the DevTools protocol directly: the test's own Playwright can't
      // attach to that page either.)
      const t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === "page" && t.url.endsWith("/login"));
      if (t) await new Promise(res => { const ws = new WebSocket(t.webSocketDebuggerUrl); ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url: `${base}/account` } })); ws.onmessage = () => { ws.close(); res(); }; ws.onerror = () => res(); });
      await new Promise(r => setTimeout(r, 1500));
      return "gata";
    },
  }).catch(e => ({ content: `threw: ${e.message}` }));
  console.log(`    asked: ${JSON.stringify(asked)}; tabs then: ${JSON.stringify(atAsk)}; ended: ${r.content}`);
  if (process.env.SHOW_LOGS) console.log(logs.map(l => "      " + l.slice(0, 220)).join("\n"));
  check("a tab Chrome takes away: the person is asked to do the step on the Mac — once, no phone link", asked.length === 1 && /another extension|altă extensie/.test(asked[0].q) && !asked[0].takeover, JSON.stringify(asked));
  check("and no blank tab beside it while they do", atAsk?.length === 1 && atAsk[0].endsWith("/login"), JSON.stringify(atAsk));
  check("once they're past it, the job carries on in that tab and answers", r.content === "Bicycle is active.", `${r.content} | ${logs.slice(-6).join(" | ")}`);
  if (process.env.SHOW_LOGS) {
    const sw = ctx.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${EXTENSION_ID}/`));
    const lines = await sw?.evaluate(() => globalThis.__gepetelLog || []).catch(e => [String(e)]);
    console.log("    extension log:\n" + (lines || []).filter(l => !/releaseObject|callFunctionOn/.test(l)).map(l => "      " + l.slice(0, 220)).join("\n"));
  }
  const end = await gepTabs();
  check("one tab at the end", end.length === 1, JSON.stringify(end));
  m.close(); site.close();
  await new Promise(r => setTimeout(r, 1500));
}

// 2. Second time, same key: no question.
{
  for (const p of ctx.pages()) if (p.url().includes("connect.html")) await p.close().catch(() => {});
  const m = session(KEY_A); await m.start();
  const r = await m.call("browser_tabs", { action: "list" }, 30_000).catch(e => ({ isError: true, content: [{ text: String(e.message) }] }));
  check("the same key connects again without asking", !r.isError, JSON.stringify(r.content).slice(0, 300));
  m.close();
}
await new Promise(r => setTimeout(r, 1500));

// 3. A different key: asked again, and "Don't allow" means no connection.
{
  for (const p of ctx.pages()) if (p.url().includes("connect.html")) await p.close().catch(() => {});
  const m = session(KEY_B); await m.start();
  const call = m.call("browser_tabs", { action: "list" }, 60_000).catch(e => ({ isError: true, content: [{ text: String(e.message) }] }));
  const page = await connectPage();
  const asks = page && await page.getByText("wants to connect to this browser with a new key").isVisible({ timeout: 10000 }).catch(() => false);
  check("a different key is never accepted silently — it asks", asks);
  await page?.getByRole("button", { name: "Don't allow" }).click();
  const r = await call;
  check("and \"Don't allow\" leaves it unconnected", r.isError === true, JSON.stringify(r.content).slice(0, 200));
  m.close();
}

clearInterval(opener);
await cdp.close().catch(() => {});
browser.kill("SIGKILL");
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
