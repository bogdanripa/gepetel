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


// The phone's size no longer resizes the page (phone or desktop is Gepetel's
// window size now): the emulation was dropped whenever Chrome took the tab,
// and the page flipped between phone and desktop on a real Mac.
describe("the phone's size", () => {
  test("is not applied to the page", async () => {
    const calls = [];
    const t = new Takeover(async (tool, a) => { calls.push(tool === "browser_run_code_unsafe" ? a.code : tool); return { content: [] }; }, () => {});
    await t.input({ kind: "viewport", w: 390, h: 844 });
    assert.ok(!calls.some(c => /setViewportSize/.test(c)), JSON.stringify(calls));
  });
});

// A tab Chrome took from the debugger (iCloud Passwords' frame on a sign-in
// page): the extension's clicks aren't gestures, so "Sign in with Google" did
// nothing from the phone (2026-10-14). Real input from macOS, by the app.
describe("real input from macOS, through the app", () => {
  const fakeBridge = (log) => ({
    connected: true,
    window: async (tabId, w, h) => { log.push(["window", tabId, w, h]); return { window: [1470, 923], page: [1470, 780, 1470] }; },
    input: async (tabId, m) => { log.push(["extension", m.kind]); return "clicked"; },
    tabs: async () => [{ tabId: 7, url: "https://www.booking.com/", windowId: 1, active: false }, { tabId: 42, url: "https://account.booking.com/sign-in?op=x", windowId: 1, active: true }],
    fields: async () => [], capture: async () => ({ b64: "", w: 1470, h: 780 }),
  });
  test("a tap on a taken tab goes to the app with what it needs to find the spot", async () => {
    const log = [], asked = [];
    const t = new Takeover(async () => ({ content: [] }), () => {});
    t.bridge = fakeBridge(log);
    t.osInput = async req => { asked.push(req); return { ok: true, why: "" }; };
    t.viewSize = { width: 1280, height: 900 };
    t.useTab(42);
    await t.input({ kind: "tap", x: 325, y: 418 });
    assert.deepEqual(log, [], "no window set, and no extension click");
    assert.deepEqual(asked[0], { op: "tap", winW: 0, winH: 0, innerW: 1470, innerH: 780, url: "https://account.booking.com/sign-in?op=x", x: 325, y: 418 },
      "the page's size from its picture, with the tab's own address — the app finds the window by Gepetel's group");
    t.stop();
  });
  test("text and keys go as real keystrokes", async () => {
    const asked = [];
    const t = new Takeover(async () => ({ content: [] }), () => {});
    t.bridge = fakeBridge([]); t.osInput = async req => { asked.push(req.op + ":" + (req.text ?? req.key ?? "")); return { ok: true, why: "" }; };
    t.useTab(42);
    await t.input({ kind: "text", text: "ana@example.com" });
    await t.input({ kind: "key", key: "Enter" });
    assert.deepEqual(asked, ["text:ana@example.com", "key:Enter"]);
    t.stop();
  });
  test("without the permission it falls back to the extension — and stops asking the app", async () => {
    const log = []; let asks = 0;
    const t = new Takeover(async () => ({ content: [] }), () => {});
    t.bridge = fakeBridge(log);
    t.osInput = async () => { asks++; return { ok: false, why: "Gepetel isn't allowed to control this Mac (System Settings → Privacy & Security → Accessibility)" }; };
    t.useTab(42);
    await t.input({ kind: "tap", x: 1, y: 1 });
    await t.input({ kind: "tap", x: 2, y: 2 });
    assert.equal(asks, 1, "asked once");
    assert.deepEqual(log.filter(l => l[0] === "extension").length, 2, "both taps through the extension");
    t.stop();
  });
});

