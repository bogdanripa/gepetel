// Gepetel phoning a business (voiceOutbound.ts, voice.ts): the parts that
// decide, sign, word and read, with no call, no socket and no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import ob from "../dist/voiceOutbound.js";
import v from "../dist/voice.js";

const SECRET = "s3cret-for-tests";
const ctx = { chatId: "40722123456@s.whatsapp.net", author: "Bogdan", timezone: "Europe/Bucharest" };
const brief = { business_name: "Restaurant Bun", phone: "021 312 45 67", goal: "o masă pentru 4 vineri la 20:00", must_have: "înăuntru", acceptable_range: "19:30–21:00", may_share: { name: "Ripa" }, questions_to_ask: ["e loc de parcare?", "țineți masa 15 minute?"], language: "Romanian" };

test("number: national, 00 and + forms all become digits with the country code; junk is refused", () => {
  assert.equal(ob.businessNumber("021 312 45 67"), "40213124567");
  assert.equal(ob.businessNumber("+40 21 312 45 67"), "40213124567");
  assert.equal(ob.businessNumber("0040213124567"), "40213124567");
  assert.equal(ob.businessNumber("(021) 312-45-67"), "40213124567");
  assert.equal(ob.businessNumber("call me"), "");
  assert.equal(ob.businessNumber("123"), "");
});

test("only the family gets call_business, and only with VOICE_ENABLED and VOICE_OUTBOUND", () => {
  const env = { VOICE_ENABLED: "1", VOICE_OUTBOUND: "1", VOICE_CALLERS: "+40722123456,0723000000" };
  assert.equal(ob.toolAvailable("40722123456@s.whatsapp.net", env), true);
  assert.equal(ob.toolAvailable("40723000000@s.whatsapp.net", env), true);
  assert.equal(ob.toolAvailable("40799999999@s.whatsapp.net", env), false);
  assert.equal(ob.toolAvailable("40722123456@s.whatsapp.net", { ...env, VOICE_OUTBOUND: "" }), false);
  assert.equal(ob.toolAvailable("40722123456@s.whatsapp.net", { ...env, VOICE_ENABLED: "" }), false);
  // "*" (anyone) doesn't open it to everyone.
  assert.equal(ob.toolAvailable("40799999999@s.whatsapp.net", { ...env, VOICE_CALLERS: "*" }), false);
});

test("business hours: the business's wall clock, 9-22 by default", () => {
  // 07:30 UTC = 09:30 in Bucharest (UTC+2 in November).
  assert.equal(ob.withinHours(new Date("2026-11-17T07:30:00Z"), "Europe/Bucharest"), true);
  assert.equal(ob.withinHours(new Date("2026-11-17T06:30:00Z"), "Europe/Bucharest"), false);
  assert.equal(ob.withinHours(new Date("2026-11-17T20:30:00Z"), "Europe/Bucharest"), false); // 22:30
  assert.equal(ob.withinHours(new Date("2026-11-17T20:30:00Z"), "Europe/Bucharest", "10-23"), true);
  assert.deepEqual(ob.hoursWindow("nonsense"), [9, 22]);
  assert.deepEqual(ob.hoursWindow("22-9"), [9, 22]);
});

test("decide: a yes first, a number, the line, hours, the daily cap and no redial within 10 minutes", () => {
  const base = { available: true, configured: true, confirmed: true, digits: "40213124567", ownNumber: false, inHours: true, callsToday: 0, maxPerDay: 10, again: false, now: 1_000_000_000 };
  assert.deepEqual(ob.decideOutbound(base), { ok: true });
  assert.equal(ob.decideOutbound({ ...base, available: false }).ok, false);
  const nc = ob.decideOutbound({ ...base, confirmed: false });
  assert.equal(nc.ok, false); assert.match(nc.tell, /ask if you should go ahead/);
  assert.equal(ob.decideOutbound({ ...base, digits: "" }).why, "no valid number");
  assert.equal(ob.decideOutbound({ ...base, ownNumber: true }).why, "own number");
  assert.equal(ob.decideOutbound({ ...base, configured: false }).why, "phone line not set up");
  assert.equal(ob.decideOutbound({ ...base, inHours: false }).why, "outside business hours");
  assert.equal(ob.decideOutbound({ ...base, callsToday: 10 }).why, "daily outbound limit");
  assert.equal(ob.decideOutbound({ ...base, lastToSameAt: base.now - 5 * 60_000 }).why, "called them minutes ago");
  assert.deepEqual(ob.decideOutbound({ ...base, lastToSameAt: base.now - 5 * 60_000, again: true }), { ok: true });
  assert.deepEqual(ob.decideOutbound({ ...base, lastToSameAt: base.now - 11 * 60_000 }), { ok: true });
});

