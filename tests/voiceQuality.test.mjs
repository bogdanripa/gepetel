// Call quality (voiceQuality.ts): WebRTC stats → what the caller heard, the
// relay's resource samples → warnings and the per-call summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import q from "../dist/voiceQuality.js";

const base = { t: 0, rttMs: 40, packetsLost: 0, packetsReceived: 0, jitterMs: 5, concealedSamples: 0, totalSamples: 0, concealmentEvents: 0, inserted: 0, removed: 0, jbufDelay: 0, jbufEmitted: 0 };

test("rtcWindow: loss, concealment and jitter-buffer delay over the interval, not since the start", () => {
  const a = { ...base, packetsLost: 10, packetsReceived: 1000, concealedSamples: 4800, totalSamples: 480000, concealmentEvents: 2, jbufDelay: 50, jbufEmitted: 1000 };
  const b = { ...base, rttMs: 61.4, packetsLost: 12, packetsReceived: 1098, concealedSamples: 9600, totalSamples: 576000, concealmentEvents: 5, jbufDelay: 58, jbufEmitted: 1100, inserted: 960 };
  const w = q.rtcWindow(a, b);
  assert.equal(w.rttMs, 61);
  assert.equal(w.lossPct, 2);           // 2 lost of 100
  assert.equal(w.concealedPct, 5);      // 4800 of 96000
  assert.equal(w.glitches, 3);
  assert.equal(w.jbufMs, 80);           // 8 s over 100 emitted
  assert.equal(w.stretchPct, 1);
});

test("rtcWindow: no packets yet is zeros, not NaN", () => {
  const w = q.rtcWindow(null, base);
  assert.deepEqual([w.lossPct, w.concealedPct, w.jbufMs, w.stretchPct], [0, 0, 0, 0]);
});

test("gradeNet: clean is ok, some loss or a deep jitter buffer warns, heavy concealment is bad", () => {
  const ok = { rttMs: 40, lossPct: 0, concealedPct: 0.5, glitches: 1, jbufMs: 60, jitterMs: 5, stretchPct: 0 };
  assert.equal(q.gradeNet(ok), "ok");
  assert.equal(q.gradeNet({ ...ok, lossPct: 1.5 }), "warn");
  assert.equal(q.gradeNet({ ...ok, jbufMs: 200 }), "warn");
  assert.equal(q.gradeNet({ ...ok, glitches: 4 }), "warn");
  assert.equal(q.gradeNet({ ...ok, concealedPct: 6 }), "bad");
  assert.equal(q.gradeNet({ ...ok, rttMs: 450 }), "bad");
  assert.match(q.netLine(ok), /40 ms RTT · loss 0% · glitches 1/);
});

test("micLevel: silence, normal speech and clipping", () => {
  assert.equal(q.micLevel(new Uint8Array(512).fill(128)).silent, true);
  const speech = Uint8Array.from({ length: 512 }, (_, i) => 128 + Math.round(40 * Math.sin(i / 5)));
  const m = q.micLevel(speech);
  assert.equal(m.silent, false); assert.equal(m.clipping, false);
  assert.equal(q.micLevel(Uint8Array.from({ length: 512 }, (_, i) => (i % 2 ? 0 : 255))).clipping, true);
});

test("grokChunk: a chunk arriving after playback ran dry mid-answer is an underrun; a pause between answers is not", () => {
  const st = { lastAt: 0, underruns: 0, maxGapMs: 0 };
  q.grokChunk(st, 1000, -50);      // first chunk
  q.grokChunk(st, 1100, -40);      // on time
  q.grokChunk(st, 1400, 120);      // late, 300 ms gap: underrun
  q.grokChunk(st, 5000, 300);      // a new answer after a pause: not counted
  assert.equal(st.underruns, 1);
  assert.equal(st.maxGapMs, 300);
});

test("resources: warnings past the limits, avg/max summary, PSI and /proc/self/io parsing", () => {
  const s = { cpuPct: 85, rssMb: 200, heapMb: 90, lagMs: 140, load1: 1.2, freeMemMb: 900, ioReadKBs: 0, ioWriteKBs: 12, psiIo: 12.5 };
  assert.deepEqual(q.resourceWarnings(s), ["cpu 85%", "event-loop lag 140 ms", "io pressure 12.5"]);
  assert.deepEqual(q.resourceWarnings({ ...s, cpuPct: 20, lagMs: 10, psiIo: 0 }), []);
  const sum = q.summarizeResources([s, { ...s, cpuPct: 15, lagMs: 20, psiIo: 0.5 }]);
  assert.deepEqual(sum.cpuPct, { avg: 50, max: 85 });
  assert.match(q.resourceLine(sum), /cpu=50\/85% lag=80\/140ms/);
  assert.equal(q.resourceLine(null), "pi=(no samples)");
  assert.equal(q.psiAvg10("some avg10=3.25 avg60=1.00 avg300=0.50 total=1\nfull avg10=0.00"), 3.25);
  assert.equal(q.psiAvg10(""), undefined);
  assert.deepEqual(q.procIo("rchar: 1\nwchar: 2\nread_bytes: 4096\nwrite_bytes: 8192\n"), { read: 4096, write: 8192 });
});

test("clientLine: network, grok and mic halves of the quality line", () => {
  const line = q.clientLine({ model: "gpt-live-1", net: { rttMs: 40, lossPct: 0, concealedPct: 0.5, glitches: 1, jbufMs: 60, jitterMs: 5, stretchPct: 0, cand: "srflx", netType: "wifi" }, mic: { clippingPct: 0, silentPct: 40 } });
  assert.match(line, /rtt=40ms loss=0% concealed=0.5% glitches=1/);
  assert.match(line, /cand=srflx\/wifi grade=ok/);
  assert.match(line, /micSilent=40%/);
  assert.match(q.clientLine({ grok: { underruns: 2, maxGapMs: 340, wsBacklogMax: 0 } }), /underruns=2 maxGap=340ms/);
  assert.equal(q.clientLine(undefined), "client=(none)");
});

test("a test call's line waits for the page's half, and takes one that arrived first", () => {
  const got = [];
  q.clientReport("chat-a", { model: "m1" });        // page beat the relay
  q.finishTest("chat-a", c => got.push(c?.model));
  q.finishTest("chat-b", c => got.push(c?.model));  // relay first
  q.clientReport("chat-b", { model: "m2" });
  assert.deepEqual(got, ["m1", "m2"]);
});
