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

const session = (token, bridgePort) => new McpClient(process.execPath, [cli, "--extension", "--caps=vision,network,storage"], {
  cwd: path.join(tmp, `mcp-${token.slice(0, 4)}`),
  env: { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token, PLAYWRIGHT_MCP_EXECUTABLE_PATH: path.resolve(here, "..", "bin", "open-chrome"),
         GEPETEL_REAL_CHROME: real, GEPETEL_EXTENSION_ID: EXTENSION_ID, ...(bridgePort ? { GEPETEL_BRIDGE_PORT: String(bridgePort) } : {}) },
});
const { Bridge } = await import("../dist/bridge.js");
// ONLY=1d2,1h runs just those sections (the first connection always runs).
const run = name => !process.env.ONLY || process.env.ONLY.split(",").includes(name);
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
  // waitFor, not isVisible: isVisible doesn't wait (its timeout is ignored),
  // and failed whenever the page drew its question a moment late.
  const asks = page && await page.getByText('Allow "Gepetel" to use this browser?').waitFor({ state: "visible", timeout: 10000 }).then(() => true, () => false);
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

// 1b. When Gepetel's connection ends, its connect page closes; the job's
//     tab is kept for the next job (asked for by the owner, 2026-10-12).
await new Promise(r => setTimeout(r, 1500));
check("when the job ends, the connect page closes and the job's tab is kept",
  !ctx.pages().some(p => p.url().includes(`chrome-extension://${EXTENSION_ID}/connect.html`)) && ctx.pages().some(p => p.url().startsWith("https://example.com/")),
  ctx.pages().map(p => p.url()).join(", "));

// 1c. The real run of 2026-10-12, through the extension: the job starts at
//     a made-up OLX address, finds the sign-in page and hands it over. The
//     person saw an about:blank tab flashing in the takeover and three tabs.
//     Every tab is counted here — about:blank too — and the one Playwright
//     calls current (what the takeover streams) must be the sign-in page.
if (run("1c") && process.env.SKIP_REAL_SITES !== "1") {
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
  const after = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === "page" && !mineUrls.has(t.url.slice(0, 70))).map(t => t.url.slice(0, 60));
  check("and after, only its one tab is kept — no blank, no connect page", after.length === 1 && /olx\.ro/.test(after[0]), JSON.stringify(after));
}

// 1d. A sign-in page with a password manager's frame in it (a stand-in is
//     loaded beside ours, its frame in a closed shadow root). Chrome lets no
//     extension debug a page holding another extension's frame: it took the
//     tab from the job on a real Mac (iCloud Passwords, 2026-10-12) — a
//     blank tab, the site opened again, a takeover streaming nothing. Our
//     extension now takes such frames out of the tabs Gepetel drives, so the
//     sign-in page stays the job's and is handed over the usual way, phone
//     link and all; the person's own tabs keep the password manager.
if (run("1d")) {
  const site = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/start") return res.end(`<title>Shop</title><main><h1>Shop</h1><a href="/login">My account</a></main>`);
    if (req.url === "/login") return res.end(`<title>Sign in</title><main><h1>Sign in</h1><form><input name=u><input type=password name=p></form></main>`);
    res.end("");
  });
  await new Promise(r => site.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${site.address().port}`;
  for (const p of ctx.pages()) if (p.url().includes("connect.html")) await p.close().catch(() => {});
  const before = new Set((await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === "page").map(t => t.id));
  const logs = [], asked = []; let atAsk = null;
  const bridge = new Bridge(KEY_A, l => logs.push(l));
  const m = session(KEY_A, await bridge.start()); await m.start();
  const { browse } = await import("../dist/browse.js");
  const llm = async req => {
    const text = req.input[0].content[0].text;
    const ref = text.match(/link "My account" \[ref=([A-Za-z0-9_]+)\]/)?.[1];
    return { output: [{ type: "function_call", ...(ref ? { name: "click", arguments: JSON.stringify({ ref }) } : { name: "finish", arguments: '{"answer":"done"}' }) }] };
  };
  const t1 = Date.now();
  const r = await browse({ goal: "is my bicycle ad active?", start_url: `${base}/start` }, {
    call: (t, a) => m.call(t, a, 30_000), llm, allowLoopback: true, log: l => logs.push(`${((Date.now() - t1) / 1000).toFixed(1)} ${l}`), bridge,
    ...(process.env.ONLY_1D ? { now: () => t1 + (Date.now() - t1) * 20 } : {}),
    ask: async (q, img, o) => {
      asked.push({ q: q.slice(0, 90), takeover: !!o?.takeover });
      atAsk = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === "page" && !before.has(t.id) && !t.url.includes("connect.html")).map(t => t.url);
      return "stop";
    },
  }).catch(e => ({ content: `threw: ${e.message}` }));
  const sw = ctx.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${EXTENSION_ID}/`));
  const extLog = (await sw?.evaluate(() => globalThis.__gepetelLog || []).catch(() => [])) || [];
  if (process.env.SHOW_LOGS) console.log(logs.concat(extLog).map(l => "      " + l.slice(0, 200)).join("\n"));
  check("a password manager on a sign-in page: handed over with the phone link (through the extension)", asked.length === 1 && asked[0].takeover && /sign in|conectezi/i.test(asked[0].q), JSON.stringify(asked) + " " + r.content);
  check("in one tab, still the job's — no blank tab", atAsk?.length === 1 && atAsk[0].endsWith("/login"), JSON.stringify(atAsk));
  // Chrome took the tab once; the extension left it alone — no loop.
  // From the extension's complete log, as the bridge delivers it (its own
  // in-memory copy keeps only the last 100 lines — in a full run the detach
  // had already scrolled out of it).
  const full = logs.filter(l => /\[chrome\]/.test(l));
  check("Chrome took the tab once, and the extension left it alone", full.filter(l => /detached from tab .*target_closed/.test(l)).length === 1 && full.some(l => /hands off/.test(l)), full.slice(-6).join(" | "));
  m.close(); bridge.close();
  await new Promise(r => setTimeout(r, 1500));
  // The person's own tab, not Gepetel's: the password manager's frame stays.
  const own = await ctx.newPage();
  await own.goto(`${base}/login`);
  await own.waitForTimeout(1500);
  const kept = await own.evaluate(() => !!document.querySelector("[data-stand-in-password-manager]"));
  check("in the person's own tabs the password manager is left alone", kept, "its host element is gone");
  if (process.env.ONLY_1D) {
    console.log(extLog.filter(l => !/releaseObject|callFunctionOn/.test(l)).map(l => "      EXT " + l.slice(0, 200)).join("\n"));
    console.log(logs.map(l => "      JOB " + l.slice(0, 200)).join("\n"));
    process.exit(0);
  }
  await own.close();
  site.close();
  await new Promise(r => setTimeout(r, 1500));
}

