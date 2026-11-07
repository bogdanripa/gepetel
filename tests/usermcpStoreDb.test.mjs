// The OAuth store behind Gepetel's MCP server — set TEST_DATABASE_URL.
//
// What is tested is refusal. A token here stands for a WhatsApp account, so the
// interesting cases are all the ways someone might try to get one without
// holding the phone: replaying a code, exchanging it through a different app,
// bending the redirect, reusing a refresh token.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL (a throwaway DB) to run";
let s, mongoose;

const CHAT = "40799999994@s.whatsapp.net";
const REDIRECT = "http://127.0.0.1:51000/callback";
const VERIFIER = "v".repeat(64);
const CHALLENGE = crypto.createHash("sha256").update(VERIFIER, "ascii").digest("base64url");

before(async () => {
  if (skip) return;
  mongoose = (await import("mongoose")).default;
  await mongoose.connect(TEST_DB);
  s = (await import("../dist/usermcp/store.js")).default;
});
beforeEach(async () => {
  if (skip) return;
  for (const c of ["usermcpclients", "usermcplogins", "usermcpauthcodes", "usermcptokens"]) {
    await mongoose.connection.collection(c).deleteMany({ chat_id: CHAT });
  }
});
after(async () => { if (!skip) await mongoose.disconnect(); });

const client = () => s.registerClient({ client_name: "test", redirect_uris: [REDIRECT] });
const codeFor = async (c) => s.issueAuthCode({ client_id: c.client_id, chat_id: CHAT, redirect_uri: REDIRECT, code_challenge: CHALLENGE });

test("a code exchanges once, for the person who proved their number", { skip }, async () => {
  const c = await client();
  const code = await codeFor(c);
  const first = await s.consumeAuthCode(code, { client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER });
  assert.equal(first?.chat_id, CHAT);
  const second = await s.consumeAuthCode(code, { client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER });
  assert.equal(second, null, "a replayed code is worth nothing");
});

test("a code is useless to another app, another redirect, or without the verifier", { skip }, async () => {
  const c = await client();
  const other = await s.registerClient({ client_name: "someone else", redirect_uris: [REDIRECT] });

  assert.equal(await s.consumeAuthCode(await codeFor(c),
    { client_id: other.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER }), null, "stolen by another client");
  assert.equal(await s.consumeAuthCode(await codeFor(c),
    { client_id: c.client_id, redirect_uri: "http://127.0.0.1:51000/evil", code_verifier: VERIFIER }), null, "bent redirect");
  assert.equal(await s.consumeAuthCode(await codeFor(c),
    { client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: "w".repeat(64) }), null, "wrong verifier");
  assert.equal(await s.consumeAuthCode("not-a-code",
    { client_id: c.client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER }), null, "invented code");
});

test("a token names its owner; a revoked one names nobody", { skip }, async () => {
  const c = await client();
  const { access_token } = await s.issueTokens({ client_id: c.client_id, chat_id: CHAT });
  assert.equal((await s.tokenOwner(access_token))?.chat_id, CHAT);
  assert.equal(await s.tokenOwner("made-up"), null);
  await s.revokeAllFor(CHAT);
  assert.equal(await s.tokenOwner(access_token), null, "revoked");
});

test("refreshing rotates, and the old refresh token dies with it", { skip }, async () => {
  const c = await client();
  const first = await s.issueTokens({ client_id: c.client_id, chat_id: CHAT });
  const second = await s.refreshTokens(first.refresh_token, c.client_id);
  assert.ok(second?.access_token && second.access_token !== first.access_token);
  assert.equal((await s.tokenOwner(second.access_token))?.chat_id, CHAT);
  assert.equal(await s.refreshTokens(first.refresh_token, c.client_id), null, "a refresh token is single use");
  assert.equal(await s.refreshTokens(second.refresh_token, "another-client"), null, "and belongs to its client");
});

test("the WhatsApp code: right once, and dead after five wrong ones", { skip }, async () => {
  const c = await client();
  const login_id = await s.startLogin({ client_id: c.client_id, redirect_uri: REDIRECT, state: "xyz", code_challenge: CHALLENGE });
  await s.putLoginCode(login_id, "40799999994", "123456");
  assert.deepEqual(await s.checkLoginCode(login_id, "000000"), { ok: false, dead: false });
  assert.deepEqual(await s.checkLoginCode(login_id, "123456"), { ok: true, dead: false }, "the real code still works");
  for (let i = 0; i < 4; i++) await s.checkLoginCode(login_id, "000000");
  const spent = await s.checkLoginCode(login_id, "123456");
  assert.equal(spent.ok, false, "six digits must not be guessable forever");
  assert.equal(spent.dead, true);
});

// The caps. Anyone may ask Gepetel for a login code — that is the growth path —
// which makes this endpoint a way to send a WhatsApp to a number somebody typed
// in. Every OTP service is that; these bounds are the whole design, and the
// global one is what stops a bad week becoming a banned WhatsApp number.
test("codes are capped per number, per source, and overall", { skip }, async () => {
  const log = mongoose.connection.collection("usermcpsendlogs");
  const PHONE = "40799999995", IP = "198.51.100.7";
  await log.deleteMany({ key: { $in: [`phone:${PHONE}`, `ip:${IP}`, "global"] } });

  assert.deepEqual(await s.checkCodeLimits(PHONE, IP), { ok: true }, "a first code is fine");

  // Three to one number in a day, then that number is left alone.
  for (let i = 0; i < 3; i++) await s.noteCodeSent(PHONE, IP);
  assert.deepEqual(await s.checkCodeLimits(PHONE, IP), { ok: false, reason: "phone" });
  // ...but a different number from the same place still works, until the
  // per-source cap bites.
  assert.deepEqual(await s.checkCodeLimits("40799999996", IP), { ok: true });

  for (let i = 0; i < 7; i++) await s.noteCodeSent(`4079999999${i}`, IP);
  assert.deepEqual(await s.checkCodeLimits("40799999997", IP), { ok: false, reason: "ip" },
    "ten from one source in an hour is enough");
  // A different source is not held back by someone else's spree, as long as
  // the global ceiling has room.
  assert.deepEqual(await s.checkCodeLimits("40799999998", "203.0.113.9"), { ok: true });

  // Old sends do not count: the windows are rolling, not cumulative.
  await log.updateMany({ key: `phone:${PHONE}` }, { $set: { at: new Date(Date.now() - 26 * 60 * 60 * 1000) } });
  assert.deepEqual(await s.checkCodeLimits(PHONE, "203.0.113.10"), { ok: true }, "yesterday's codes are spent");

  await log.deleteMany({ key: { $in: [`phone:${PHONE}`, `ip:${IP}`, "global"] } });
});
