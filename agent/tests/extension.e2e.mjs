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
// Random, so a browser still closing from a previous run never holds it.
const PORT = 9300 + Math.floor(Math.random() * 600);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gep-ext-"));
const cli = path.join(path.dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");

let failures = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "  ok  " : "FAIL  "}${name}${cond ? "" : " — " + extra}`); if (!cond) failures++; };

// The browser, with our extension and nothing else.
const browser = spawn(chromium.executablePath(), [
  `--user-data-dir=${path.join(tmp, "profile")}`, `--remote-debugging-port=${PORT}`,
  `--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
  // Recent Chromium turns --load-extension off unless asked to keep it.
  "--disable-features=DisableLoadExtensionCommandLineSwitch",
  "--headless=new", "--no-first-run", "--no-default-browser-check", "about:blank",
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