// 1d2. The cycle seen on a real Mac: phone view, and a password manager that
//      puts its frame back each time it's taken out. Fighting for the tab
//      (taking the frame out, attaching again) went round in a loop and the
//      page flickered between phone and desktop, "epilepsy-like". Now Chrome
//      takes the tab once, the extension leaves it alone until it goes to
//      another page, and the person is asked. Logged on both sides — the
//      extension's lines arrive in the agent's log over the direct line.
if (run("1d2")) {
  const site = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<meta name=viewport content="width=device-width,initial-scale=1"><title>Sign in</title><main><h1>Sign in</h1><form><input name=u><input type=password name=p></form></main>`);
  });
  await new Promise(r => site.listen(0, "127.0.0.1", r));
  for (const p of ctx.pages()) if (p.url().includes("connect.html")) await p.close().catch(() => {});
  const logs = [];
  const bridge = new Bridge(KEY_A, l => logs.push(l));
  const m = session(KEY_A, await bridge.start()); await m.start();
  const { browse } = await import("../dist/browse.js");
  const { SiteMemory } = await import("../dist/sites.js");
  const asked = [];
  const t1 = Date.now();
  await browse({ goal: "sign in", start_url: `http://127.0.0.1:${site.address().port}/signin` }, {
    call: (t, a) => m.call(t, a, 30_000), allowLoopback: true, log: l => logs.push(`${((Date.now() - t1) / 1000).toFixed(1)} ${l}`), phoneView: true, sites: new SiteMemory(null), bridge,
    llm: async () => ({ output: [{ type: "function_call", name: "finish", arguments: '{"answer":"ok"}' }] }),
    ask: async (q, img, o) => { asked.push({ q: q.slice(0, 80), takeover: !!o?.takeover }); await new Promise(r => setTimeout(r, 6000)); return "stop"; },
  }).catch(e => logs.push("threw " + e.message));
  const ext = logs.filter(l => /^\[chrome\]/.test(l));
  if (process.env.SHOW_LOGS) console.log(logs.map(l => "      " + l.slice(0, 200)).join("\n"));
  check("the extension's log arrives in the agent's log, over the direct line", ext.some(l => /bridge: connected/.test(l)), logs.slice(0, 5).join(" | "));
  const detaches = ext.filter(l => /detached from tab .*target_closed/.test(l)).length;
  check("a password manager that keeps putting its frame back: Chrome takes the tab once, and it's left alone — no loop", detaches === 1 && ext.some(l => /hands off until it goes to another page/.test(l)), `${detaches} detaches: ${ext.filter(l => /detached|hands off|guard|ours again/.test(l)).join(" | ")}`);
  check("no flipping between phone and desktop (the flicker)", !ext.some(l => /→ desktop/.test(l)) && ext.filter(l => /→ phone/.test(l)).length <= 1, ext.filter(l => /→/.test(l)).join(" | "));
  check("and the person is asked to sign in", asked.length >= 1, JSON.stringify(asked));
  m.close(); bridge.close(); site.close();
  await new Promise(r => setTimeout(r, 1500));
}

