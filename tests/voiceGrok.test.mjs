// Grok Voice on the test page (voiceGrok.ts): the session it asks for, the
// captions it keeps, and the one-use socket tickets. No socket, no xAI.
import { test } from "node:test";
import assert from "node:assert/strict";
import g from "../dist/voiceGrok.js";

const who = { author: "Bogdan", language: "Romanian", timezone: "Europe/Bucharest", aboutThem: "" };

test("session: same instructions as a call plus the cheekier line, Gepetel's two tools, 24 kHz PCM both ways", () => {
  const s = g.grokSession(who, { voice: "leo", speed: 1.2 });
  assert.equal(s.type, "session.update");
  assert.match(s.session.instructions, /phone call/);
  assert.match(s.session.instructions, /cheekier/);
  assert.equal(s.session.voice, "leo");
  assert.deepEqual(s.session.tools.map(t => t.name), ["ask_gepetel", "end_call"]);
  assert.equal(s.session.tools[0].type, "function");
  assert.deepEqual(s.session.audio.input.format, { type: "audio/pcm", rate: 24000 });
  assert.deepEqual(s.session.audio.output.format, { type: "audio/pcm", rate: 24000 });
  assert.equal(s.session.audio.output.speed, 1.2);
  assert.equal(s.session.reasoning.effort, "none");
  assert.equal(s.session.turn_detection.type, "server_vad");
});

test("session: an unknown voice falls back to Grok's first, speed is held to 0.7–1.5", () => {
  assert.equal(g.grokSession(who, { voice: "verse" }).session.voice, g.GROK_VOICES[0]);
  assert.equal(g.grokSession(who, { speed: 3 }).session.audio.output.speed, 1.5);
  assert.equal(g.grokSession(who, { speed: 0.3 }).session.audio.output.speed, 0.7);
  assert.equal(g.grokSession(who, {}).session.audio.output.speed, 1.2);
});

test("captions: their cumulative transcript replaces its line; Grok's deltas become one line when the response is done", () => {
  const lines = [];
  const c = new g.GrokCaptions(lines);
  c.take({ type: "conversation.item.input_audio_transcription.updated", item_id: "i1", transcript: "Șe" });
  c.take({ type: "conversation.item.input_audio_transcription.updated", item_id: "i1", transcript: "Șe faci, măi?" });
  assert.deepEqual(lines, [{ who: "them", text: "Șe faci, măi?" }]);
  const cap = c.take({ type: "response.output_audio_transcript.delta", response_id: "r1", delta: "Ghini, " });
  assert.deepEqual(cap, { who: "gepetel", text: "Ghini, ", key: "r1" });
  c.take({ type: "response.output_audio_transcript.delta", response_id: "r1", delta: "amu!" });
  c.take({ type: "response.done", response: { id: "r1" } });
  assert.deepEqual(lines[1], { who: "gepetel", text: "Ghini, amu!" });
});

test("captions: a done transcript the shared handler already keeps is not written twice", () => {
  const lines = [];
  const c = new g.GrokCaptions(lines);
  c.take({ type: "response.output_audio_transcript.delta", response_id: "r1", delta: "Salut" });
  c.take({ type: "response.output_audio_transcript.done", response_id: "r1", transcript: "Salut" });
  lines.push({ who: "gepetel", text: "Salut" });   // what runCall itself does
  c.take({ type: "response.done", response: { id: "r1" } });
  assert.equal(lines.length, 1);
});

test("captions: a final transcript replaces the draft instead of adding a second line", () => {
  const lines = [];
  const c = new g.GrokCaptions(lines);
  c.take({ type: "conversation.item.input_audio_transcription.updated", item_id: "i1", transcript: "Ce am mâi" });
  c.take({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "Ce am mâine?" });
  lines.push({ who: "them", text: "Ce am mâine?" });   // what runCall itself does
  assert.deepEqual(lines, [{ who: "them", text: "Ce am mâine?" }]);
});

test("tickets: spent once, and not after a minute", () => {
  const t = g.mintTicket({ voice: "rex", speed: 1.2 }, 1000);
  assert.equal(g.spendTicket(t, 2000).voice, "rex");
  assert.equal(g.spendTicket(t, 2000), null);
  const old = g.mintTicket({}, 1000);
  assert.equal(g.spendTicket(old, 1000 + 61_000), null);
  assert.equal(g.spendTicket("nope"), null);
});

test("configured only with an xAI key", () => {
  assert.equal(g.configured({}), false);
  assert.equal(g.configured({ GROK_API_KEY: "xai-1" }), true);
});
