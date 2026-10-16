// /device/llm — the computer's only way to a model, and every limit on it.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key-unused";
const llm = (await import("../dist/device/llm.js")).default;
const { sanitize, MODELS } = await import("../dist/device/llm.js");
const store = (await import("../dist/device/store.js")).default;
const jobs = (await import("../dist/device/jobs.js")).default;

describe("what may be sent to the model", () => {
  test("the default model is luna, and only allowlisted models pass", () => {
    assert.equal(sanitize({ input: "hi" }).req.model, "gpt-5.6-luna");
    assert.ok(MODELS.includes("gpt-5-nano"));
    assert.equal(sanitize({ input: "hi", model: "gpt-5.6-luna-pro-max" }).status, 400);
  });
  test("only plain function tools — no hosted tools that spend on other things", () => {
    const fn = { type: "function", name: "click", parameters: {} };
    assert.ok(sanitize({ input: "hi", tools: [fn] }).req);
    for (const t of [{ type: "web_search" }, { type: "mcp", server_url: "x" }, { type: "code_interpreter" }, { type: "file_search" }]) {
      assert.equal(sanitize({ input: "hi", tools: [fn, t] }).status, 400, t.type);
    }
  });
  test("anything not named is dropped, and the response is never stored", () => {
    const { req } = sanitize({ input: "hi", previous_response_id: "r_1", metadata: { x: 1 }, store: true, background: true });
    assert.deepEqual(Object.keys(req).sort(), ["input", "max_output_tokens", "model", "store"]);
    assert.equal(req.store, false);
  });
  test("output is capped, and an oversized input is refused before it is sent", () => {
    assert.equal(sanitize({ input: "hi", max_output_tokens: 100000 }).req.max_output_tokens, 4000);
    assert.equal(sanitize({ input: "x".repeat(400_001) }).status, 413);
  });
});

describe("the route", () => {
  const PORT = 3412;
  let server, sent = [], charged = 0, chargedJobs = [];
  const device = { device_id: "d_llm", chat_id: "40700000000@s.whatsapp.net" };
  const post = (body, token = "good") => fetch(`http://127.0.0.1:${PORT}/device/llm`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  before(async () => {
    store.deviceForToken = async t => t === "good" ? device : null;
    jobs.getJob = async id => id === "j_mine" ? { job_id: id, device_id: "d_llm" } : id === "j_theirs" ? { job_id: id, device_id: "d_other" } : null;
    llm.openai.create = async req => { sent.push(req); return { output: [{ type: "message" }], output_text: "ok", usage: { input_tokens: 1200, output_tokens: 80, cached_tokens: 0 } }; };
    llm.usage.today = async () => charged;
    llm.usage.charge = async (_d, i, o) => { charged += i + o; };
    llm.jobUsage.charge = async id => { chargedJobs.push(id); };
    const app = express();
    // As in app.ts: the global parser skips this route.
    app.use((req, res, next) => req.path === "/device/llm" ? next() : express.json()(req, res, next));
    llm.registerLlmRoute(app);
    server = http.createServer(app);
    await new Promise(r => server.listen(PORT, "127.0.0.1", r));
  });
  after(() => server.close());

  test("no device token, no model", async () => {
    assert.equal((await post({ input: "hi" }, "")).status, 401);
    assert.equal((await post({ input: "hi" }, "bad")).status, 401);
    assert.equal(sent.length, 0);
  });
  test("a paired device gets an answer, and it is charged to the device", async () => {
    const r = await post({ input: "hi" });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.output_text, "ok");
    assert.deepEqual(body.usage, { input_tokens: 1200, output_tokens: 80, cached_tokens: 0 });
    // One prompt cache per job (else per device), set by the relay, not the device.
    assert.match(sent.at(-1).prompt_cache_key, /^gepetel-/);
    assert.equal(charged, 1280);
  });
  test("a body far over Express's 100 KB default gets through (a page snapshot)", async () => {
    const r = await post({ input: "x".repeat(300_000) });
    assert.equal(r.status, 200);
  });
  test("its own job is charged; someone else's job is not", async () => {
    chargedJobs = [];
    await post({ input: "hi", job_id: "j_mine" });
    await post({ input: "hi", job_id: "j_theirs" });
    assert.deepEqual(chargedJobs, ["j_mine"]);
  });
  test("over the daily budget, the answer is a 429 in words — and nothing is sent", async () => {
    const before = sent.length;
    charged = llm.DAILY_TOKENS;
    const r = await post({ input: "hi" });
    assert.equal(r.status, 429);
    assert.match((await r.json()).error, /budget/);
    assert.equal(sent.length, before);
    charged = 0;
  });
});

describe("one named tool as the choice — \"answer now\" after a loop", () => {
  // Dropped before: a browse job told to finish kept going and ended with no
  // answer (booking.com's results, 2026-10-14).
  const tools = [{ type: "function", name: "finish", parameters: { type: "object" } }, { type: "function", name: "click", parameters: { type: "object" } }];
  test("passed on when it names an offered tool", async () => {
    const { sanitize } = await import("../dist/device/llm.js");
    const out = sanitize({ model: "gpt-5.6-luna", input: [{ role: "user", content: "x" }], tools, tool_choice: { type: "function", name: "finish" } });
    assert.deepEqual(out.req?.tool_choice, { type: "function", name: "finish" }, JSON.stringify(out));
  });
  test("not when it names one that isn't offered", async () => {
    const { sanitize } = await import("../dist/device/llm.js");
    const out = sanitize({ model: "gpt-5.6-luna", input: [{ role: "user", content: "x" }], tools, tool_choice: { type: "function", name: "send_money" } });
    assert.equal(out.req?.tool_choice, undefined);
  });
});
