// PKCE verification for Gepetel's own MCP server.
//
// This is the proof that the client exchanging an authorization code is the
// client that started the flow. The code travels through a browser redirect and
// can land in logs, history and whatever the OS does with a custom URL — so if
// this check is weak, a leaked code is an account.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
const { verifyPkce } = await import("../dist/usermcp/store.js");

const challengeFor = (verifier) => crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
const VERIFIER = "a".repeat(43);

test("the real verifier passes, and nothing else does", () => {
  assert.equal(verifyPkce(VERIFIER, challengeFor(VERIFIER)), true);

  assert.equal(verifyPkce("b".repeat(43), challengeFor(VERIFIER)), false, "a different verifier");
  assert.equal(verifyPkce(VERIFIER, challengeFor("b".repeat(43))), false, "a different challenge");
  assert.equal(verifyPkce("", challengeFor(VERIFIER)), false);
  assert.equal(verifyPkce(VERIFIER, ""), false);

  // The challenge is NOT the verifier: a client that echoes back what it sent
  // proves only that it read the request, which anyone who saw it did.
  assert.equal(verifyPkce(challengeFor(VERIFIER), challengeFor(VERIFIER)), false, "plain method must not work");

  // RFC 7636 length and alphabet. A 20-character verifier is not a typo to
  // forgive, it is a weak proof.
  assert.equal(verifyPkce("short", challengeFor("short")), false, "too short");
  assert.equal(verifyPkce("a".repeat(129), challengeFor("a".repeat(129))), false, "too long");
  const bad = "a".repeat(42) + "+";
  assert.equal(verifyPkce(bad, challengeFor(bad)), false, "characters outside the unreserved alphabet");

  // Exactly at the boundaries, which is where off-by-one lives.
  const min = "a".repeat(43), max = "a".repeat(128);
  assert.equal(verifyPkce(min, challengeFor(min)), true, "43 is allowed");
  assert.equal(verifyPkce(max, challengeFor(max)), true, "128 is allowed");
});
