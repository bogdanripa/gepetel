// The admin page for a test call (voice.ts startBrowserCall): the Mac's
// microphone over WebRTC into the same call a phone would get. Captions come
// from the call's own events on the data channel; the time each ask_gepetel
// took is measured here, from the tool call to its output appearing.
import { rtcWindow, gradeNet, netLine, micLevel, grokChunk } from "./voiceQuality.js";

export function voiceTestPage(who: string): string {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Call Gepetel (test)</title>
<style>
body{font-family:system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 16px;color:#111;background:#fff}
button{font-size:1.1rem;padding:.6rem 1.4rem;border-radius:8px;border:0;cursor:pointer;color:#fff;background:#198754}
button.hang{background:#b02a37}
button:disabled{opacity:.5;cursor:default}
#status{margin:.8rem 0;color:#555}
#log{border-top:1px solid #ddd;margin-top:1rem}
.l{padding:.45rem 0;border-bottom:1px solid #f0f0f0;line-height:1.4}
.q{font:12px/1.5 ui-monospace,monospace;color:#555;margin:.2rem 0}.q.warn{color:#b58100}.q.bad{color:#b02a37}
.them b{color:#0a58ca}.gep b{color:#198754}.tool{color:#777;font-size:.9em}
@media (prefers-color-scheme: dark){body{background:#111;color:#eee}#status{color:#aaa}.l{border-color:#222}#log{border-color:#333}.tool{color:#999}}
</style></head><body>
<h1>Call Gepetel <small style="font-weight:normal;color:#888">test</small></h1>
<p>Talks to live Gepetel as <b>${who}</b>, with the same instructions and tools as a phone call. The call is saved into that chat's history, marked as a test call.</p>
<label>Model <select id="model"><option selected>gpt-live-1</option><option>gpt-realtime-2.1</option><option>gpt-realtime-2.1-mini</option><option value="grok-voice">grok-voice (xAI)</option></select></label>
<label>Voice <select id="voice"><option>ballad</option><option>verse</option><option>cedar</option><option>ash</option><option>echo</option></select></label>
<label>Speed <select id="speed"><option>1.0</option><option>1.1</option><option>1.15</option><option selected>1.2</option><option>1.3</option></select></label>
<button id="btn">Call</button>
<p style="color:#888;font-size:.9em">gpt-live-1 is OpenAI's newer Live API: speed doesn't apply to it, and it can't hang up by itself (use Hang up). grok-voice is xAI's: its audio goes through the relay, with its own voices, and a cheekier tone.</p>
<div id="status">Not connected.</div>
<div id="qnet" class="q"></div><div id="qmic" class="q"></div><div id="qres" class="q"></div>
<div id="log"></div>
<audio id="out" autoplay></audio>
<script>
// Call quality: the same functions the relay tests (voiceQuality.ts).
${rtcWindow.toString()}
${gradeNet.toString()}
${netLine.toString()}
${micLevel.toString()}
${grokChunk.toString()}
const qnet = document.getElementById("qnet"), qmic = document.getElementById("qmic"), qres = document.getElementById("qres");
let qTimer = null, qFirst = null, qPrev = null, qLast = null, qCand = "", qNetType = "", micAn = null, micCtx = null, micN = 0, micClip = 0, micSilent = 0;
let gst = { lastAt: 0, underruns: 0, maxGapMs: 0 }, wsBacklogMax = 0;
function showQ(el, text, grade) { el.textContent = text; el.className = "q " + (grade || ""); }
async function readRtc() {
  if (!pc) return null;
  const st = await pc.getStats(); let s = null, rtt, localId;
  st.forEach(r => {
    if (r.type === "inbound-rtp" && r.kind === "audio") s = { t: performance.now(), packetsLost: r.packetsLost || 0, packetsReceived: r.packetsReceived || 0, jitterMs: (r.jitter || 0) * 1000,
      concealedSamples: r.concealedSamples || 0, totalSamples: r.totalSamplesReceived || 0, concealmentEvents: r.concealmentEvents || 0,
      inserted: r.insertedSamplesForDeceleration || 0, removed: r.removedSamplesForAcceleration || 0, jbufDelay: r.jitterBufferDelay || 0, jbufEmitted: r.jitterBufferEmittedCount || 0 };
    if (r.type === "candidate-pair" && (r.nominated || r.state === "succeeded") && r.currentRoundTripTime != null) { rtt = r.currentRoundTripTime * 1000; localId = r.localCandidateId; }
  });
  if (!s) return null;
  s.rttMs = rtt || 0;
  const lc = localId && st.get(localId); if (lc) { qCand = lc.candidateType || ""; qNetType = lc.networkType || ""; }
  return s;
}
function sampleMic() {
  if (!micAn) return;
  const b = new Uint8Array(micAn.fftSize); micAn.getByteTimeDomainData(b);
  const m = micLevel(b); micN++; if (m.clipping) micClip++; if (m.silent) micSilent++;
  const bars = Math.min(20, Math.round(m.rms * 60));
  showQ(qmic, "mic: " + "▮".repeat(bars) + "▯".repeat(20 - bars) + (m.clipping ? " clipping!" : m.silent ? " silent" : ""), m.clipping ? "bad" : "");
}
async function pollRes() {
  try {
    const r = await fetch("/voice/test/resources", { credentials: "same-origin" }); const s = await r.json();
    if (!s) return;
    const bad = s.cpuPct > 80 || s.lagMs > 100 || (s.psiIo || 0) > 10;
    showQ(qres, "pi: cpu " + s.cpuPct + "% · lag " + s.lagMs + " ms · load " + s.load1 + " · rss " + s.rssMb + " MB · free " + s.freeMemMb + " MB · io " + s.ioReadKBs + "/" + s.ioWriteKBs + " KB/s" + (s.psiIo != null ? " · io pressure " + s.psiIo : ""), bad ? "bad" : "");
  } catch (e) {}
}
function startQuality(stream) {
  qFirst = qPrev = qLast = null; micN = micClip = micSilent = 0; gst = { lastAt: 0, underruns: 0, maxGapMs: 0 }; wsBacklogMax = 0;
  try { micCtx = new AudioContext(); micAn = micCtx.createAnalyser(); micAn.fftSize = 1024; micCtx.createMediaStreamSource(stream).connect(micAn); } catch (e) { micAn = null; }
  qTimer = setInterval(async () => {
    sampleMic(); pollRes();
    const s = await readRtc(); if (!s) return;
    if (!qFirst) qFirst = s;
    if (qPrev) { const w = rtcWindow(qPrev, s); showQ(qnet, netLine(w) + " · " + (qCand || "?"), gradeNet(w)); }
    qPrev = qLast = s;
  }, 2000);
}
function stopQuality(model) {
  if (qTimer) clearInterval(qTimer); qTimer = null;
  if (micCtx) { try { micCtx.close(); } catch (e) {} micCtx = null; micAn = null; }
  const rep = { model, mic: micN ? { clippingPct: Math.round(micClip / micN * 100), silentPct: Math.round(micSilent / micN * 100) } : undefined };
  if (qFirst && qLast && qLast !== qFirst) { const w = rtcWindow(qFirst, qLast); rep.net = Object.assign(w, { cand: qCand, netType: qNetType }); showQ(qnet, "whole call — " + netLine(w), gradeNet(w)); }
  if (model === "grok-voice") rep.grok = { underruns: gst.underruns, maxGapMs: gst.maxGapMs, wsBacklogMax };
  fetch("/voice/test/quality", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rep), credentials: "same-origin" }).catch(() => {});
}
const btn = document.getElementById("btn"), statusEl = document.getElementById("status"), log = document.getElementById("log");
let pc = null, mic = null, asks = {}, cur = null, curWho = "", handoff = 0;
// gpt-live-1 sends captions as deltas: one growing line per turn of talk.
function delta(cls, who, text) {
  if (!cur || curWho !== who) {
    cur = document.createElement("div"); cur.className = "l " + cls; curWho = who;
    const b = document.createElement("b"); b.textContent = who + ": "; cur.appendChild(b);
    cur.appendChild(document.createTextNode("")); log.appendChild(cur);
  }
  cur.lastChild.textContent += text; cur.scrollIntoView({ block: "end" });
}
function line(cls, who, text) {
  const d = document.createElement("div"); d.className = "l " + cls;
  if (who) { const b = document.createElement("b"); b.textContent = who + ": "; d.appendChild(b); }
  d.appendChild(document.createTextNode(text)); log.appendChild(d); d.scrollIntoView({ block: "end" });
}
function setStatus(t) { statusEl.textContent = t; }
function onEvent(ev) {
  if (ev.type === "session.input_transcript.delta" && ev.delta) { delta("them", "You", ev.delta); return; }
  if (ev.type === "session.output_transcript.delta" && ev.delta) {
    if (handoff) { line("tool", "", "← first words after the hand-off: " + ((performance.now() - handoff) / 1000).toFixed(1) + " s"); handoff = 0; cur = null; }
    delta("gep", "Gepetel", ev.delta); return;
  }
  if (ev.type === "session.delegation.created") { cur = null; handoff = performance.now(); line("tool", "", "→ handed to Gepetel"); return; }
  if (ev.type === "conversation.item.input_audio_transcription.completed" && ev.transcript) line("them", "You", ev.transcript);
  else if (ev.type === "response.output_audio_transcript.done" && ev.transcript) line("gep", "Gepetel", ev.transcript);
  else if (ev.type === "response.function_call_arguments.done") {
    let a = {}; try { a = JSON.parse(ev.arguments || "{}"); } catch (e) {}
    if (ev.name === "ask_gepetel") { asks[ev.call_id] = performance.now(); line("tool", "", "→ ask_gepetel: " + (a.request || "")); }
    else if (ev.name === "end_call") line("tool", "", "→ end_call");
  } else if ((ev.type === "conversation.item.created" || ev.type === "conversation.item.added") && ev.item && ev.item.type === "function_call_output" && asks[ev.item.call_id]) {
    const s = ((performance.now() - asks[ev.item.call_id]) / 1000).toFixed(1); delete asks[ev.item.call_id];
    line("tool", "", "← ask_gepetel answered in " + s + " s");
  } else if (ev.type === "error") line("tool", "", "error: " + JSON.stringify(ev.error || ev));
}
async function call() {
  btn.disabled = true; setStatus("Asking for the microphone…");
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    pc = new RTCPeerConnection();
    pc.ontrack = e => { document.getElementById("out").srcObject = e.streams[0]; };
    pc.onconnectionstatechange = () => { setStatus("Connection: " + pc.connectionState); if (["failed", "closed", "disconnected"].includes(pc.connectionState)) done(); };
    mic.getTracks().forEach(t => pc.addTrack(t, mic));
    const dc = pc.createDataChannel("oai-events");
    dc.onmessage = m => { try { onEvent(JSON.parse(m.data)); } catch (e) {} };
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    setStatus("Calling…");
    const r = await fetch("/voice/test/session?voice=" + encodeURIComponent(document.getElementById("voice").value) + "&model=" + encodeURIComponent(document.getElementById("model").value) + "&speed=" + encodeURIComponent(document.getElementById("speed").value), { method: "POST", headers: { "Content-Type": "application/sdp" }, body: offer.sdp, credentials: "same-origin" });
    const body = await r.text();
    if (!r.ok) throw new Error(body || ("HTTP " + r.status));
    await pc.setRemoteDescription({ type: "answer", sdp: body });
    startQuality(mic);
    btn.textContent = "Hang up"; btn.className = "hang"; btn.disabled = false; btn.onclick = hangup;
  } catch (e) { setStatus("Couldn't call: " + (e.message || e)); done(); }
}
async function hangup() {
  btn.disabled = true; setStatus("Hanging up…");
  try { await fetch("/voice/test/hangup", { method: "POST", credentials: "same-origin" }); } catch (e) {}
  done();
}
function done() {
  if (qTimer) stopQuality(modelSel.value);
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  if (mic) { mic.getTracks().forEach(t => t.stop()); mic = null; }
  btn.textContent = "Call"; btn.className = ""; btn.disabled = false; btn.onclick = start;
  if (!statusEl.textContent.startsWith("Couldn't")) setStatus("Call ended. It's in the chat history.");
}
// --- Grok: no WebRTC, so the microphone streams to the relay as 24 kHz PCM16
// and Grok's voice comes back the same way (voiceGrok.ts).
const OAI_VOICES = ["verse", "cedar", "ash", "echo", "ballad"], GROK_VOICES = ["rex", "leo", "sal", "cosmo", "lux", "helix", "orion", "castor", "atlas", "kepler"];
const modelSel = document.getElementById("model"), voiceSel = document.getElementById("voice");
function fillVoices() {
  const list = modelSel.value === "grok-voice" ? GROK_VOICES : modelSel.value === "gpt-live-1" ? ["ballad", ...OAI_VOICES.filter(v => v !== "ballad")] : OAI_VOICES;
  voiceSel.innerHTML = ""; list.forEach(v => { const o = document.createElement("option"); o.textContent = v; voiceSel.appendChild(o); });
}
function syncSpeed() { const s = document.getElementById("speed"); s.disabled = modelSel.value === "gpt-live-1"; s.title = s.disabled ? "gpt-live-1 ignores speed" : ""; }
modelSel.onchange = () => { fillVoices(); syncSpeed(); };
syncSpeed();
let gws = null, actx = null, node = null, src = null, playAt = 0, playing = [], gLines = {};
function caption(c) {
  let d = gLines[c.key];
  if (!d) { d = document.createElement("div"); d.className = "l " + (c.who === "them" ? "them" : "gep"); const b = document.createElement("b"); b.textContent = (c.who === "them" ? "You" : "Gepetel") + ": "; d.appendChild(b); d.appendChild(document.createTextNode("")); log.appendChild(d); gLines[c.key] = d; }
  d.lastChild.textContent = c.text; d.scrollIntoView({ block: "end" });
}
function playPcm(buf) {
  const i16 = new Int16Array(buf), f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  const ab = actx.createBuffer(1, f32.length, 24000); ab.copyToChannel(f32, 0);
  const s = actx.createBufferSource(); s.buffer = ab; s.connect(actx.destination);
  grokChunk(gst, performance.now(), (actx.currentTime - playAt) * 1000);
  playAt = Math.max(playAt, actx.currentTime + 0.05); s.start(playAt); playAt += ab.duration;
  playing.push(s); s.onended = () => { playing = playing.filter(x => x !== s); };
}
const WORKLET = "class M extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c){const o=new Int16Array(c.length);for(let k=0;k<c.length;k++){const v=Math.max(-1,Math.min(1,c[k]));o[k]=v<0?v*32768:v*32767;}this.port.postMessage(o.buffer,[o.buffer]);}return true}}registerProcessor('mic-pcm',M);";
async function callGrok() {
  btn.disabled = true; setStatus("Asking for the microphone…"); gLines = {};
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    actx = new AudioContext({ sampleRate: 24000 });
    await actx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
    setStatus("Calling…");
    const r = await fetch("/voice/test/grok/start?voice=" + encodeURIComponent(voiceSel.value) + "&speed=" + encodeURIComponent(document.getElementById("speed").value), { method: "POST", credentials: "same-origin" });
    if (!r.ok) throw new Error((await r.text()) || ("HTTP " + r.status));
    const j = await r.json();
    gws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + j.ws);
    gws.binaryType = "arraybuffer";
    gws.onopen = () => {
      setStatus("Connected (Grok).");
      src = actx.createMediaStreamSource(mic); node = new AudioWorkletNode(actx, "mic-pcm");
      node.port.onmessage = e => { if (gws && gws.readyState === 1) { gws.send(e.data); wsBacklogMax = Math.max(wsBacklogMax, gws.bufferedAmount); } };
      startQuality(mic);
      src.connect(node);
      btn.textContent = "Hang up"; btn.className = "hang"; btn.disabled = false; btn.onclick = hangupGrok;
    };
    gws.onmessage = m => {
      if (typeof m.data !== "string") { playPcm(m.data); return; }
      let ev; try { ev = JSON.parse(m.data); } catch (e) { return; }
      if (ev.type === "clear") { playing.forEach(s => { try { s.stop(); } catch (e) {} }); playing = []; playAt = 0; }
      else if (ev.type === "caption") caption(ev);
      else if (ev.type === "tool") line("tool", "", ev.text);
      else if (ev.type === "error") line("tool", "", "error: " + JSON.stringify(ev.error));
    };
    gws.onclose = () => doneGrok();
  } catch (e) { setStatus("Couldn't call: " + (e.message || e)); doneGrok(); }
}
function hangupGrok() { btn.disabled = true; setStatus("Hanging up…"); if (gws) gws.close(); doneGrok(); }
function doneGrok() {
  if (qTimer) { stopQuality("grok-voice"); showQ(qnet, "grok — underruns " + gst.underruns + " · max gap " + gst.maxGapMs + " ms · ws backlog max " + wsBacklogMax + " B", gst.underruns > 3 ? "warn" : ""); }
  if (node) { try { node.disconnect(); } catch (e) {} node = null; }
  if (src) { try { src.disconnect(); } catch (e) {} src = null; }
  if (mic) { mic.getTracks().forEach(t => t.stop()); mic = null; }
  if (actx) { setTimeout(() => { try { actx && actx.close(); } catch (e) {} actx = null; }, 300); }
  gws = null; playing = []; playAt = 0;
  btn.textContent = "Call"; btn.className = ""; btn.disabled = false; btn.onclick = start;
  if (!statusEl.textContent.startsWith("Couldn't")) setStatus("Call ended. It's in the chat history.");
}
function start() { return modelSel.value === "grok-voice" ? callGrok() : call(); }
btn.onclick = start;
</script>
</body></html>`;
}
