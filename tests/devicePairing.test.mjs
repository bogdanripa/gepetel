// Pairing's rate limit: keyed on a source the client can't choose, and held
// by a ceiling across all sources.
import { test } from "node:test";
import assert from "node:assert/strict";

const routes = (await import("../dist/device/routes.js")).default;
const req = (h, ip = "10.0.0.2") => ({ get: k => h[k.toLowerCase()], ip });

test("the source is Cloudflare's, else the hop our proxy added — never the client's leftmost", () => {
  assert.equal(routes.sourceOf(req({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4, 198.51.100.1" })), "203.0.113.9");
  assert.equal(routes.sourceOf(req({ "x-forwarded-for": "1.2.3.4, 198.51.100.1" })), "198.51.100.1");
  assert.equal(routes.sourceOf(req({})), "10.0.0.2");
});

test("past the global ceiling, pairing waits out the minute", () => {
  const t0 = 1_000_000_000_000;
  assert.equal(routes.globalPairingLocked(t0), false);
  for (let i = 0; i < routes.PAIR_FAILURES_PER_MINUTE; i++) routes.noteGlobalPairingFailure(t0 + i);
  assert.equal(routes.globalPairingLocked(t0 + 100), true);
  assert.equal(routes.globalPairingLocked(t0 + 60_001), false);
});
