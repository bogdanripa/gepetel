// Home-network addresses the person allowed (homeHosts.ts) and the guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HomeHosts, namedIn } from "../dist/homeHosts.js";
import { guardUrl } from "../dist/fetchUrl.js";

test("named in their own words — with its port, not inside another name", () => {
  assert.ok(namedIn("check http://homeassistant:8123/ for leaks", "homeassistant:8123"));
  assert.ok(namedIn("unblock homeassistant:8123 please", "homeassistant:8123"));
  assert.ok(namedIn("open 192.168.86.34:8123", "192.168.86.34:8123"));
  assert.ok(!namedIn("open myhomeassistant:8123", "homeassistant:8123"));
  assert.ok(!namedIn("check my home assistant", "homeassistant:8123"));
});

test("kept on disk, 0600; removed", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "home-")), "home-hosts.json");
  const h = new HomeHosts(f);
  h.add("HomeAssistant:8123");
  assert.ok(new HomeHosts(f).has("homeassistant:8123"));
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.ok(new HomeHosts(f).forget("homeassistant:8123"));
  assert.ok(!new HomeHosts(f).has("homeassistant:8123"));
});

test("the guard: a private address only when it's allowed — the exact host and port", async () => {
  const ok = h => h === "192.168.86.34:8123" || h === "homeassistant:8123";
  assert.ok("url" in await guardUrl("http://192.168.86.34:8123/lovelace", false, ok));
  assert.ok("why" in await guardUrl("http://192.168.86.34:8124/", false, ok), "another port");
  assert.ok("why" in await guardUrl("http://192.168.1.1/admin", false, ok), "a router page a site named");
  assert.ok("url" in await guardUrl("http://homeassistant:8123/", false, ok), "a bare home name");
  assert.ok("why" in await guardUrl("http://192.168.86.34:8123/"), "nothing allowed: refused as before");
});
