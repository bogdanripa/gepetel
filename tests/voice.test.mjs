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

// --- Calling back after a WhatsApp call -------------------------------------

const SECRET = "test-callback-secret";

test("call-back: a signed x-gepetel-for names the person; anything else is ignored", () => {
  const now = 1_800_000_000;
  const sig = v.callbackSig("40722123456", now, SECRET);
  const hs = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
  assert.equal(v.callbackFor(hs({ "X-Gepetel-For": "40722123456", "X-Gepetel-Ts": String(now), "X-Gepetel-Sig": sig }), SECRET, now + 30), "40722123456");
  // Lower-case names, as a carrier may send them.
  assert.equal(v.callbackFor(hs({ "x-gepetel-for": "40722123456", "x-gepetel-ts": String(now), "x-gepetel-sig": sig }), SECRET, now), "40722123456");
  // Expired, other number, wrong secret, no secret, tampered, missing.
  assert.equal(v.callbackFor(hs({ "x-gepetel-for": "40722123456", "x-gepetel-ts": String(now), "x-gepetel-sig": sig }), SECRET, now + 121), "");
  assert.equal(v.callbackFor(hs({ "x-gepetel-for": "40722999999", "x-gepetel-ts": String(now), "x-gepetel-sig": sig }), SECRET, now), "");
  assert.equal(v.callbackFor(hs({ "x-gepetel-for": "40722123456", "x-gepetel-ts": String(now), "x-gepetel-sig": sig }), "other", now), "");
  assert.equal(v.callbackFor(hs({ "x-gepetel-for": "40722123456", "x-gepetel-ts": String(now), "x-gepetel-sig": sig }), "", now), "");
  assert.equal(v.callbackFor(hs({ "x-gepetel-for": "40722123456", "x-gepetel-ts": String(now + 1), "x-gepetel-sig": sig }), SECRET, now), "");
  assert.equal(v.callbackFor(hs({ "x-gepetel-for": "40722123456" }), SECRET, now), "");
});

test("call-back: the TwiML dials OpenAI over TLS with the signed headers, XML-escaped", () => {
  const ts = 1_800_000_000;
  const xml = v.callbackTwiml("proj_abc123", "40722123456", ts, SECRET);
  assert.match(xml, /^<Response><Dial><Sip>sip:proj_abc123@sip\.api\.openai\.com;transport=tls\?x-gepetel-for=40722123456&amp;x-gepetel-ts=1800000000&amp;x-gepetel-sig=[0-9a-f]{32}<\/Sip><\/Dial><\/Response>$/);
  assert.ok(!/&(?!amp;)/.test(xml), "no bare & in XML");
  // Round trip: the headers it sends are the ones callbackFor accepts.
  const q = new URLSearchParams(xml.match(/\?([^<]+)</)[1].replace(/&amp;/g, "&"));
  const hs = [...q].map(([name, value]) => ({ name, value }));
  assert.equal(v.callbackFor(hs, SECRET, ts + 5), "40722123456");
  // The URI stays under Twilio's 255 characters for a realistic project id.
  assert.ok(xml.match(/<Sip>(.*)<\/Sip>/)[1].length < 255);
  assert.throws(() => v.callbackTwiml("proj<x>", "40722123456", ts, SECRET));
  assert.throws(() => v.callbackTwiml("proj_abc", "4072&2", ts, SECRET));
});

test("call-back: rung only for an allowed, known person, not busy, not twice in two minutes, never for a group call", () => {
  const base = { configured: true, group: false, digits: "40722123456", allowed: true, knownUser: true, busy: false, now: 1_000_000 };
  assert.deepEqual(v.decideCallback(base), { ring: true });
  assert.equal(v.decideCallback({ ...base, configured: false }).ring, false);
  assert.equal(v.decideCallback({ ...base, group: true }).ring, false);
  assert.equal(v.decideCallback({ ...base, digits: "" }).ring, false);
  assert.equal(v.decideCallback({ ...base, allowed: false }).ring, false);
  assert.equal(v.decideCallback({ ...base, knownUser: false }).ring, false);
  assert.equal(v.decideCallback({ ...base, busy: true }).ring, false);
  assert.equal(v.decideCallback({ ...base, lastAt: base.now - 60_000 }).ring, false);
  assert.deepEqual(v.decideCallback({ ...base, lastAt: base.now - 121_000 }), { ring: true });
});

test("call-back: off unless voice and every Twilio setting is there", () => {
  const full = { VOICE_ENABLED: "1", TWILIO_ACCOUNT_SID: "AC1", TWILIO_API_KEY_SID: "SK1", TWILIO_API_KEY_SECRET: "s", VOICE_CALLER_ID: "+40700000000", OPENAI_PROJECT_ID: "proj_1", VOICE_CALLBACK_SECRET: "x" };
  assert.equal(v.callbackConfigured(full), true);
  assert.equal(v.callbackConfigured({ ...full, VOICE_ENABLED: "" }), false);
  for (const k of Object.keys(full).filter(k => k !== "VOICE_ENABLED")) assert.equal(v.callbackConfigured({ ...full, [k]: "" }), false, k);
});