// 1d3. Step 2: the person signs in from the phone on a page the debugger
//      can't hold (the stand-in password manager keeps its frame there). The
//      takeover goes through the extension: its own captures, its page
//      script for taps and typing — each logged with what it hit. Once
//      signed in, the page moves on, the tab is ours again, the job goes on.
if (run("1d3")) {
  let submitted = null;
  const site = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/start") return res.end(`<meta name=viewport content="width=device-width,initial-scale=1"><title>Shop</title><main><h1>Shop</h1><a href="/signin">My account</a></main>`);
    if (u.pathname === "/account") { submitted = { u: u.searchParams.get("u"), p: u.searchParams.get("p") ? "(given)" : "" }; return res.end(`<meta name=viewport content="width=device-width,initial-scale=1"><title>Your account</title><main><h1>Your ads</h1><p>Bicycle: active</p></main>`); }
    res.end(`<meta name=viewport content="width=device-width,initial-scale=1"><title>Sign in</title><main><h1>Sign in</h1><form action="/account"><input name=u placeholder=Email style="display:block;width:300px;height:40px"><input type=password name=p placeholder=Password style="display:block;width:300px;height:40px;margin-top:10px"><button style="display:block;width:300px;height:40px;margin-top:10px">Sign in</button></form></main>`);
  });
  await new Promise(r => site.listen(0, "127.0.0.1", r));
  for (const p of ctx.pages()) if (p.url().includes("connect.html")) await p.close().catch(() => {});
  const logs = [];
  const bridge = new Bridge(KEY_A, l => logs.push(l));
  const m = session(KEY_A, await bridge.start()); await m.start();
  const { browse } = await import("../dist/browse.js");
  const { SiteMemory } = await import("../dist/sites.js");
  const { Takeover } = await import("../dist/takeover.js");
  const frames = [];
  const origLog = console.log; console.log = (...a) => { logs.push(a.join(" ")); };   // the takeover's own lines
  const tk = new Takeover((t, a) => m.call(t, a, 20_000), f => frames.push(f));
  tk.bridge = bridge;
  const asked = []; let typedFields = null;
  const tap = async (x, y) => { await tk.input({ kind: "tap", x, y }); await new Promise(r => setTimeout(r, 400)); };
  const llm = async req => {
    const text = req.input[0].content[0].text;
    if (/Bicycle: active/.test(text)) return { output: [{ type: "function_call", name: "finish", arguments: '{"answer":"Bicycle is active."}' }] };
    const ref = text.match(/link "My account" \[ref=([A-Za-z0-9_]+)\]/)?.[1];
    return { output: [{ type: "function_call", ...(ref ? { name: "click", arguments: JSON.stringify({ ref }) } : { name: "finish", arguments: '{"answer":"lost"}' }) }] };
  };
  const r = await browse({ goal: "is my bicycle ad active?", start_url: `http://127.0.0.1:${site.address().port}/start` }, {
    call: (t, a) => m.call(t, a, 30_000), llm, allowLoopback: true, log: l => logs.push(l), phoneView: true, sites: new SiteMemory(null),
    bridge, lostTab: id => tk.useTab(id),
    ask: async (q, img, o) => {
      asked.push({ q: q.slice(0, 80), takeover: !!o?.takeover, img: !!img });
      if (!o?.takeover) return "stop";
      // The phone: opens the link, waits for a picture, signs in.
      await tk.start();
      for (let i = 0; i < 20 && !frames.length; i++) await new Promise(r => setTimeout(r, 250));
      typedFields = frames.at(-1)?.fields || [];
      const [email, pass] = typedFields;
      if (email) { await tap(email[0] + 20, email[1] + email[3] / 2); await tk.input({ kind: "text", text: "me@example.com" }); }
      if (pass) { await tap(pass[0] + 20, pass[1] + pass[3] / 2); await tk.input({ kind: "text", text: "not-a-real-password" }); }
      if (pass) await tap(pass[0] + 100, pass[1] + pass[3] + 30);   // "Sign in", under the password field
      await new Promise(r => setTimeout(r, 2500));
      tk.stop();
      return "gata";
    },
  }).catch(e => ({ content: "threw " + e.message }));
  console.log = origLog;
  if (process.env.SHOW_LOGS) console.log(logs.filter(l => !/releaseObject|callFunctionOn|Runtime\.evaluate|detachFromTarget|runIfWaiting/.test(l)).map(l => "      " + l.slice(0, 200)).join("\n"));
  check("step 2: a sign-in page the debugger can't hold is handed over with the phone link and a picture", asked.length >= 1 && asked[0].takeover && asked[0].img, JSON.stringify(asked));
  check("the takeover shows it through the extension — frames, with its fields", frames.length >= 1 && (typedFields?.length ?? 0) >= 2, `${frames.length} frames; fields ${JSON.stringify(typedFields)}`);
  check("taps and typing land, each logged with what it hit", submitted?.u === "me@example.com" && submitted.p === "(given)" && logs.some(l => /tap .* → focused INPUT/.test(l)) && logs.some(l => /typed into INPUT\[password\]/.test(l)), JSON.stringify(submitted) + " " + logs.filter(l => /via extension|takeover input/.test(l)).join(" | "));
  check("nothing typed reaches any log — not even in an address", !logs.some(l => /not-a-real-password|me%40example|me@example/.test(l)), logs.filter(l => /not-a-real-password|me%40example|me@example/.test(l)).slice(0, 3).join(" | "));
  check("signed in, the tab is the job's again and it finishes", r.content === "Bicycle is active.", `${r.content} | ${logs.filter(l => /browse:|ours again/.test(l)).slice(-6).join(" | ")}`);
  m.close(); bridge.close(); site.close();
  await new Promise(r => setTimeout(r, 1500));
}

