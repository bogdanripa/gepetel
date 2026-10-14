// The takeover link on the relay: what a viewer may send, and who may open it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
const { cleanInput, KEYS } = await import("../dist/device/takeover.js");

describe("what a viewer may send to the Mac", () => {
  test("taps, text, keys, scroll and back — in range, nothing else", () => {
    assert.deepEqual(cleanInput({ kind: "tap", x: 10.6, y: "20" }), { kind: "tap", x: 11, y: 20 });
    assert.equal(cleanInput({ kind: "tap", x: 1e9, y: 1 }), null);
    assert.equal(cleanInput({ kind: "text", text: "x".repeat(501) }), null);
    assert.deepEqual(cleanInput({ kind: "key", key: "Enter" }), { kind: "key", key: "Enter" });
    assert.equal(cleanInput({ kind: "key", key: "Meta+W" }), null);
    assert.equal(cleanInput({ kind: "scroll", dy: 99999 }), null);
    assert.deepEqual(cleanInput({ kind: "back" }), { kind: "back" });
    assert.equal(cleanInput({ kind: "eval", code: "x" }), null);
    assert.equal(cleanInput({ kind: "navigate", url: "file:///" }), null);
    assert.ok(!KEYS.some(k => /Meta|Control|Alt/.test(k)));
  });
});

// Holding a pill to move it selected the page's text (a real phone,
// 2026-10-12). The viewer page, in a headless Chrome: hold, drag across the
// status text, let go — nothing may be selected, and the pill moved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { page: viewerPage } = await import("../dist/device/takeover.js");
const chrome = ["/Applications/Google Chrome.app", path.join(os.homedir(), "Applications", "Google Chrome.app")].some(p => fs.existsSync(p));
describe("the viewer's pills", chrome ? {} : { skip: "needs Google Chrome installed" }, () => {
  test("holding and dragging a pill moves it and selects nothing", async () => {
    const { chromium } = createRequire(new URL("../agent/package.json", import.meta.url))("playwright-core");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
      // No socket to talk to here: the page shows "Connecting…" and stays.
      await p.route("**/*", r => r.fulfill({ contentType: "text/html", body: viewerPage() }));
      await p.goto("http://viewer.test/t/x");
      const done = await p.locator("#done").boundingBox();
      const status = await p.locator("#status").boundingBox();
      await p.mouse.move(done.x + done.width / 2, done.y + done.height / 2);
      await p.mouse.down();
      await p.waitForTimeout(700);                       // held: it pulses
      assert.ok(await p.locator("#done.moving").count(), "the pill is in moving mode");
      // Across the status line's text, to the left side.
      for (let i = 1; i <= 10; i++) await p.mouse.move(done.x - (done.x - status.x) * i / 10, status.y + status.height / 2 + i * 10);
      await p.mouse.up();
      assert.equal(await p.evaluate(() => String(getSelection())), "", "text was selected");
      // A phone's long-press selection can't be made in a desktop browser, so
      // what stops it is checked instead: nothing on the page is selectable
      // and nothing shows the long-press menu — except the hidden field the
      // keyboard types into, which iOS won't type into otherwise.
      const sel = await p.evaluate(() => ["back", "done", "status", "hint", "kbd"].map(id => {
        const s = getComputedStyle(document.getElementById(id));
        return [id, s.webkitUserSelect || s.userSelect, s.webkitTouchCallout ?? "none"];
      }));
      for (const [id, us, callout] of sel) {
        if (id === "kbd") assert.notEqual(us, "none", "the keyboard's field must stay typable");
        else { assert.equal(us, "none", `${id} is selectable`); assert.equal(callout, "none", `${id} shows the long-press menu`); }
      }
      const after = await p.locator("#done").boundingBox();
      assert.ok(after.x < done.x - 50, `the pill moved (${done.x} → ${after.x})`);
    } finally { await browser.close(); }
  });
});