describe("a passkey window on the Mac", () => {
  test("is cancelled through the app, and the phone is told — with the same picture sent again", async () => {
    const shot = jpeg(720, 405, 10).toString("base64");
    const sent = [], asked = [];
    let found = "Use a saved passkey for google.com";
    const t = new Takeover(async tool => tool === "browser_take_screenshot" ? { content: [{ type: "image", data: shot, mimeType: "image/jpeg" }] } : { content: [] },
      f => sent.push(f), async b => b);
    t.osInput = async req => { asked.push(req.op); const f = found; found = ""; return { ok: true, why: "", found: f }; };
    await t.start();
    await new Promise(r => setTimeout(r, 700));
    t.stop();
    assert.ok(asked.includes("passkey"), "the app was asked");
    assert.equal(asked.filter(a => a === "passkey").length, 1, "at most every 2 s");
    assert.ok(sent.some(f => /passkey/.test(f.note || "") && /another way/.test(f.note)), JSON.stringify(sent.map(f => f.note)));
  });
  test("nothing found: no note", async () => {
    const sent = [];
    const t = new Takeover(async () => ({ content: [{ type: "image", data: jpeg(720, 405, 10).toString("base64"), mimeType: "image/jpeg" }] }), f => sent.push(f), async b => b);
    t.osInput = async () => ({ ok: true, why: "", found: "" });
    await t.start();
    await new Promise(r => setTimeout(r, 500));
    t.stop();
    assert.ok(sent.length >= 1 && sent.every(f => !f.note));
  });
});

describe("the channel to the app", () => {
  test("a request goes out as one @input line and is answered by its id", async () => {
    const { enableOsInput, osInput, osInputAnswer } = await import("../dist/osInput.js");
    const lines = [];
    enableOsInput(l => lines.push(l));
    const p = osInput({ op: "tap", x: 1, y: 2 });
    assert.match(lines[0], /^@input \{"op":"tap","x":1,"y":2,"id":"i\d+"\}$/);
    const id = JSON.parse(lines[0].slice(7)).id;
    assert.equal(osInputAnswer({ t: "input-done", id, ok: true, why: "" }), true);
    assert.deepEqual(await p, { ok: true, why: "" });
    assert.equal(osInputAnswer({ t: "stop-all" }), false, "other lines aren't its");
  });
});

describe("a window the person's tap opens, through the extension", () => {
  // booking.com's "Sign in with Google" opened Google's "Choose an account"
  // window; the phone kept showing the sign-in page (2026-10-14).
  test("shown next — through Playwright when it can see it", async () => {
    let tabs = [{ tabId: 42, url: "https://account.booking.com/sign-in", windowId: 1, active: true }];
    const calls = [];
    const t = new Takeover(async (tool, a) => {
      calls.push([tool, a.action, a.index]);
      if (tool === "browser_tabs" && a.action === "list") return { content: [{ type: "text", text: "### Result\n- 0: [Booking](https://www.booking.com/)\n- 1: (current) [Google](https://accounts.google.com/v3/signin/accountchooser)" }] };
      return { content: [] };
    }, () => {});
    t.bridge = { connected: true, tabs: async () => tabs, fields: async () => [], input: async () => "clicked", capture: async () => ({ b64: "", w: 900, h: 700 }) };
    t.osInput = async () => ({ ok: true, why: "" });
    t.useTab(42);
    await new Promise(r => setTimeout(r, 20));
    await t.input({ kind: "tap", x: 353, y: 447 });
    // The window comes up blank for a moment, then loads Google's page.
    tabs = [...tabs, { tabId: 43, url: "about:blank", windowId: 2, active: true }];
    await t.followLiteNewTab();
    assert.equal(t.liteTab, 42, "not before its page loaded");
    tabs = [tabs[0], { tabId: 43, url: "https://accounts.google.com/v3/signin/accountchooser", windowId: 2, active: true }];
    await t.followLiteNewTab();
    assert.ok(calls.some(c => c[0] === "browser_tabs" && c[1] === "select" && c[2] === 1), JSON.stringify(calls));
    assert.equal(t.liteTab, null, "back to Playwright for that tab");
    t.stop();
  });
  test("a tab that turns up with no tap before it isn't followed", async () => {
    let tabs = [{ tabId: 42, url: "https://account.booking.com/sign-in", windowId: 1, active: true }];
    const t = new Takeover(async () => ({ content: [] }), () => {});
    t.bridge = { connected: true, tabs: async () => tabs, fields: async () => [], input: async () => "", capture: async () => ({ b64: "", w: 900, h: 700 }) };
    t.useTab(42);
    await new Promise(r => setTimeout(r, 20));
    tabs = [...tabs, { tabId: 44, url: "https://www.tripit.com/app", windowId: 1, active: false }];
    await t.followLiteNewTab();
    assert.equal(t.liteTab, 42);
    t.stop();
  });
});