// 1e. Phone view (asked for by the owner, 2026-10-12): a job opens a site
//     as a phone would; a site that doesn't fit a phone is shown as a
//     desktop and remembered, so the next job opens it that way at once.
if (run("1e")) {
  const site = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/m") return res.end(`<meta name=viewport content="width=device-width,initial-scale=1"><title>Phone ready</title><main><h1>Made for phones</h1><a href="/signin">Sign in</a></main>`);
    if (req.url === "/signin") { signinLoads++; return res.end(`<title>Sign in</title><main><div style="width:1000px"><h1>Desktop-only sign-in</h1></div></main>`); }
    res.end(`<title>Desktop only</title><main><div style="width:1200px"><h1>Desktop only</h1></div></main>`);
  });
  await new Promise(r => site.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${site.address().port}`;
  const { browse } = await import("../dist/browse.js");
  const { SiteMemory } = await import("../dist/sites.js");
  const sitesFile = path.join(tmp, "sites.json");
  let signinLoads = 0;
  // Phone or desktop is Gepetel's window size now: the page's real width.
  const probe = `() => ({ w: innerWidth, desktopBrowser: !/Android|iPhone/.test(navigator.userAgent) })`;
  const job = async (url) => {
    for (const p of ctx.pages()) if (p.url().includes("connect.html")) await p.close().catch(() => {});
    const logs = [];
    const bridge = new Bridge(KEY_A, l => logs.push(l));
    const m = session(KEY_A, await bridge.start()); await m.start();
    await browse({ goal: "what is this page?", start_url: url }, {
      call: (t, a) => m.call(t, a, 30_000), allowLoopback: true, log: l => logs.push(l), phoneView: true, sites: new SiteMemory(sitesFile), bridge,
      llm: async () => ({ output: [{ type: "function_call", name: "finish", arguments: '{"answer":"ok"}' }] }),
    });
    const r = await m.call("browser_evaluate", { function: probe }, 15000);
    const seen = JSON.parse(r.content.map(c => c.text || "").join("\n").match(/### Result\n([\s\S]*?)(\n###|$)/)?.[1] || "null");
    m.close(); bridge.close(); await new Promise(r => setTimeout(r, 1500));
    return { seen, logs: logs.filter(l => /browse:|window/.test(l)) };
  };
  const a = await job(`${base}/m`);
  check("a site made for phones opens in a phone-wide window — the page really is that narrow, nothing faked", a.seen?.w <= 520 && a.seen.desktopBrowser && a.logs.some(l => /as a phone/.test(l)), JSON.stringify(a));
  const b = await job(`${base}/d`);
  check("a site that scrolls sideways at phone width gets a maximized window (desktop)", b.seen?.w > 520 && b.logs.some(l => /isn't made for phones/.test(l)) && b.logs.some(l => /as a desktop, loaded again/.test(l)), JSON.stringify(b));
  // By site, not host: booking.com's subdomains are one site.
  check("and remembered, by site", JSON.parse(fs.readFileSync(sitesFile, "utf8")).desktop.includes("127.0.0.1"), fs.readFileSync(sitesFile, "utf8"));
  const c = await job(`${base}/d`);
  check("the next job opens it as a desktop at once — no phone first, no reload", c.seen?.w > 520 && c.logs.some(l => /as a desktop/.test(l)) && !c.logs.some(l => /isn't made for phones/.test(l)), JSON.stringify(c));
  // A click from a phone page to one that isn't made for phones (OLX's
  // sign-in, on a real Mac: cut off, the takeover's taps missed): desktop at
  // once, and the page is not loaded twice.
  {
    for (const p of ctx.pages()) if (p.url().includes("connect.html")) await p.close().catch(() => {});
    const logs = []; let turn = 0;
    const bridge = new Bridge(KEY_A, l => logs.push(l));
    const m = session(KEY_A, await bridge.start()); await m.start();
    await browse({ goal: "sign in", start_url: `${base}/m` }, {
      call: (t, a) => m.call(t, a, 30_000), allowLoopback: true, log: l => logs.push(l), phoneView: true, sites: new SiteMemory(path.join(tmp, "sites2.json")), bridge,
      llm: async req => { const ref = req.input[0].content[0].text.match(/link "Sign in" \[ref=([A-Za-z0-9_]+)\]/)?.[1];
        return { output: [{ type: "function_call", ...(turn++ === 0 && ref ? { name: "click", arguments: JSON.stringify({ ref }) } : { name: "finish", arguments: '{"answer":"ok"}' }) }] }; },
    });
    const r = await m.call("browser_evaluate", { function: probe }, 15000);
    const seen = JSON.parse(r.content.map(c => c.text || "").join("\n").match(/### Result\n([\s\S]*?)(\n###|$)/)?.[1] || "null");
    check("a click onto a page not made for phones: maximized at once, the page not loaded twice", seen?.w > 520 && signinLoads === 1 && logs.some(l => /as a desktop, without loading it again/.test(l)), JSON.stringify({ seen, signinLoads, logs: logs.filter(l => /desktop|phone/.test(l)) }));
    m.close(); bridge.close(); await new Promise(r => setTimeout(r, 1500));
  }
  site.close();
}

// 1f. Kept tabs: a job on a site that has a kept tab starts in it (no new
//     tab), and the group keeps at most 10, the least recently used going.
if (run("1f")) {
  const servers = [];
  // A site per name: s1.localhost, s2.localhost… (Chrome resolves them locally).
  const serve = async title => { const sv = http.createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end(`<title>${title}</title><main><h1>${title}</h1></main>`); }); await new Promise(r => sv.listen(0, "127.0.0.1", r)); servers.push(sv); return `http://s${servers.length}.localhost:${sv.address().port}/`; };
  const { browse } = await import("../dist/browse.js");
  const finish = async () => ({ output: [{ type: "function_call", name: "finish", arguments: '{"answer":"ok"}' }] });
  const pagesNow = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === "page").map(t => t.url);
  const job = async url => {
    for (const p of ctx.pages()) if (p.url().includes("connect.html")) await p.close().catch(() => {});
    const m = session(KEY_A); await m.start();
    const logs = [];
    await browse({ goal: "what is here?", start_url: url }, { call: (t, a) => m.call(t, a, 30_000), llm: finish, allowLoopback: true, log: l => logs.push(l) });
    m.close(); await new Promise(r => setTimeout(r, 1500));
    return logs;
  };
  const a = await serve("Site A");
  await job(a);
  const before = (await pagesNow()).filter(u => u === a).length;
  const logs = await job(a);
  const afterA = (await pagesNow()).filter(u => u === a).length;
  check("a job on a site with a kept tab starts in it — no second tab", before === 1 && afterA === 1 && logs.some(l => /starting in the kept tab/.test(l)), JSON.stringify({ before, afterA, logs: logs.slice(0, 3) }));
  for (let i = 0; i < 11; i++) await job(await serve(`Site ${i}`));
  // In this test browser every web page is Gepetel's (the person's own tab is about:blank).
  const web = (await pagesNow()).filter(u => /^https?:/.test(u));
  check("the group keeps at most 10 tabs, the least recently used going", web.length === 10 && !web.includes(a), `${web.length}: ${JSON.stringify(web)}`);
  for (const sv of servers) sv.close();
}

