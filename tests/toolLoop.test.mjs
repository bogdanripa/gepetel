// The tool loop shared by the 1:1 and group replies, against a stubbed model.
import { test } from "node:test";
import assert from "node:assert/strict";

const { runToolLoop, MAX_TOOL_ROUNDS } = (await import("../dist/toolLoop.js")).default;
const turns = (await import("../dist/turn.js")).default;

const call = (name, args, id) => ({ type: "function_call", name, arguments: JSON.stringify(args), call_id: id });
const quiet = fn => async (...a) => { const l = console.log, w = console.warn; console.log = console.warn = () => {}; try { return await fn(...a); } finally { console.log = l; console.warn = w; } };

function stub(responses) {
  const reqs = [];
  return { reqs, create: async req => { reqs.push(req); const r = responses.shift(); if (r instanceof Error) throw r; return r; } };
}
const base = (s, extra = {}) => ({ create: s.create, model: "m", tools: () => ["t"], turn: null, label: "dm x", audience: "the user", ...extra });

test("runs a call, hands its output back, returns the text", quiet(async () => {
  const s = stub([{ id: "r2", output: [], output_text: "done it" }]);
  const seen = [];
  const r = await runToolLoop(base(s, {
    first: { id: "r1", output: [call("add", { a: 1 }, "c1")] },
    dispatch: async c => { seen.push(c.name, c.args); return { ok: true }; },
  }));
  assert.deepEqual(seen, ["add", { a: 1 }]);
  assert.equal(r.answer, "done it");
  assert.equal(r.responseId, "r2");
  assert.equal(s.reqs[0].previous_response_id, "r1");
  assert.deepEqual(s.reqs[0].input[0], { type: "function_call_output", call_id: "c1", output: '{"ok":true}' });
  assert.equal(s.reqs[0].tool_choice, "auto");
}));

test("a throwing tool is an error for the model, not for the reply", quiet(async () => {
  const s = stub([{ id: "r2", output: [], output_text: "" }]);
  const r = await runToolLoop(base(s, {
    first: { id: "r1", output: [call("x", {}, "c1")] }, emptyAnswer: "no answer",
    dispatch: async () => { throw new Error("nope"); },
  }));
  assert.equal(JSON.parse(s.reqs[0].input[0].output).error, "nope");
  assert.equal(r.answer, "no answer");
}));

test("past the round cap no call runs and the model must answer in text", quiet(async () => {
  const again = i => ({ id: `r${i}`, output: [call("x", {}, `c${i}`)] });
  const s = stub([...Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) => again(i + 2)), { id: "last", output: [], output_text: "gave up" }]);
  let ran = 0;
  const r = await runToolLoop(base(s, { first: again(1), dispatch: async () => { ran++; return 1; } }));
  assert.equal(ran, MAX_TOOL_ROUNDS);
  assert.equal(s.reqs.at(-1).tool_choice, "none");
  assert.match(JSON.parse(s.reqs.at(-1).input[0].output).error, /NOT executed. Tell the user/);
  assert.equal(r.answer, "gave up");
}));

test("what arrives while writing is folded in, once more, as one message", quiet(async () => {
  const turn = turns.beginTurn("c_loop");
  turns.offerToTurn("c_loop", "Ana: and me");
  const s = stub([{ id: "r2", output: [], output_text: "both" }]);
  const r = await runToolLoop(base(s, { first: { id: "r1", output: [], output_text: "draft" }, turn, dispatch: async () => 0 }));
  assert.match(s.reqs[0].input[0].content, /Ana: and me/);
  assert.match(s.reqs[0].input[1].content, /NOT been sent/);
  assert.equal(r.answer, "both");
  assert.equal(turns.hasLiveTurn("c_loop"), false);
}));

test("a model call that throws still closes the turn", quiet(async () => {
  const turn = turns.beginTurn("c_loop2");
  const s = stub([new Error("500")]);
  await assert.rejects(runToolLoop(base(s, { first: { id: "r1", output: [call("x", {}, "c1")] }, turn, dispatch: async () => 0 })), /500/);
  assert.equal(turns.hasLiveTurn("c_loop2"), false);
}));

test("a huge thread starts fresh next time", quiet(async () => {
  const s = stub([]);
  const r = await runToolLoop(base(s, { first: { id: "r1", output: [], output_text: "hi", usage: { input_tokens: 200_000 } }, dispatch: async () => 0 }));
  assert.equal(r.responseId, "");
}));
