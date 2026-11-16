// GEP-69: the backoff schedule and the health/exit decision, with an injected
// clock — no database, no waiting.
import { test } from "node:test";
import assert from "node:assert/strict";
import h from "../dist/dbHealth.js";

test("backoff: 2s, doubling, capped at 30s", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 50].map(h.backoffDelay), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(h.backoffDelay(0), 2000);
});

test("downSince: null while connected, kept from the first moment it was not", () => {
  assert.equal(h.nextDownSince(null, 1, 100), null);
  assert.equal(h.nextDownSince(50, 1, 100), null);         // reconnected
  assert.equal(h.nextDownSince(null, 0, 100), 100);        // a later disconnect starts the clock
  assert.equal(h.nextDownSince(50, 2, 100), 50);           // still connecting: clock keeps running
  assert.equal(h.nextDownSince(50, 0, 100), 50);
});

test("assess: healthy while connected", () => {
  assert.deepEqual(h.assessDb(null, 1e9), { healthy: true, exit: false, downForMs: 0 });
});

test("assess: healthy for up to the grace period, then 503 and exit", () => {
  const boot = 1_000_000;
  assert.equal(h.DB_GRACE_MS, 120_000);
  assert.deepEqual(h.assessDb(boot, boot + 5_000), { healthy: true, exit: false, downForMs: 5_000 });
  assert.deepEqual(h.assessDb(boot, boot + 120_000), { healthy: true, exit: false, downForMs: 120_000 });
  assert.deepEqual(h.assessDb(boot, boot + 120_001), { healthy: false, exit: true, downForMs: 120_001 });
  assert.equal(h.assessDb(boot, boot + 10, 5).exit, true);   // grace is injectable
});

test("assess: a clock that went backwards is not a long outage", () => {
  assert.deepEqual(h.assessDb(1000, 500), { healthy: true, exit: false, downForMs: 0 });
});

test("redact: a connection string never survives into a log line", () => {
  // Built from parts so secret scanners do not read a fake test password as a leaked one.
  const fakeUrl = ["mongodb+srv:/", "/user:", "s3cret", "@cluster0.x.mongodb.net/db?retryWrites=true"].join("");
  const msg = h.redactDbError(`Invalid scheme in ${fakeUrl} now`);
  assert.ok(!msg.includes("s3cret"));
  assert.ok(msg.includes("<database url>"));
  assert.equal(h.redactDbError("querySrv ESERVFAIL _mongodb._tcp.cluster0.x.mongodb.net"), "querySrv ESERVFAIL _mongodb._tcp.cluster0.x.mongodb.net");
  assert.equal(h.redactDbError(undefined), "");
});