// Drag from the phone (a slider check, OLX 2026-10-13): hold, then move —
// sent as one drag with the finger's path. A quick swipe still scrolls.
describe("dragging from the phone", chrome ? {} : { skip: "needs Google Chrome installed" }, () => {
  test("a note with a frame (a passkey cancelled on the Mac) shows as text, once", async () => {
    const { chromium } = createRequire(new URL("../agent/package.json", import.meta.url))("playwright-core");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const p = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
      await p.addInitScript(() => { window.WebSocket = class { constructor() { window.__ws = this; this.readyState = 1; setTimeout(() => this.onopen && this.onopen(), 10); } send() {} close() {} }; });
      await p.route("**/*", r => r.fulfill({ contentType: "text/html", body: viewerPage() }));
      await p.goto("http://viewer.test/t/x");
      await p.waitForFunction(() => !!window.__ws && !!window.__ws.onmessage);
      const note = "Your Mac asked for a passkey <b>x</b>, so I cancelled it.";
      await p.evaluate(n => window.__ws.onmessage({ data: JSON.stringify({ t: "frame", b64: "", w: 390, h: 844, fields: [], note: n }) }), note);
      const shown = await p.evaluate(() => [...document.querySelectorAll("body *")].map(e => e.textContent).find(t => t && t.startsWith("Your Mac asked")) || "");
      assert.equal(shown, note, "as text: no markup made of it");
      assert.equal(await p.evaluate(() => document.querySelectorAll("b").length), 0);
    } finally { await browser.close(); }
  });
  test("pasted text (a password from the phone's clipboard) goes to the Mac as text, once", async () => {
    const { chromium } = createRequire(new URL("../agent/package.json", import.meta.url))("playwright-core");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const p = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
      await p.addInitScript(() => { window.__sent = []; window.WebSocket = class { constructor() { window.__ws = this; this.readyState = 1; setTimeout(() => this.onopen && this.onopen(), 10); } send(d) { window.__sent.push(JSON.parse(d)); } close() {} }; });
      await p.route("**/*", r => r.fulfill({ contentType: "text/html", body: viewerPage() }));
      await p.goto("http://viewer.test/t/x");
      await p.waitForFunction(() => !!window.__ws && !!window.__ws.onmessage);
      await p.evaluate(() => { const k = document.getElementById("kbd"); k.focus(); const dt = new DataTransfer(); dt.setData("text/plain", "s3cret!Pass"); k.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); });
      await p.waitForTimeout(400);
      const texts = (await p.evaluate(() => window.__sent)).filter(m => m.kind === "text");
      assert.deepEqual(texts.map(m => m.text), ["s3cret!Pass"]);
    } finally { await browser.close(); }
  });
  test("the Paste button sends what's on the phone's clipboard as typed text", async () => {
    const { chromium } = createRequire(new URL("../agent/package.json", import.meta.url))("playwright-core");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const p = await ctx.newPage();
      // The phone's clipboard, stood in for (a test page isn't https).
      await p.addInitScript(() => { window.__sent = []; Object.defineProperty(navigator, "clipboard", { value: { readText: async () => "s3cret!Pass" } }); window.WebSocket = class { constructor() { window.__ws = this; this.readyState = 1; setTimeout(() => this.onopen && this.onopen(), 10); } send(d) { window.__sent.push(JSON.parse(d)); } close() {} }; });
      await p.route("**/*", r => r.fulfill({ contentType: "text/html", body: viewerPage() }));
      await p.goto("http://viewer.test/t/x");
      await p.waitForFunction(() => !!window.__ws && !!window.__ws.onmessage);
      await p.click("#paste");
      await p.waitForTimeout(300);
      const texts = (await p.evaluate(() => window.__sent)).filter(m => m.kind === "text");
      assert.deepEqual(texts.map(m => m.text), ["s3cret!Pass"]);
      const [back, paste, done] = await Promise.all(["#back", "#paste", "#done"].map(sel => p.locator(sel).boundingBox()));
      assert.ok(back.x + back.width <= paste.x && paste.x + paste.width <= done.x, "beside Back, clear of Done");
    } finally { await browser.close(); }
  });
  test("after Done, the phone says the tab can be closed — all of it, on screen", async () => {
    const { chromium } = createRequire(new URL("../agent/package.json", import.meta.url))("playwright-core");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const p = await (await browser.newContext({ viewport: { width: 375, height: 812 } })).newPage();
      await p.addInitScript(() => { window.WebSocket = class { constructor() { window.__ws = this; this.readyState = 1; setTimeout(() => this.onopen && this.onopen(), 10); } send() {} close() {} }; });
      await p.route("**/*", r => r.fulfill({ contentType: "text/html", body: viewerPage() }));
      await p.goto("http://viewer.test/t/x");
      await p.waitForFunction(() => !!window.__ws && !!window.__ws.onmessage);
      await p.evaluate(() => window.__ws.onmessage({ data: JSON.stringify({ t: "closed", why: "done" }) }));
      assert.match(await p.textContent("#status"), /close this tab/);
      const box = await p.locator("#status").boundingBox();
      const fits = await p.evaluate(() => { const e = document.getElementById("status"); return e.scrollWidth <= e.clientWidth; });
      assert.ok(box.x >= 0 && box.x + box.width <= 375 && fits, JSON.stringify(box));
    } finally { await browser.close(); }
  });
  test("hold then move sends a drag with the path; a quick swipe scrolls", async () => {
    const { chromium } = createRequire(new URL("../agent/package.json", import.meta.url))("playwright-core");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const p = await ctx.newPage();
      // A stand-in for the link's socket: records what the page sends, and gives it one frame.
      await p.addInitScript(() => {
        window.__sent = [];
        window.WebSocket = class { constructor() { window.__ws = this; this.readyState = 1; setTimeout(() => this.onopen && this.onopen(), 10); } send(d) { window.__sent.push(JSON.parse(d)); } close() {} };
      });
      await p.route("**/*", r => r.fulfill({ contentType: "text/html", body: viewerPage() }));
      await p.goto("http://viewer.test/t/x");
      await p.waitForFunction(() => !!window.__ws && !!window.__ws.onmessage);
      // A 1×1 JPEG is enough to lay the picture out; the page is 390×844 CSS px.
      const jpeg = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
      await p.evaluate(b64 => window.__ws.onmessage({ data: JSON.stringify({ t: "frame", b64, w: 390, h: 844, fields: [] }) }), jpeg);
      await p.waitForTimeout(300);
      const s = await ctx.newCDPSession(p);
      const touch = (type, x, y) => s.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
      // Hold, then slide right.
      await touch("touchStart", 60, 400); await p.waitForTimeout(450);
      for (let x = 80; x <= 300; x += 20) { await touch("touchMove", x, 402); await p.waitForTimeout(30); }
      await touch("touchEnd");
      // A quick upward swipe.
      await touch("touchStart", 200, 600);
      for (let y = 560; y >= 300; y -= 40) { await touch("touchMove", 200, y); await p.waitForTimeout(10); }
      await touch("touchEnd");
      await p.waitForTimeout(200);
      const sent = (await p.evaluate(() => window.__sent)).filter(m => m.kind !== "viewport");
      const drag = sent.find(m => m.kind === "drag");
      assert.ok(drag, JSON.stringify(sent));
      assert.ok(drag.points.length >= 8, `${drag.points.length} points`);
      assert.ok(drag.points[0][0] < 80 && drag.points.at(-1)[0] >= 280, JSON.stringify([drag.points[0], drag.points.at(-1)]));
      assert.ok(drag.points.at(-1)[2] > drag.points[0][2], "the path carries its timing");
      assert.ok(sent.some(m => m.kind === "scroll"), "a quick swipe still scrolls: " + JSON.stringify(sent.map(m => m.kind)));
      assert.ok(!sent.some(m => m.kind === "tap"), "no stray tap: " + JSON.stringify(sent.map(m => m.kind)));
    } finally { await browser.close(); }
  });
});