test("mission: signed on the SIP leg; a forged, stale or tampered header is ignored", () => {
  const m = ob.missionFrom(brief, ctx);
  assert.match(m.id, /^m_[0-9a-f]{18}$/);
  assert.equal(m.phone, "40213124567");
  assert.deepEqual(m.questions_to_ask, ["e loc de parcare?", "țineți masa 15 minute?"]);
  const ts = 1_800_000_000;
  const h = [{ name: "X-Gepetel-Mission", value: m.id }, { name: "x-gepetel-ts", value: String(ts) }, { name: "x-gepetel-sig", value: ob.missionSig(m.id, ts, SECRET) }];
  assert.equal(ob.missionIdFromHeaders(h, SECRET, ts + 60), m.id);
  assert.equal(ob.missionIdFromHeaders(h, SECRET, ts + 301), "", "stale");
  assert.equal(ob.missionIdFromHeaders(h, "other", ts), "", "wrong secret");
  assert.equal(ob.missionIdFromHeaders(h, undefined, ts), "", "no secret");
  const forged = h.map(x => x.name.toLowerCase() === "x-gepetel-mission" ? { ...x, value: "m_" + "0".repeat(18) } : x);
  assert.equal(ob.missionIdFromHeaders(forged, SECRET, ts), "");
  // A call-back signature isn't a mission signature.
  const cb = [{ name: "x-gepetel-mission", value: m.id }, { name: "x-gepetel-ts", value: String(ts) }, { name: "x-gepetel-sig", value: v.callbackSig(m.id, ts, SECRET) }];
  assert.equal(ob.missionIdFromHeaders(cb, SECRET, ts), "");
});

test("TwiML: dials OpenAI's SIP endpoint over TLS with the escaped, signed mission", () => {
  const id = "m_0123456789abcdef01";
  const x = ob.missionTwiml("proj_1", id, 1_800_000_000, SECRET);
  assert.match(x, /^<Response><Dial><Sip>sip:proj_1@sip\.api\.openai\.com;transport=tls\?x-gepetel-mission=m_0123456789abcdef01&amp;x-gepetel-ts=1800000000&amp;x-gepetel-sig=[0-9a-f]{32}<\/Sip><\/Dial><\/Response>$/);
  assert.throws(() => ob.missionTwiml("bad project", id, 1, SECRET));
  assert.throws(() => ob.missionTwiml("proj_1", "m_<x>", 1, SECRET));
});

