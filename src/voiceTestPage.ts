// The admin page for a test call (voice.ts startBrowserCall): the Mac's
// microphone over WebRTC into the same call a phone would get. Captions come
// from the call's own events on the data channel; the time each ask_gepetel
// took is measured here, from the tool call to its output appearing.
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
.them b{color:#0a58ca}.gep b{color:#198754}.tool{color:#777;font-size:.9em}
@media (prefers-color-scheme: dark){body{background:#111;color:#eee}#status{color:#aaa}.l{border-color:#222}#log{border-color:#333}.tool{color:#999}}
</style></head><body>
<h1>Call Gepetel <small style="font-weight:normal;color:#888">test</small></h1>
<p>Talks to live Gepetel as <b>${who}</b>, with the same instructions and tools as a phone call. The call is saved into that chat's history, marked as a test call.</p>
<label>Voice <select id="voice"><option>cedar</option><option>ash</option><option>verse</option><option>echo</option><option>ballad</option></select></label>
<button id="btn">Call</button>
<div id="status">Not connected.</div>
<div id="log"></div>
<audio id="out" autoplay></audio>
<script>
const btn = document.getElementById("btn"), statusEl = document.getElementById("status"), log = document.getElementById("log");
let pc = null, mic = null, asks = {};
function line(cls, who, text) {
  const d = document.createElement("div"); d.className = "l " + cls;
  if (who) { const b = document.createElement("b"); b.textContent = who + ": "; d.appendChild(b); }
  d.appendChild(document.createTextNode(text)); log.appendChild(d); d.scrollIntoView({ block: "end" });
}
function setStatus(t) { statusEl.textContent = t; }
function onEvent(ev) {
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
    const r = await fetch("/voice/test/session?voice=" + encodeURIComponent(document.getElementById("voice").value), { method: "POST", headers: { "Content-Type": "application/sdp" }, body: offer.sdp, credentials: "same-origin" });
    const body = await r.text();
    if (!r.ok) throw new Error(body || ("HTTP " + r.status));
    await pc.setRemoteDescription({ type: "answer", sdp: body });
    btn.textContent = "Hang up"; btn.className = "hang"; btn.disabled = false; btn.onclick = hangup;
  } catch (e) { setStatus("Couldn't call: " + (e.message || e)); done(); }
}
async function hangup() {
  btn.disabled = true; setStatus("Hanging up…");
  try { await fetch("/voice/test/hangup", { method: "POST", credentials: "same-origin" }); } catch (e) {}
  done();
}
function done() {
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  if (mic) { mic.getTracks().forEach(t => t.stop()); mic = null; }
  btn.textContent = "Call"; btn.className = ""; btn.disabled = false; btn.onclick = call;
  if (!statusEl.textContent.startsWith("Couldn't")) setStatus("Call ended. It's in the chat history.");
}
btn.onclick = call;
</script>
</body></html>`;
}
