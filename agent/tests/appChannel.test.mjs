// The app's request/answer lines (osInput, people, passwords): one plumbing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appChannel } from "../dist/appChannel.js";

const make = () => appChannel({ tag: "people", done: "people-done", idPrefix: "p", timeoutMs: 50, read: m => ({ ok: m.ok === true, why: String(m.why || ""), ...(typeof m.value === "string" ? { value: m.value.slice(0, 5) } : {}) }) });

test("not under the app: no line out, a plain answer", async () => {
  const c = make();
  assert.equal(c.available(), false);
  assert.deepEqual(await c.ask({ op: "list" }), { ok: false, why: "not running under the Gepetel app" });
});

test("a line out with an id; the answer with that id resolves it, read and cut to size", async () => {
  const c = make(); const out = [];
  c.enable(l => out.push(l));
  const p = c.ask({ op: "value", person: "Ana", label: "phone" });
  assert.match(out[0], /^@people \{"op":"value","person":"Ana","label":"phone","id":"p1"\}$/);
  assert.equal(c.answer({ t: "input-done", id: "p1" }), false, "another channel's answer isn't ours");
  assert.equal(c.answer({ t: "people-done", id: "p1", ok: true, value: "0722123456" }), true);
  assert.deepEqual(await p, { ok: true, why: "", value: "07221" });
});

test("no answer in time: says so; a late answer is still taken as ours, and ignored", async () => {
  const c = make(); c.enable(() => {});
  assert.deepEqual(await c.ask({ op: "list" }), { ok: false, why: "the app didn't answer" });
  assert.equal(c.answer({ t: "people-done", id: "p1", ok: true }), true);
});