test("call-back: rings through Twilio's Calls API once, then leaves the next WhatsApp call alone", async () => {
  const env = { VOICE_ENABLED: "1", VOICE_CALLERS: "+40722123456", TWILIO_ACCOUNT_SID: "AC1", TWILIO_API_KEY_SID: "SK1", TWILIO_API_KEY_SECRET: "s3", VOICE_CALLER_ID: "+40700000000", OPENAI_PROJECT_ID: "proj_1", VOICE_CALLBACK_SECRET: SECRET };
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, text: async () => "" }; };
  const knownUser = async () => true;
  assert.equal(await v.callBack("40722123456", { knownUser, fetchImpl, env }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.twilio.com/2010-04-01/Accounts/AC1/Calls.json");
  assert.equal(calls[0].init.headers.Authorization, "Basic " + Buffer.from("SK1:s3").toString("base64"));
  const body = new URLSearchParams(String(calls[0].init.body));
  assert.equal(body.get("To"), "+40722123456");
  assert.equal(body.get("From"), "+40700000000");
  assert.match(body.get("Twiml"), /^<Response><Dial><Sip>sip:proj_1@sip\.api\.openai\.com;transport=tls\?/);
  // Again a moment later: handled (left alone), no second ring.
  assert.equal(await v.callBack("40722123456", { knownUser, fetchImpl, env }), true);
  assert.equal(calls.length, 1);
  // Someone not on the list: not handled here, so they get the usual note.
  assert.equal(await v.callBack("40733000000", { knownUser, fetchImpl, env }), false);
  // Voice off: not handled here either.
  assert.equal(await v.callBack("40722123456", { knownUser, fetchImpl, env: { ...env, VOICE_ENABLED: "" } }), false);
});

test("call-back: the greeting knows it is one", () => {
  assert.match(v.greeting("Romanian", true), /WhatsApp/);
  assert.doesNotMatch(v.greeting("Romanian", false), /WhatsApp/);
});

test("browser test call: session config is the phone call's, call id from Location, transcript marked as a test", () => {
  const cfg = v.sessionConfig({ author: "Ana", language: "Romanian", timezone: "Europe/Bucharest", aboutThem: "" }, { VOICE_VOICE: "cedar" });
  assert.equal(cfg.type, "realtime");
  assert.equal(cfg.audio.output.voice, "cedar");
  assert.deepEqual(cfg.tools.map(t => t.name), ["ask_gepetel", "end_call"]);
  assert.match(cfg.instructions, /Right now it is/);
  assert.equal(v.callIdFromLocation("/v1/realtime/calls/rtc_123abc"), "rtc_123abc");
  assert.equal(v.callIdFromLocation("https://api.openai.com/v1/realtime/calls/rtc_9?x=1"), "rtc_9");
  assert.equal(v.callIdFromLocation(null), "");
  assert.equal(v.callIdFromLocation("/v1/realtime/calls/<script>"), "");
  const t = v.transcript([{ who: "them", text: "salut" }], new Date(0), new Date(60000), "UTC");
  assert.match(v.markTest(t, true), /^\[Test call from the admin page/);
  assert.equal(v.markTest(t, false), t);
});

test("browser test call: refuses a non-SDP body, no creator, or someone already on a call — before calling OpenAI", async () => {
  let fetched = 0;
  const fetchImpl = async () => { fetched++; return new Response("v=0", { status: 201, headers: { location: "/v1/realtime/calls/rtc_x" } }); };
  const deps = { lookup: async () => ({ known: false, author: "", language: "Romanian", timezone: "UTC", aboutThem: "" }) };
  assert.equal((await v.startBrowserCall("hello", "1@s.whatsapp.net", deps, {}, fetchImpl)).status, 400);
  assert.equal((await v.startBrowserCall("v=0", "", deps, {}, fetchImpl)).status, 400);
  assert.equal((await v.startBrowserCall("v=0", "1@s.whatsapp.net", deps, {}, fetchImpl)).status, 404);
  assert.equal(fetched, 0);
});

test("transcription gets the caller's usual language as a hint, not a lock, so switching languages still works", () => {
  const h = v.transcriptionHint("Romanian");
  assert.match(h, /Romanian/);
  assert.match(h, /switch/);
  assert.match(h, /never translate/);
  const cfg = v.sessionConfig({ author: "B", language: "Romanian", timezone: "Europe/Bucharest", aboutThem: "" }, {});
  const tr = cfg.audio.input.transcription;
  assert.equal(tr.language, undefined);
  assert.match(tr.prompt, /Romanian/);
});
