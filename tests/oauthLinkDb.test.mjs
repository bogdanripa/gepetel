// The short login link's lookup, against a real database — set TEST_DATABASE_URL.
//
// A WhatsApp message is a bad place for a 1600-character URL: one reached a
// phone intact and was cut at character 455 on the way to the browser, leaving
// "https://www.googleapis" as a scope and Google refusing the lot. People now
// get /c/<state>, so what matters is that the state resolves to the real URL
// while the login is pending, and to nothing once it is not.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL (a throwaway DB) to run";
let m, mongoose;
const STATE = "test-state-aaaaaaaaaaaaaaaaaaaaaaaa";
const LONG = "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=x&scope="
  + encodeURIComponent(["https://mail.google.com/", "https://www.googleapis.com/auth/gmail.modify"].join(" "));

const pending = () => mongoose.connection.collection("mcpoauthpendings");
before(async () => {
  if (skip) return;
  mongoose = (await import("mongoose")).default;
  await mongoose.connect(TEST_DB);
  m = (await import("../dist/mongo.js")).default;
});
beforeEach(async () => { if (!skip) await pending().deleteMany({ state: STATE }); });
after(async () => { if (!skip) { await pending().deleteMany({ state: STATE }); await mongoose.disconnect(); } });

test("a pending login resolves its state to the full authorize url", { skip }, async () => {
  await pending().insertOne({ state: STATE, chat_id: "4079@s.whatsapp.net", requester: "4079", label: "Gmail",
    server_url_sealed: "x", resource: "r", token_endpoint: "t", client_id: "c", authorize_url: LONG, createdAt: new Date() });
  const got = await m.pendingAuthorizeUrl(STATE);
  assert.equal(got, LONG);
  assert.ok(got.length > `https://gepetel.com/c/${STATE}`.length * 3, "the point is that the real one is far longer");
});

test("an unknown, expired or already-finished state resolves to nothing", { skip }, async () => {
  assert.equal(await m.pendingAuthorizeUrl(STATE), "", "never started");
  assert.equal(await m.pendingAuthorizeUrl(""), "", "no state at all");
  // A row from before this field existed must not resolve to a broken redirect.
  await pending().insertOne({ state: STATE, chat_id: "4079@s.whatsapp.net", requester: "4079", label: "Gmail",
    server_url_sealed: "x", resource: "r", token_endpoint: "t", client_id: "c", createdAt: new Date() });
  assert.equal(await m.pendingAuthorizeUrl(STATE), "", "a pending login with no stored url");
});
