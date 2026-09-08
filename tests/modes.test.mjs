// Unit tests for the pure mode registry (src/modes.ts) and the signed settings
// links (src/settingsLink.ts). No DB, no network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import modes from "../dist/modes.js";
import links from "../dist/settingsLink.js";

describe("modes registry", () => {
  test("casual is the default and behaves as before modes existed", () => {
    const eff = modes.effectiveSettings(null);
    assert.equal(eff.mode, "casual");
    assert.equal(eff.unprompted, true);
    assert.equal(eff.gatekeeper, "relaxed");
    assert.equal(eff.watchesTasks, false);
    assert.equal(eff.taskIntake, "off");
  });
  test("a stored unknown mode falls back to casual instead of failing", () => {
    assert.equal(modes.modeById("banana").id, "casual");
    assert.equal(modes.effectiveSettings({ mode: "banana" }).mode, "casual");
    assert.equal(modes.isModeId("banana"), false);
  });
  test("work never starts conversations, is strict, and watches for tasks (ask)", () => {
    const eff = modes.effectiveSettings({ mode: "work" });
    assert.equal(eff.unprompted, false);
    assert.equal(eff.gatekeeper, "strict");
    assert.equal(eff.watchesTasks, true);
    assert.equal(eff.taskIntake, "ask");
  });
  test("overrides beat the mode's defaults; null means the default", () => {
    assert.equal(modes.effectiveSettings({ mode: "work", unprompted: true }).unprompted, true);
    assert.equal(modes.effectiveSettings({ mode: "casual", unprompted: false }).unprompted, false);
    assert.equal(modes.effectiveSettings({ mode: "work", unprompted: null }).unprompted, false);
    assert.equal(modes.effectiveSettings({ mode: "work", taskIntake: "auto" }).taskIntake, "auto");
    assert.equal(modes.effectiveSettings({ mode: "work", taskIntake: "nonsense" }).taskIntake, "ask");
  });
  test("task intake off switches the watcher off entirely", () => {
    assert.equal(modes.effectiveSettings({ mode: "work", taskIntake: "off" }).watchesTasks, false);
  });
  test("parseModeName reads how people say it, whole words only", () => {
    assert.equal(modes.parseModeName("pune-te pe business"), "work");
    assert.equal(modes.parseModeName("Work mode please"), "work");
    assert.equal(modes.parseModeName("back to casual"), "casual");
    assert.equal(modes.parseModeName("the network is down"), null);
    assert.equal(modes.parseModeName(""), null);
  });
  test("every mode has a persona prompt file", async () => {
    const fs = await import("node:fs");
    for (const m of modes.MODES) assert.ok(fs.existsSync(`prompts/modes/${m.id}.txt`), `prompts/modes/${m.id}.txt`);
  });
  test("the mode-changed line is in the group's language", () => {
    const work = modes.modeById("work");
    assert.match(modes.modeChangedMessage("Romanian", work), /modul Work/);
    assert.match(modes.modeChangedMessage("English", work), /Work mode/);
    assert.match(modes.modeChangedMessage("English", work, "Ana"), /Ana set it/);
  });
});

describe("settings links", () => {
  const secret = "test-secret";
  const chatId = "120363012345678901@g.us";

  test("a signed token verifies and carries the group id", () => {
    const t = links.signSettingsToken(chatId, secret, 1000);
    const r = links.verifySettingsToken(t, secret, 2000);
    assert.deepEqual(r, { ok: true, chatId });
  });
  test("expires after the ttl", () => {
    const t = links.signSettingsToken(chatId, secret, 1000, 500);
    assert.equal(links.verifySettingsToken(t, secret, 1000 + 501).ok, false);
    assert.equal(links.verifySettingsToken(t, secret, 1000 + 501).reason, "expired");
  });
  test("a different secret, a tampered payload, or junk is refused", () => {
    const t = links.signSettingsToken(chatId, secret, 1000);
    assert.equal(links.verifySettingsToken(t, "other", 2000).reason, "bad-signature");
    const [payload, sig] = t.split(".");
    const tampered = Buffer.from(JSON.stringify({ c: "someone-else@g.us", e: 9e12 })).toString("base64url") + "." + sig;
    assert.equal(links.verifySettingsToken(tampered, secret, 2000).reason, "bad-signature");
    assert.equal(links.verifySettingsToken("garbage", secret, 2000).reason, "malformed");
    assert.equal(links.verifySettingsToken(payload + ".", secret, 2000).reason, "malformed");
    assert.equal(links.verifySettingsToken(undefined, secret, 2000).reason, "malformed");
  });
  test("no secret means nothing verifies and no link is issued", () => {
    assert.equal(links.verifySettingsToken("a.b", "", 2000).reason, "no-secret");
    assert.throws(() => links.signSettingsToken(chatId, "", 1000));
  });
});
