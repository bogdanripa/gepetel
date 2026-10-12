// The Mac's half of the takeover link: frames only on change, under budget;
// inputs only in their shapes, text as data.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Takeover, jpegSize, BYTES_PER_SECOND } from "../dist/takeover.js";

// A minimal JPEG header: SOI, then SOF0 with 720×405.
const jpeg = (w, h, pad = 0) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3]), Buffer.alloc(pad)]);

describe("frames", () => {
  test("a JPEG's size is read from its header", () => {
    assert.deepEqual(jpegSize(jpeg(720, 405)), { w: 720, h: 405 });
    assert.equal(jpegSize(Buffer.from("not a jpeg")), null);
  });
  test("an unchanged screen sends nothing; a changed one sends one frame", async () => {
    let shot = jpeg(720, 405, 10).toString("base64");
    const sent = [];
    const t = new Takeover(async tool => tool === "browser_take_screenshot" ? { content: [{ type: "image", data: shot, mimeType: "image/jpeg" }] } : { content: [] },
      f => sent.push(f), async b => b);
    await t.start();
    await new Promise(r => setTimeout(r, 700));
    assert.equal(sent.length, 1, "same picture, one frame");
    shot = jpeg(720, 405, 20).toString("base64");
    await new Promise(r => setTimeout(r, 400));
    t.stop();
    assert.equal(sent.length, 2);
    assert.deepEqual([sent[1].w, sent[1].h], [720, 405]);
  });
  test("frames never exceed the byte budget, however fast the screen changes", async () => {
    let n = 0, clock = 0;
    const big = Math.floor(BYTES_PER_SECOND / 2);   // two frames per second at most
    const sent = [];
    const t = new Takeover(async () => ({ content: [{ type: "image", data: jpeg(720, 405, big + (n++ % 2)).toString("base64") }] }),
      f => sent.push(f), async b => b, () => clock);
    await t.start();
    for (let i = 0; i < 40; i++) { clock += 250; await new Promise(r => setTimeout(r, 260)); }
    t.stop();
    const bytes = sent.reduce((s, f) => s + Buffer.from(f.b64, "base64").length, 0);
    assert.ok(bytes <= BYTES_PER_SECOND * 11, `${bytes} bytes over 10 seconds`);
    assert.ok(sent.length >= 10, `${sent.length} frames — the budget throttles, it does not stop`);
  });
});

describe("typing", () => {
  test("inputs are applied strictly in the order they arrived, even when one is slow", async () => {
    const done = [];
    const t = new Takeover(async (tool, a) => {
      if (tool === "browser_run_code_unsafe") { await new Promise(r => setTimeout(r, a.code.includes('"ab"') ? 120 : 5)); done.push(a.code.match(/insertText\((.*)\)/)[1]); }
      if (tool === "browser_press_key") done.push(a.key);
      return { content: [] };
    }, () => {});
    await Promise.all([t.input({ kind: "text", text: "ab" }), t.input({ kind: "key", key: "Backspace" }), t.input({ kind: "text", text: "c" })]);
    assert.deepEqual(done, ['"ab"', "Backspace", '"c"']);
  });
});

describe("a stuck screenshot", () => {
  test("never freezes the stream: it times out and the next tick tries again", async () => {
    let calls = 0;
    const sent = [];
    const t = new Takeover(async tool => {
      if (tool !== "browser_take_screenshot") return { content: [] };
      calls++;
      if (calls === 1) return new Promise(() => {});   // hangs, like a background tab
      return { content: [{ type: "image", data: jpeg(720, 405, calls).toString("base64") }] };
    }, f => sent.push(f), async b => b);
    await t.start();
    await new Promise(r => setTimeout(r, 6500));
    t.stop();
    assert.ok(calls >= 2, `${calls} screenshot calls`);
    assert.ok(sent.length >= 1, "a frame got through after the stuck one");
  });
});

describe("inputs", () => {
  test("each kind maps to one tool call, text as JSON data, nonsense dropped", async () => {
    const calls = [];
    // The field lookup that follows each input (browser_snapshot) is not an input.
    const t = new Takeover(async (tool, a) => { if (tool !== "browser_snapshot") calls.push([tool, a]); return { content: [] }; }, () => {});
    await t.input({ kind: "tap", x: 400.4, y: 300.6 });
    await t.input({ kind: "text", text: "a`b${c}\"d" });
    await t.input({ kind: "key", key: "Enter" });
    await t.input({ kind: "key", key: "Meta+Q" });
    await t.input({ kind: "scroll", dy: 500 });
    await t.input({ kind: "tap", x: -5, y: 10 });
    await t.input({ kind: "eval", code: "1" });
    assert.deepEqual(calls[0], ["browser_mouse_click_xy", { x: 400, y: 301 }]);
    assert.equal(calls[1][0], "browser_run_code_unsafe");
    assert.ok(calls[1][1].code.includes(JSON.stringify("a`b${c}\"d")), calls[1][1].code);
    assert.deepEqual(calls[2], ["browser_press_key", { key: "Enter" }]);
    assert.deepEqual(calls[3], ["browser_mouse_wheel", { deltaX: 0, deltaY: 500 }]);
    assert.equal(calls.length, 4, "the bad key, the off-screen tap and the unknown kind did nothing");
  });
});

// A real Mac, 2026-10-12: the takeover streamed a blank tab Playwright had
// opened after losing the job's tab, and its "select" of a closed tab failed.
describe("which tab is streamed", () => {
  test("not a blank tab Playwright calls current, when the job's real tab is there; a stale list is read again", async () => {
    const calls = []; let lists = 0;
    const list = () => ++lists === 1
      ? "### Open tabs\n- 0: (current) [](about:blank)\n- 1: [Old](https://www.olx.ro/)"            // stale: tab 1 is gone
      : "### Open tabs\n- 0: (current) [](about:blank)\n- 1: [Conectare](https://login.olx.ro/?x=1)";
    let selects = 0;
    const t = new Takeover(async (tool, a) => {
      calls.push([tool, a.action, a.index]);
      if (tool === "browser_tabs" && a.action === "list") return { content: [{ type: "text", text: list() }] };
      if (tool === "browser_tabs" && a.action === "select") return ++selects === 1 ? { isError: true, content: [{ type: "text", text: "Target page, context or browser has been closed" }] } : { content: [] };
      return { content: [] };
    }, () => {}, async b => b);
    await t.start(); t.stop();
    const tabCalls = calls.filter(c => c[0] === "browser_tabs").map(c => `${c[1]}${c[2] ?? ""}`);
    assert.deepEqual(tabCalls.slice(0, 5), ["list", "select1", "list", "select1", "close0"], JSON.stringify(tabCalls));
  });
  test("a normal current tab is just brought to the front", async () => {
    const calls = [];
    const t = new Takeover(async (tool, a) => {
      if (tool === "browser_tabs") calls.push(`${a.action}${a.index ?? ""}`);
      return tool === "browser_tabs" && a.action === "list" ? { content: [{ type: "text", text: "- 0: [Home](https://x.ro/)\n- 1: (current) [Sign in](https://x.ro/login)" }] } : { content: [] };
    }, () => {}, async b => b);
    await t.start(); t.stop();
    assert.deepEqual(calls.slice(0, 3), ["list", "list", "select1"]);
  });
});
