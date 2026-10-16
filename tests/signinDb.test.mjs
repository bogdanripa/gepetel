// Sign-in links (signin.ts) against a real database — set TEST_DATABASE_URL.
// A relay restart (a deploy) once ended a bank sign-in link four seconds after
// it was sent (2026-10-16): the links are kept in the database as well.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL (a throwaway DB) to run";
const PORT = 3415;
const FAKE_PW = ["fake", "pw", "db"].join("-");
let mongoose, server, sent = [];

// A fresh copy of the module: what the server that comes up after a restart sees.
const fresh = async n => (await import(`../dist/device/signin.js?restart=${n}`)).default;

before(async () => {
  if (skip) return;
  mongoose = (await import("mongoose")).default;
  await mongoose.connect(TEST_DB);
  await mongoose.connection.collection("signinlinks").deleteMany({}).catch(() => {});
  const { bridge } = await import("../dist/device/takeover.js");
  bridge.toDevice = (d, m) => { sent.push([d, m]); return true; };
});
after(async () => { if (!skip) { server?.close(); await mongoose.connection.collection("signinlinks").deleteMany({}).catch(() => {}); await mongoose.disconnect(); } });

const until = async f => { for (let i = 0; i < 50; i++) { if (await f()) return; await new Promise(r => setTimeout(r, 20)); } };

test("a link survives a restart; still one use; a preview doesn't use it up; a job's end ends it", { skip }, async () => {
  const before = await fresh(1);
  const url = before.mint({ job_id: "j_db1", device_id: "d_1", site: "bancatransilvania.ro", username: "", needUser: true, ro: false });
  await until(async () => await mongoose.connection.collection("signinlinks").countDocuments({ job_id: "j_db1" }) === 1);

  const after_ = await fresh(2);
  const app = express();
  after_.registerSignInRoutes(app);
  server = http.createServer(app);
  await new Promise(r => server.listen(PORT, "127.0.0.1", r));
  const p = `http://127.0.0.1:${PORT}${new URL(url).pathname}`;
  const post = body => fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  assert.equal((await fetch(p)).status, 200, "the new server knows it");
  assert.equal((await fetch(p)).status, 200, "looking twice (a preview, then them) is fine");
  assert.equal((await post({ username: "me", password: FAKE_PW })).status, 200);
  assert.equal(sent.at(-1)[1].job, "j_db1");
  await until(async () => await mongoose.connection.collection("signinlinks").countDocuments({ job_id: "j_db1" }) === 0);
  assert.equal(await mongoose.connection.collection("signinlinks").countDocuments({ job_id: "j_db1" }), 0, "gone from the database once used");
  assert.equal((await post({ password: "again" })).status, 410, "one use");

  const ended = before.mint({ job_id: "j_db2", device_id: "d_1", site: "x.test", username: "", needUser: false, ro: false });
  await until(async () => await mongoose.connection.collection("signinlinks").countDocuments({ job_id: "j_db2" }) === 1);
  after_.endJob("j_db2");
  await until(async () => await mongoose.connection.collection("signinlinks").countDocuments({ job_id: "j_db2" }) === 0);
  assert.equal((await fetch(`http://127.0.0.1:${PORT}${new URL(ended).pathname}`)).status, 410);
});