test("brief: discloses an AI assistant, carries the goal, the range, what may be shared and the questions", () => {
  const m = ob.missionFrom(brief, ctx);
  const t = ob.outboundInstructions(m, new Date("2026-11-17T10:00:00Z"));
  assert.match(t, /AI assistant/);
  assert.match(t, /Gepetel, Bogdan's assistant/);
  assert.match(t, /o masă pentru 4 vineri la 20:00/);
  assert.match(t, /19:30–21:00/);
  assert.match(t, /the name for the booking: Ripa/);
  assert.match(t, /- e loc de parcare\?/);
  assert.match(t, /Never give card or bank details/);
  assert.doesNotMatch(t, /\{\{/);
  // The realtime session of a business call: the brief, and only end_call.
  const s = v.sessionConfig({ author: "Bogdan", language: "Romanian", timezone: "Europe/Bucharest", aboutThem: "", mission: m }, {});
  assert.deepEqual(s.tools.map(x => x.name), ["end_call"]);
  assert.match(s.instructions, /Restaurant Bun/);
  const l = v.liveSession({ author: "Bogdan", language: "Romanian", timezone: "Europe/Bucharest", aboutThem: "", mission: m }, {});
  assert.match(l.instructions, /phone menu/);
  assert.doesNotMatch(l.instructions, /ask_gepetel/);
});

test("voicemail: Romanian and English machines are recognised; a person isn't", () => {
  assert.equal(ob.isVoicemail("Lăsați un mesaj după semnalul sonor."), true);
  assert.equal(ob.isVoicemail("Abonatul apelat nu este disponibil"), true);
  assert.equal(ob.isVoicemail("Please leave a message after the tone"), true);
  assert.equal(ob.isVoicemail("Restaurant Bun, bună ziua!"), false);
  assert.equal(ob.isVoicemail("Da, avem masă la opt."), false);
});

test("outcome: the model's JSON read whatever it left out; the note thinks ahead and a test changes nothing", () => {
  const o = ob.parseOutcome('```json\n{"reached":true,"done":true,"when":"vineri 20:00","party_size":"4","under_name":"Ripa","conditions":"țin masa 15 minute","extra_info":"parcare în curte","alternatives":"","summary":"Rezervat."}\n```');
  assert.equal(o.done, true); assert.equal(o.when, "vineri 20:00"); assert.equal(o.extra_info, "parcare în curte");
  const empty = ob.parseOutcome("not json");
  assert.equal(empty.reached, false); assert.equal(empty.summary, "(no summary)");
  const m = ob.missionFrom(brief, ctx);
  const note = ob.outcomeNote(m, o);
  assert.match(note, /goal done: yes/);
  assert.match(note, /never a second copy/);
  assert.match(note, /Invite the people they said are going/);
  assert.doesNotMatch(note, /TEST CALL/);
  m.test = true;
  assert.match(ob.outcomeNote(m, o), /do NOT create or change calendar events/);
});

test("transcript: the business by name, the brief in the head", () => {
  const m = ob.missionFrom(brief, ctx);
  const t = ob.transcriptFor(m, [{ who: "them", text: "Bun, bună ziua" }, { who: "gepetel", text: "Bună ziua, sunt Gepetel…" }], new Date("2026-11-17T10:00:00Z"), new Date("2026-11-17T10:02:00Z"));
  assert.match(t, /^\[Phone call you made for them to Restaurant Bun \(\+40213124567\)/);
  assert.match(t, /Restaurant Bun: Bun, bună ziua\nYou: Bună ziua, sunt Gepetel…/);
});

test("phone menu: only real keys are pressed", () => {
  assert.equal(ob.keysToPress({ press: "2" }), "2");
  assert.equal(ob.keysToPress({ press: " 1 # " }), "1#");
  assert.equal(ob.keysToPress({ press: "" }), "");
  assert.equal(ob.keysToPress({ press: "two" }), "");
  assert.equal(ob.keysToPress({}), "");
});

test("startMission: nothing goes out without a yes, and nothing to Twilio when it's refused", async () => {
  let posted = 0;
  const fetchImpl = async () => { posted++; return { ok: true, text: async () => "" }; };
  const env = { VOICE_ENABLED: "1", VOICE_OUTBOUND: "1", VOICE_CALLERS: "+40722123456", TWILIO_ACCOUNT_SID: "AC1", TWILIO_API_KEY_SID: "SK1", TWILIO_API_KEY_SECRET: "x", VOICE_CALLER_ID: "+40700000000", OPENAI_PROJECT_ID: "proj_1", VOICE_CALLBACK_SECRET: SECRET, VOICE_OUTBOUND_HOURS: "0-24" };
  const no = await ob.startMission({ ...brief, user_confirmed: false }, ctx, env, fetchImpl);
  assert.equal(no.called, false); assert.equal(posted, 0);
  const yes = await ob.startMission({ ...brief, user_confirmed: true }, ctx, env, fetchImpl);
  assert.equal(yes.called, true); assert.equal(posted, 1);
  assert.ok(ob.getMission(yes.mission));
  const again = await ob.startMission({ ...brief, user_confirmed: true }, ctx, env, fetchImpl);
  assert.equal(again.reason, "called them minutes ago"); assert.equal(posted, 1);
});
