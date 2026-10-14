// /device/memories — the Mac app's "Manage Memories…" window (2026-10-14):
// a paired device sees and edits its own chat's memories, and nobody else's.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import crypto from "node:crypto";

const memories = (await import("../dist/device/memories.js")).default;
const store = (await import("../dist/device/store.js")).default;

const MINE = "40700000001@s.whatsapp.net";
const THEIRS = "40700000002@s.whatsapp.net";
const oid = () => crypto.randomBytes(12).toString("hex");

describe("the routes", () => {
  const PORT = 3413;
  let server;
  // Stands in for Mongo the way the real helpers query it: {chatId, _id}.
  const rows = [];
  const mineId = oid(), theirsId = oid();
  const call = (method, path, body, token = "good") => fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  before(async () => {
    rows.push(
      { _id: mineId, chatId: MINE, summary: "likes window seats", details: "", tags: ["travel"], createdAt: new Date("2026-10-01") },
      { _id: theirsId, chatId: THEIRS, summary: "someone else's secret", details: "", tags: [], createdAt: new Date("2026-10-02") },
    );
    store.deviceForToken = async t => t === "good" ? { device_id: "d_mem", chat_id: MINE } : null;
    memories.db.list = async chatId => rows.filter(r => r.chatId === chatId).sort((a, b) => b.createdAt - a.createdAt);
    memories.db.add = async (chatId, summary, details, tags) => {
      const r = { _id: oid(), chatId, summary: summary.trim(), details: details || "", tags: tags || [], createdAt: new Date() };
      rows.push(r); return r;
    };
    memories.db.update = async (chatId, id, patch) => {
      const r = rows.find(x => x.chatId === chatId && x._id === id);
      if (!r) return null;
      Object.assign(r, patch); return r;
    };
    memories.db.remove = async (chatId, id) => {
      const i = rows.findIndex(x => x.chatId === chatId && x._id === id);
      if (i < 0) return false;
      rows.splice(i, 1); return true;
    };
    const app = express();
    app.use(express.json());
    memories.registerMemoryRoutes(app);
    server = http.createServer(app);
    await new Promise(r => server.listen(PORT, "127.0.0.1", r));
  });
  after(() => server.close());

  test("no device token, no memories — for every verb", async () => {
    for (const token of ["", "bad"]) {
      assert.equal((await call("GET", "/device/memories", undefined, token)).status, 401);
      assert.equal((await call("POST", "/device/memories", { summary: "x" }, token)).status, 401);
      assert.equal((await call("PATCH", `/device/memories/${mineId}`, { summary: "x" }, token)).status, 401);
      assert.equal((await call("DELETE", `/device/memories/${mineId}`, undefined, token)).status, 401);
    }
    assert.equal(rows.length, 2);
    assert.equal(rows.find(r => r._id === mineId).summary, "likes window seats");
  });

  test("the list is this chat's only, in the app's shape", async () => {
    const r = await call("GET", "/device/memories");
    assert.equal(r.status, 200);
    const list = await r.json();
    assert.deepEqual(list.map(x => x.id), [mineId]);
    assert.deepEqual(Object.keys(list[0]).sort(), ["createdAt", "details", "id", "summary", "tags"]);
    assert.deepEqual(list[0].tags, ["travel"]);
  });

  test("another chat's memory can't be edited or deleted — it is simply not found", async () => {
    assert.equal((await call("PATCH", `/device/memories/${theirsId}`, { summary: "mine now" })).status, 404);
    assert.equal((await call("DELETE", `/device/memories/${theirsId}`)).status, 404);
    const theirs = rows.find(r => r._id === theirsId);
    assert.equal(theirs.summary, "someone else's secret");
  });

  test("a malformed id is not found, not an error", async () => {
    assert.equal((await call("PATCH", "/device/memories/not-an-id", { summary: "x" })).status, 404);
    assert.equal((await call("DELETE", "/device/memories/%24where")).status, 404);
  });

  test("edit changes only the fields sent", async () => {
    const r = await call("PATCH", `/device/memories/${mineId}`, { details: "aisle on long flights", tags: ["travel", "flights"] });
    assert.equal(r.status, 200);
    const m = await r.json();
    assert.equal(m.summary, "likes window seats");
    assert.equal(m.details, "aisle on long flights");
    assert.deepEqual(m.tags, ["travel", "flights"]);
  });

  test("an edit can't blank the summary, and tags must be a list", async () => {
    assert.equal((await call("PATCH", `/device/memories/${mineId}`, { summary: "   " })).status, 400);
    assert.equal((await call("PATCH", `/device/memories/${mineId}`, { tags: "travel" })).status, 400);
    assert.equal(rows.find(r => r._id === mineId).summary, "likes window seats");
  });

  test("add puts it in this chat", async () => {
    assert.equal((await call("POST", "/device/memories", { details: "no summary" })).status, 400);
    const r = await call("POST", "/device/memories", { summary: "vegetarian", tags: ["food"] });
    assert.equal(r.status, 201);
    const m = await r.json();
    assert.equal(m.summary, "vegetarian");
    assert.equal(rows.find(x => x._id === m.id).chatId, MINE);
  });

  test("delete removes it", async () => {
    const r = await call("DELETE", `/device/memories/${mineId}`);
    assert.equal(r.status, 200);
    assert.ok(!rows.some(x => x._id === mineId));
    assert.equal((await call("DELETE", `/device/memories/${mineId}`)).status, 404);
  });
});
