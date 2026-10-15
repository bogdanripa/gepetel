// /s/:token — a sign-in form on the phone (Phase 10): the password goes from
// the page straight to the Mac, once, and is never logged or kept.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

const signin = (await import("../dist/device/signin.js")).default;
// Made-up, built at runtime so secret scanners don't take it for a real one.
const FAKE_PW1 = ["fake", "pw", "1"].join("-");
const { bridge } = await import("../dist/device/takeover.js");

describe("the sign-in form", () => {
  const PORT = 3414;
  let server;
  const sent = [], logs = [];
  const origLog = console.log;
  before(async () => {
    const app = express();
    signin.registerSignInRoutes(app);
    server = http.createServer(app);
    await new Promise(r => server.listen(PORT, "127.0.0.1", r));
    bridge.toDevice = (device, m) => { sent.push([device, m]); return device !== "d_off"; };
    console.log = (...a) => { logs.push(a.join(" ")); };
  });
  after(() => { console.log = origLog; server.close(); });
  const path = url => new URL(url).pathname;
  const post = (p, body) => fetch(`http://127.0.0.1:${PORT}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("the page names the site, asks for what's needed, can't be framed or cached", async () => {
    const url = signin.mint({ job_id: "j_1", device_id: "d_1", site: "account.booking.com", username: "", needUser: true, ro: false });
    const r = await fetch(`http://127.0.0.1:${PORT}${path(url)}`);
    const html = await r.text();
    assert.equal(r.status, 200);
    assert.match(html, /Sign in on account\.booking\.com/);
    assert.match(html, /autocomplete="username"/);
    assert.match(html, /type="password"/);
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.equal(r.headers.get("cache-control"), "no-store");
    const pwOnly = signin.mint({ job_id: "j_2", device_id: "d_1", site: "x.test", username: "", needUser: false, ro: true });
    const h2 = await (await fetch(`http://127.0.0.1:${PORT}${path(pwOnly)}`)).text();
    assert.ok(!/autocomplete="username"/.test(h2));
    assert.match(h2, /Conectare pe x\.test/);
  });

  test("sent once to the Mac; never in a log; the link then ends", async () => {
    const url = signin.mint({ job_id: "j_3", device_id: "d_1", site: "olx.ro", username: "", needUser: true, ro: false });
    const r = await post(path(url), { username: "me@x.test", password: FAKE_PW1, remember: true });
    assert.equal(r.status, 200);
    assert.deepEqual(sent.at(-1), ["d_1", { t: "secret", job: "j_3", username: "me@x.test", password: FAKE_PW1, remember: true }]);
    assert.ok(!logs.some(l => l.includes(FAKE_PW1) || /me@x\.test/.test(l)), JSON.stringify(logs));
    assert.equal((await post(path(url), { password: "again" })).status, 410, "one use");
    assert.equal((await fetch(`http://127.0.0.1:${PORT}${path(url)}`)).status, 410);
  });

  test("a newer link for the job ends the older; no password, a bad token, an offline Mac", async () => {
    const a = signin.mint({ job_id: "j_4", device_id: "d_1", site: "a.test", username: "", needUser: true, ro: false });
    const b = signin.mint({ job_id: "j_4", device_id: "d_1", site: "a.test", username: "", needUser: true, ro: false });
    assert.equal((await fetch(`http://127.0.0.1:${PORT}${path(a)}`)).status, 410);
    assert.equal((await post(path(b), { username: "x" })).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/s/nope`)).status, 410);
    const off = signin.mint({ job_id: "j_5", device_id: "d_off", site: "a.test", username: "", needUser: false, ro: false });
    assert.equal((await post(path(off), { password: "p" })).status, 503);
    assert.equal((await post(path(off), { password: "p" })).status, 503, "still usable once the Mac is back");
  });
});

// The inline scripts must parse: an apostrophe in "That didn't work" once
// broke the English form's script, so it never sent (2026-10-15).
describe("the inline page scripts parse", () => {
  const scripts = html => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  test("sign-in, both languages", () => {
    for (const ro of [false, true]) for (const needUser of [false, true]) {
      const html = signin.page({ job_id: "j", device_id: "d", site: "it's.test", username: "o'neil", needUser, ro, expires: 0 });
      const s = scripts(html);
      assert.equal(s.length, 1);
      assert.doesNotThrow(() => new Function(s[0]), `ro=${ro} needUser=${needUser}`);
    }
  });
  test("takeover", async () => {
    const { page } = await import("../dist/device/takeover.js");
    const s = scripts(page());
    assert.ok(s.length >= 1);
    for (const x of s) assert.doesNotThrow(() => new Function(x));
  });
});
