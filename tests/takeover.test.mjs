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
