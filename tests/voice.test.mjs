// Phone calls (voice.ts): the parts that decide and assemble, with no call,
// no socket and no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import OpenAI from "openai";
import v from "../dist/voice.js";

test("numbers: +40, 0040, 40 and the national 07 form are one person", () => {
  for (const raw of ["+40722123456", "0040722123456", "40722123456", "0722123456", "+40 722 123 456", "tel:+40722123456", "sip:+40722123456@sip.example.com;user=phone"]) {
    assert.equal(v.normalizeNumber(raw), "40722123456", raw);
  }
  assert.equal(v.normalizeNumber("0722123456", "39"), "39722123456");
  assert.equal(v.normalizeNumber("anonymous"), "");
  assert.equal(v.normalizeNumber("sip:anonymous@anonymous.invalid"), "");
  assert.equal(v.normalizeNumber("123"), "");
});

test("caller: P-Asserted-Identity wins over From; From is used when it's alone", () => {
  const from = { name: "From", value: '"Ana" <sip:+40722000111@pstn.twilio.com>;tag=abc' };
  const pai = { name: "P-Asserted-Identity", value: "<sip:+40733000222@pstn.twilio.com>" };
  assert.equal(v.callerDigits([from, pai, { name: "To", value: "<sip:proj@sip.api.openai.com>" }]), "40733000222");
  assert.equal(v.callerDigits([from]), "40722000111");
  assert.equal(v.callerDigits([{ name: "from", value: "<sip:0722000111@x>" }]), "40722000111");
  assert.equal(v.callerDigits([{ name: "From", value: "<sip:anonymous@anonymous.invalid>" }]), "");
  assert.equal(v.callerDigits([]), "");
});

test("allowed callers: a list, '*' for any known user, nobody when unset", () => {
  assert.equal(v.callerAllowed("40722000111", {}), false);
  assert.equal(v.callerAllowed("40722000111", { VOICE_CALLERS: "" }), false);
  assert.equal(v.callerAllowed("40722000111", { VOICE_CALLERS: "+40722000111, 40733000222" }), true);
  assert.equal(v.callerAllowed("40722000111", { VOICE_CALLERS: "0722000111" }), true);
  assert.equal(v.callerAllowed("40744000333", { VOICE_CALLERS: "40722000111" }), false);
  assert.equal(v.callerAllowed("40744000333", { VOICE_CALLERS: "*" }), true);
  assert.equal(v.callerAllowed("", { VOICE_CALLERS: "*" }), false);
});

test("decide: off, unknown, not allowed, busy and over the limit are turned away", () => {
  const ok = { enabled: true, digits: "40722000111", allowed: true, knownUser: true, busy: false, quotaAllowed: true };
  assert.deepEqual(v.decide(ok), { accept: true });
  assert.equal(v.decide({ ...ok, enabled: false }).accept, false);
  assert.equal(v.decide({ ...ok, digits: "" }).status, 403);
  assert.equal(v.decide({ ...ok, allowed: false }).status, 403);
  assert.equal(v.decide({ ...ok, knownUser: false }).status, 403);
  assert.equal(v.decide({ ...ok, busy: true }).status, 486);
  assert.equal(v.decide({ ...ok, quotaAllowed: false }).status, 486);
});

test("instructions: the phone prompt, their name and language, now, and their card", () => {
  const s = v.instructions({ author: "Ana Pop", language: "Romanian", timezone: "Europe/Bucharest", aboutThem: "[About them] likes tea", now: new Date("2026-11-17T10:00:00Z") });
  assert.match(s, /phone call with Ana Pop/);
  assert.match(s, /Speak Romanian/);
  assert.match(s, /ask_gepetel/);
  assert.match(s, /end_call/);
  assert.match(s, /\[Context\] Right now it is/);
  assert.match(s, /likes tea/);
  assert.doesNotMatch(s, /\{\{/);
});

test("ask note: says it's read aloud and carries the call so far", () => {
  const n = v.askNote("ce am mâine?", [{ who: "them", text: "salut" }, { who: "gepetel", text: "Salut, spune" }]);
  assert.match(n, /phone call/);
  assert.match(n, /Them: salut/);
  assert.match(n, /You: Salut, spune/);
  assert.ok(n.endsWith("\nce am mâine?"));
});

test("transcript: a header with the length, both sides, and the newest kept when long", () => {
  const start = new Date("2026-11-17T10:00:00Z"), end = new Date("2026-11-17T10:04:10Z");
  const t = v.transcript([{ who: "them", text: "ce am mâine?" }, { who: "gepetel", text: "O ședință la 10." }], start, end, "Europe/Bucharest");
  assert.match(t, /^\[Phone call with them, .*4 min\]/);
  assert.match(t, /Them: ce am mâine\?\nYou: O ședință la 10\./);
  const long = v.transcript(Array.from({ length: 400 }, (_, i) => ({ who: "them", text: `line ${i}` })), start, end, "UTC", 200);
  assert.match(long, /line 399$/);
  assert.ok(long.length < 300);
  assert.match(v.transcript([], start, end, "UTC"), /nothing was said/);
});

// Signed the way OpenAI signs (standard webhooks), checked by the SDK the
// handler uses — so a bad signature is refused before anything is read.
function sign(secret, id, ts, body) {
  const key = Buffer.from(secret.replace("whsec_", ""), "base64");
  return "v1," + crypto.createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}

test("webhook: a bad signature is a 400, a good one for another event is a 200 and takes no call", async () => {
  const secret = "whsec_" + Buffer.from("test-secret-0123456789").toString("base64");
  const client = new OpenAI({ apiKey: "sk-test" });
  let asked = 0;
  const deps = { client, lookup: async () => { asked++; return { known: true, author: "", language: "Romanian", timezone: "UTC", aboutThem: "" }; }, claimQuota: async () => true, ask: async () => "", remember: async () => {} };
  const env = { VOICE_ENABLED: "1", OPENAI_WEBHOOK_SECRET: secret, VOICE_CALLERS: "*" };
  const body = JSON.stringify({ object: "event", id: "evt_1", type: "live.call.incoming", created_at: 1, data: { session_id: "rtc_1", sip_headers: [] } });
  const ts = String(Math.floor(Date.now() / 1000));
  assert.equal(await v.handleWebhook(body, { "webhook-id": "wh_1", "webhook-timestamp": ts, "webhook-signature": "v1,AAAA" }, deps, env), 400);
  assert.equal(await v.handleWebhook(body, { "webhook-id": "wh_2", "webhook-timestamp": ts, "webhook-signature": sign(secret, "wh_2", ts, body) }, deps, env), 200);
  assert.equal(asked, 0);
});