// 1g. A site asking for permissions (OLX asked to send notifications): the
//     job's pages answer "no" at once, before the site's code runs, so
//     Chrome never shows its prompt — in new tabs too.
if (run("1g")) {
  const got = [];
  const ask = `<script>
    const report = (k, v) => fetch('/got?' + k + '=' + encodeURIComponent(v));
    report('native', /native code/.test(String(Notification.requestPermission)));
    Notification.requestPermission().then(r => report('notify', r));
    navigator.geolocation.getCurrentPosition(() => report('geo', 'granted'), e => report('geo', 'denied ' + e.code));
  </script>`;
  const site = http.createServer((req, res) => {
    if (req.url.startsWith("/got?")) { got.push(req.url.slice(5)); return res.end(""); }
    res.setHeader("content-type", "text/html");
    if (req.url === "/second") return res.end(`<title>Second</title><main><h1>Second</h1></main>${ask}`);
    res.end(`<title>Perm</title><main><h1>Wants to notify</h1><a href="/second" target="_blank">Open the second</a></main>${ask}`);
  });
  await new Promise(r => site.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${site.address().port}`;
  const { browse } = await import("../dist/browse.js");
  for (const p of ctx.pages()) if (p.url().includes("connect.html")) await p.close().catch(() => {});
  const m = session(KEY_A); await m.start();
  let turn = 0;
  await browse({ goal: "open the second page", start_url: `${base}/perm` }, {
    call: (t, a) => m.call(t, a, 30_000), allowLoopback: true,
    llm: async req => {
      const text = req.input[0].content[0].text;
      const ref = text.match(/link "Open the second" \[ref=([A-Za-z0-9_]+)\]/)?.[1];
      return { output: [{ type: "function_call", ...(turn++ === 0 && ref ? { name: "click", arguments: JSON.stringify({ ref }) } : { name: "finish", arguments: '{"answer":"ok"}' }) }] };
    },
  });
  await new Promise(r => setTimeout(r, 1500));
  m.close(); site.close();
  const notify = got.filter(g => g.startsWith("notify=")), geo = got.filter(g => g.startsWith("geo="));
  check("a site asking to send notifications, or for the location, gets no at once — on its page and in a new tab", notify.length >= 2 && notify.every(g => g === "notify=denied") && geo.length >= 2 && geo.every(g => g === "geo=denied%201"), JSON.stringify(got));
  await new Promise(r => setTimeout(r, 1500));
}

// 1h. "Continue with Google" from a Gepetel tab, tapped in the takeover: a
//     popup to a sign-in page, where the password manager puts its frame. On
//     a real Mac it stayed black and the window flickered (the extension
//     retried the taken tab every 2 s, flashing Chrome's debugging bar). The
//     popup must load, and the guard looks after it too.
if (run("1h")) {
  const site = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/provider") return res.end(`<title>Provider</title><h1>Provider sign-in</h1><form><input name=u><input type=password name=p></form>`);
    res.end(`<title>Site</title><button style="position:absolute;left:20px;top:20px;width:200px;height:60px" onclick="const w = window.open('', 'g', 'width=500,height=600'); w.location = '/provider'">Continue with Google</button>`);
  });
  await new Promise(r => site.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${site.address().port}`;
  for (const p of ctx.pages()) if (p.url().includes("connect.html")) await p.close().catch(() => {});
  const sw = ctx.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${EXTENSION_ID}/`));
  await sw?.evaluate(() => { globalThis.__gepetelLog = []; }).catch(() => {});
  const tklog = [];
  const bridge = new Bridge(KEY_A, l => tklog.push(l));
  const m = session(KEY_A, await bridge.start()); await m.start();
  await m.call("browser_navigate", { url: base + "/" }, 30000);
  await bridge.ready(5000);
  // The person, on the phone, through the takeover.
  const { Takeover } = await import("../dist/takeover.js");
  const frames = [];
  const tk = new Takeover((t, a) => m.call(t, a, 20_000), f => frames.push(f));
  tk.bridge = bridge;
  const origLog = console.log; console.log = (...a) => tklog.push(a.join(" "));
  await tk.start();
  await tk.input({ kind: "tap", x: 100, y: 50 });
  await new Promise(r => setTimeout(r, 4000));
  const showing = (await m.call("browser_tabs", { action: "list" }, 10000)).content.map(c => c.text).join("\n").match(/^- \d+: \(current\) \[[^\]]*\]\(([^)]+)\)/m)?.[1];
  tk.stop();
  console.log = origLog;
  // Through Playwright, or — when Chrome took the popup for the password
  // manager's frame in it — through the extension.
  const viaExtension = tklog.some(l => /new tab opened that Chrome took.*through the extension/.test(l));
  check("the takeover follows the sign-in popup — the person sees it on the phone", showing === base + "/provider" || viaExtension, `showing ${showing}; ${tklog.filter(l => /takeover/.test(l)).slice(-4).join(" | ")}`);
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === "page").map(t => t.url);
  const extLog = (await sw?.evaluate(() => globalThis.__gepetelLog || []).catch(() => [])) || [];
  check("a sign-in popup from a Gepetel tab loads — not a black about:blank", pages.includes(base + "/provider"), JSON.stringify(pages.slice(0, 4)));
  check("and the password manager's frame is taken out of it too", extLog.some(l => /took out another extension's frame.*127\.0\.0\.1/.test(l)), extLog.slice(-5).join(" | "));
  const attaches = extLog.filter(l => /chrome\.debugger\.attach/.test(l)).length;
  check("no attach retried over and over (the flicker)", attaches <= 2, `${attaches} attach errors: ${extLog.slice(-4).join(" | ")}`);
  m.close(); bridge.close(); site.close();
  await new Promise(r => setTimeout(r, 1500));
}

// A reservation opened from a list of trips (booking.com, 2026-10-13): the
// link's text says "Confirmed € 2,372.14" and it opens in a new tab. The job
// asked "I'm about to press …Confirmed…" before every click on it, the yes
// didn't stick, and the new tab was never followed.
if (run("1i")) {
  const site = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/trips") return res.end(`<meta charset=utf-8><title>My trips</title><main><h1>Upcoming</h1><a href="/trip/1" target="_blank">Superior Gourmethotel Yscla 27 Nov – 2 Dec · Ischgl · Non-refundable Confirmed € 2,372.14</a></main>`);
    if (req.url === "/trip/1") return res.end(`<title>Booking details</title><main><h1>Superior Gourmethotel Yscla</h1><p>Payment: paid in full</p><p>Cancellation: non-refundable</p></main>`);
    res.end("");
  });
  await new Promise(r => site.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${site.address().port}`;
  for (const p of ctx.pages()) if (p.url().includes("connect.html")) await p.close().catch(() => {});
  const logs = [], asked = [], seen = [];
  const bridge = new Bridge(KEY_A, l => logs.push(l));
  const m = session(KEY_A, await bridge.start()); await m.start();
  const { browse } = await import("../dist/browse.js");
  let clicks = 0;
  const llm = async req => {
    const text = req.input.map(i => (i.content || []).map(c => c.text || "").join("\n")).join("\n");
    seen.push(text.match(/Page URL: (\S+)/g)?.slice(-1)[0] ?? "?");
    if (/paid in full/.test(text)) return { output: [{ type: "function_call", name: "finish", arguments: JSON.stringify({ answer: "Paid in full; non-refundable." }) }] };
    const ref = [...text.matchAll(/link "Superior[^"]*" \[ref=([A-Za-z0-9_]+)\]/g)].pop()?.[1];
    if (ref && clicks++ < 3) return { output: [{ type: "function_call", name: "click", arguments: JSON.stringify({ ref }) }] };
    return { output: [{ type: "function_call", name: "finish", arguments: '{"answer":"not found"}' }] };
  };
  const r = await browse({ goal: "is my next trip paid?", start_url: `${base}/trips` }, {
    call: (t, a) => m.call(t, a, 30_000), llm, allowLoopback: true, log: l => logs.push(l), bridge,
    ask: async q => { asked.push(q.slice(0, 120)); return "yes"; },
  }).catch(e => ({ content: `threw: ${e.message}` }));
  if (process.env.SHOW_LOGS) console.log(logs.map(l => "      " + l.slice(0, 200)).join("\n"));
  check("a link that only says \"Confirmed\" isn't an action — nobody is asked", asked.length === 0, JSON.stringify(asked));
  check("the reservation opened in a new tab, and the job read it there", /Paid in full/.test(String(r.content)) && clicks === 1, `${clicks} clicks; ${String(r.content).slice(0, 100)}; saw ${seen.join(" ")}`);
  m.close(); bridge.close(); site.close();
  await new Promise(r => setTimeout(r, 1500));
}

// Clicking and typing as a person does (human.ts), as the page sees it: every
// event trusted, the pointer travelling and landing off the middle, keys one
// at a time with a slip taken back, the pointer drifting while the model
// thinks — and a click that changes nothing is noticed.
if (run("1j")) {
  const site = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<meta charset=utf-8><title>Form</title><main style="padding:40px">
      <button id=open style="width:220px;height:60px" onclick="document.getElementById('more').hidden=false">Open details</button>
      <p id=more hidden>Details: paid in full</p>
      <span id=dead role=button tabindex=0 style="display:inline-block;width:160px;height:40px;border:1px solid #999">Nothing here</span>
      <p><input id=name aria-label="Full name" style="width:300px;height:36px"></p></main>
      <script>window.__ev = []; for (const t of ['mousemove','mousedown','mouseup','click','keydown']) addEventListener(t, e => {
        const r = e.target.getBoundingClientRect ? e.target.getBoundingClientRect() : null;
        __ev.push({ t, trusted: e.isTrusted, id: e.target.id || '', key: e.key, dx: r ? (e.clientX - r.left) / r.width - 0.5 : 0, dy: r ? (e.clientY - r.top) / r.height - 0.5 : 0, at: Date.now() }); }, true);</script>`);
  });
  await new Promise(r => site.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${site.address().port}`;
  for (const p of ctx.pages()) if (p.url().includes("connect.html")) await p.close().catch(() => {});
  const logs = [], notes = [];
  const bridge = new Bridge(KEY_A, l => logs.push(l));
  const m = session(KEY_A, await bridge.start()); await m.start();
  const { browse } = await import("../dist/browse.js");
  let turn = 0, thinkFrom = 0;
  const llm = async req => {
    const text = req.input.map(i => (i.content || []).map(c => c.text || "").join("\n")).join("\n");
    notes.push(text.match(/Clicked [^\n]*nothing on the screen had changed[^\n]*/)?.[0] ?? "");
    const ref = name => text.match(new RegExp(`"${name}" \\[ref=([A-Za-z0-9_]+)\\]`))?.[1];
    const t = turn++;
    if (t === 0) return { output: [{ type: "function_call", name: "click", arguments: JSON.stringify({ ref: ref("Open details") }) }] };
    if (t === 1) return { output: [{ type: "function_call", name: "click", arguments: JSON.stringify({ ref: ref("Nothing here") }) }] };
    if (t === 2) return { output: [{ type: "function_call", name: "type", arguments: JSON.stringify({ ref: ref("Full name"), text: "Bogdan Ripa" }) }] };
    thinkFrom = Date.now(); await new Promise(r => setTimeout(r, 4000));
    return { output: [{ type: "function_call", name: "finish", arguments: '{"answer":"done"}' }] };
  };
  await browse({ goal: "fill in the name", start_url: `${base}/` }, {
    call: (t, a) => m.call(t, a, 30_000), llm, allowLoopback: true, log: l => logs.push(l), bridge, slips: 0.5,
  }).catch(e => logs.push(`threw: ${e.message}`));
  const page = ctx.pages().find(p => p.url().startsWith(base));
  const ev = page ? await page.evaluate(() => window.__ev) : [];
  const value = page ? await page.evaluate(() => document.getElementById("name").value) : "";
  if (process.env.SHOW_LOGS) console.log(logs.filter(l => !/Error handling/.test(l)).map(l => "      " + l.slice(0, 200)).join("\n"));
  const downs = ev.filter(e => e.t === "mousedown");
  check("every mouse and key event is trusted (Chrome's input, not a script's)", ev.length > 0 && ev.every(e => e.trusted), `${ev.filter(e => !e.trusted).length} untrusted of ${ev.length}`);
  check("the pointer travels before each press", downs.length >= 3 && downs.every(d => ev.filter(e => e.t === "mousemove" && e.at < d.at && e.at > d.at - 3000).length >= 5), JSON.stringify(downs.map(d => d.id)));
  check("and lands off the middle", downs.every(d => Math.hypot(d.dx, d.dy) > 0.05), JSON.stringify(downs.map(d => [d.id, d.dx.toFixed(2), d.dy.toFixed(2)])));
  check("a click that changed nothing is noticed and told", notes.some(n => /Nothing here/.test(n)) && !notes.some(n => /Open details/.test(n)), JSON.stringify(notes.filter(Boolean)));
  const keys = ev.filter(e => e.t === "keydown").map(e => e.key);
  check("typing is a key at a time, slips taken back with Backspace, and ends right", value === "Bogdan Ripa" && keys.filter(k => k.length === 1).length > 11 && keys.filter(k => k === "Backspace").length >= 2, `value "${value}"; keys ${keys.join("")}`);
  const gaps = []; const ks = ev.filter(e => e.t === "keydown"); for (let i = 1; i < ks.length; i++) gaps.push(ks[i].at - ks[i - 1].at);
  check("with uneven gaps between keys", gaps.length > 5 && Math.max(...gaps) - Math.min(...gaps) > 40, JSON.stringify(gaps));
  check("the pointer drifts while the model thinks", ev.filter(e => e.t === "mousemove" && e.at > thinkFrom).length >= 3, `${ev.filter(e => e.t === "mousemove" && e.at > thinkFrom).length} moves`);
  check("no drift logged (it's quiet)", !logs.some(l => /quiet/.test(l)), "");
  m.close(); bridge.close(); site.close();
  await new Promise(r => setTimeout(r, 1500));
}

// PROBE (temporary): what sends page sizes on a real, busy site in phone view.
if (process.env.PROBE_SIZES) {
  for (const p of ctx.pages()) if (p.url().includes("connect.html")) await p.close().catch(() => {});
  const sw = ctx.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${EXTENSION_ID}/`));
  const m = session(KEY_A); await m.start();
  await m.call("browser_run_code_unsafe", { code: "async (page) => { await page.setViewportSize({ width: 390, height: 844 }); return true; }" }, 30000);
  await sw?.evaluate(() => { globalThis.__gepetelLog = []; });
  await m.call("browser_navigate", { url: process.env.PROBE_SIZES }, 30000);
  const { Takeover } = await import("../dist/takeover.js");
  const tk = new Takeover((t, a) => m.call(t, a, 20_000), () => {});
  await tk.start(); await tk.input({ kind: "viewport", w: 390, h: 844 });
  await new Promise(r => setTimeout(r, 15000));
  tk.stop();
  const lines = ((await sw?.evaluate(() => globalThis.__gepetelLog || [])) || []).filter(l => /metrics/.test(l));
  console.log(`    size commands in 15 s: ${lines.length}`);
  const counts = {}; for (const l of lines) { const k = l.replace(/tab \d+/, "tab").replace(/frame \w+/, "frame"); counts[k] = (counts[k] || 0) + 1; }
  for (const [k, n] of Object.entries(counts)) console.log(`      ${n} × ${k}`);
  m.close(); await new Promise(r => setTimeout(r, 1500));
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
  const asks = page && await page.getByText("wants to connect to this browser with a new key").waitFor({ state: "visible", timeout: 10000 }).then(() => true, () => false);
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
