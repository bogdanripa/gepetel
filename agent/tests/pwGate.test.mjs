// pwGate.ts: nothing reaches Playwright while every tab of Gepetel's is taken
// (it would open a blank tab — the owner's about:blank, 2026-10-16).
import { test } from "node:test";
import assert from "node:assert/strict";
import { gated, allTaken, HELD } from "../dist/pwGate.js";

test("held while each tab is taken; through when one is back, or one is still attached, or no line", async () => {
  let taken = [{ tabId: 1, url: "https://btpay.example/" }];
  let tabs = [{ tabId: 1, url: "https://btpay.example/" }];
  const b = { connected: true, takenAway: async () => taken, tabs: async () => tabs };
  const sent = [], logs = [];
  const call = gated(async (t) => { sent.push(t); return { content: [{ type: "text", text: "ok" }] }; }, () => b, l => logs.push(l));
  const r = await call("browser_tabs", { action: "list" });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, HELD);
  await call("browser_snapshot", {});
  assert.deepEqual(sent, [], "nothing sent");
  assert.equal(logs.length, 1, "said once");
  tabs = [...tabs, { tabId: 2, url: "https://kept.example/" }];
  await call("browser_snapshot", {});
  assert.deepEqual(sent, ["browser_snapshot"], "another tab still attached: through");
  tabs = [{ tabId: 1, url: "x" }, { tabId: 3, url: "y", popup: true }];
  assert.equal(await allTaken(b), true, "a popup window isn't Playwright's tab");
  taken = [];
  await call("browser_tabs", { action: "list" });
  assert.deepEqual(sent, ["browser_snapshot", "browser_tabs"], "back: through");
  assert.equal(await allTaken({ ...b, connected: false }), false);
  assert.equal(await allTaken(null), false);
});
