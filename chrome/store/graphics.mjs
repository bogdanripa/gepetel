// The store's graphics, made from the real extension and the brand's colours:
//   node store/graphics.mjs   (after npm run build; needs Playwright's Chromium)
// → screenshot-1-allow.png, screenshot-2-window.png (1280×800), promo-small.png (440×280)
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createRequire } from "node:module"; import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(path.resolve(here, "../../agent/package.json"))("playwright-core");
const ext = path.resolve(here, "../dist");
const logo = "data:image/png;base64," + fs.readFileSync(path.resolve(here, "../../website/assets/gepetel.png")).toString("base64");
const fonts = `<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700&family=Hanken+Grotesk:wght@400;500;600&display=swap" rel="stylesheet">`;
const C = { paper: "#FBF6EC", ink: "#2A2620", accent: "#CC6B4E", teal: "#356E78", soft: "#9BBEC8" };

// 1. The real "Allow" page, in Playwright's Chromium with the extension.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gep-gfx-")), port = 9700 + Math.floor(Math.random() * 200);
const b = spawn(chromium.executablePath(), [`--user-data-dir=${tmp}`, `--remote-debugging-port=${port}`, `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--disable-features=DisableLoadExtensionCommandLineSwitch", "--headless=new", "--no-first-run", "about:blank"], { stdio: "ignore" });
for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = cdp.contexts()[0];
let id = null;
for (let i = 0; i < 60 && !id; i++) { for (const w of ctx.serviceWorkers()) if (await w.evaluate(() => chrome.runtime.getManifest().name).catch(() => "") === "Gepetel for Chrome") id = new URL(w.url()).host; if (!id) await new Promise(r => setTimeout(r, 100)); }
// Small and sharp: the page's own layout at 560×250, drawn at twice the pixels.
const cdpPage = await ctx.newPage();
const cs = await ctx.newCDPSession(cdpPage);
await cs.send("Emulation.setDeviceMetricsOverride", { width: 560, height: 250, deviceScaleFactor: 2, mobile: false });
const allow = cdpPage;
await allow.goto(`chrome-extension://${id}/connect.html?mcpRelayUrl=${encodeURIComponent("ws://127.0.0.1:1/x")}&client=${encodeURIComponent(JSON.stringify({ name: "Gepetel" }))}&protocolVersion=2&token=StoreScreenshotKey_0123456789abcdef`);
await allow.waitForTimeout(1200);
const allowShot = await allow.screenshot({ clip: { x: 0, y: 0, width: 560, height: 250 } });
await cdp.close().catch(() => {}); b.kill("SIGKILL");

// Pages rendered from HTML, in a plain headless Chromium.
const browser = await chromium.launch({ headless: true });
const render = async (w, h, html, file) => {
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  await p.setContent(html, { waitUntil: "networkidle" });
  await p.screenshot({ path: path.join(here, file) });
  await p.close();
  console.log(`${file} ${w}×${h}`);
};
// A neutral sign-in page, as the phone would show it.
const phone = await browser.newPage({ viewport: { width: 390, height: 760 } });
await phone.setContent(`<body style="margin:0;font-family:system-ui;background:#fff"><div style="padding:70px 22px 28px"><div style="font:700 26px system-ui;margin:30px 0 22px">Sign in</div>
  <div style="color:#555;font-size:14px;margin-bottom:6px">Email</div><div style="border:1px solid #ccc;border-radius:8px;height:44px;margin-bottom:16px;padding:0 12px;display:flex;align-items:center;color:#222">you@example.com</div>
  <div style="color:#555;font-size:14px;margin-bottom:6px">Password</div><div style="border:2px solid ${C.teal};border-radius:8px;height:44px;margin-bottom:22px;padding:0 12px;display:flex;align-items:center;font-size:22px;letter-spacing:3px">••••••</div>
  <div style="background:#1a1a1a;color:#fff;border-radius:8px;height:46px;display:flex;align-items:center;justify-content:center;font-weight:600">Sign in</div></div></body>`);
const phoneShot = (await phone.screenshot()).toString("base64");
await phone.close();

await render(1280, 800, `${fonts}<body style="margin:0;background:${C.paper};font-family:'Hanken Grotesk',system-ui">
  <div style="position:absolute;left:0;top:0;width:1280px;height:800px;overflow:hidden">
    <div style="position:absolute;left:150px;top:170px;width:980px;padding:24px 0;background:#fff;border-radius:16px;box-shadow:0 18px 50px rgba(42,38,32,.22);text-align:center">
      <img src="data:image/png;base64,${allowShot.toString("base64")}" style="width:760px">
    </div>
    <div style="position:absolute;left:0;right:0;top:612px;text-align:center;font-size:19px;color:${C.ink};line-height:1.6">
      Gepetel's tab group, your signed-in sessions — and before anything that pays, books, sends or deletes,<br>Gepetel asks you in your chat. Take it back any time from the extension's icon.</div>
    <div style="position:absolute;left:0;right:0;top:46px;text-align:center;font:700 40px 'Bricolage Grotesque';color:${C.ink}">Nothing connects without your yes</div>
    <div style="position:absolute;left:0;right:0;top:104px;text-align:center;font-size:20px;color:${C.teal}">The first time, Chrome asks you — and asks again for any other key.</div>
  </div></body>`, "screenshot-1-allow.png");

await render(1280, 800, `${fonts}<body style="margin:0;background:${C.paper};font-family:'Hanken Grotesk',system-ui;color:${C.ink}">
  <div style="position:absolute;left:80px;top:150px;width:600px">
    <div style="font:700 42px/1.15 'Bricolage Grotesque'">Signing in? Do it from your phone.</div>
    <div style="margin-top:26px;font-size:21px;line-height:1.55">
      <div>• Gepetel works in its own Chrome window and tab group — yours are left alone.</div>
      <div style="margin-top:12px">• When a site needs you — a sign-in, a check — you get a one-time link and take over from your phone.</div>
      <div style="margin-top:12px">• Anything that pays, books or sends waits for your OK.</div>
    </div>
  </div>
  <div style="position:absolute;left:820px;top:40px;width:380px;height:720px;border-radius:48px;background:#111;padding:14px;box-sizing:border-box;box-shadow:0 20px 60px rgba(42,38,32,.35)">
    <div style="width:100%;height:100%;border-radius:36px;overflow:hidden;position:relative;background:#fff">
      <img src="data:image/png;base64,${phoneShot}" style="width:100%;display:block">
      <div style="position:absolute;left:14px;top:14px;width:40px;height:40px;border-radius:20px;background:rgba(42,38,32,.7);color:#fff;font-size:24px;text-align:center;line-height:38px">‹</div>
      <div style="position:absolute;right:14px;top:14px;height:40px;padding:0 18px;border-radius:20px;background:${C.accent};color:#fff;font-weight:600;line-height:40px">Done</div>
    </div>
  </div></body>`, "screenshot-2-window.png");

await render(440, 280, `${fonts}<body style="margin:0;background:${C.paper};font-family:'Hanken Grotesk',system-ui;color:${C.ink}">
  <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
    <img src="${logo}" style="height:104px;border-radius:24px">
    <div style="margin-top:16px;font:700 30px 'Bricolage Grotesque'">Gepetel for Chrome</div>
    <div style="margin-top:6px;font-size:16px;color:${C.teal}">Your assistant, in your own browser</div>
  </div></body>`, "promo-small.png");
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
