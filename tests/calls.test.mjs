// A call to Gepetel's number (2026-10-30): the gateway rejects it and sends
// Meta's `calls` change; the relay reads it and has a note for the caller.
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.OPENAI_API_KEY ||= "test-not-a-key";
const gw = (await import("../dist/wagateway.js")).default;

test("a rejected call arrives as an event; the caller's note says messages and voice messages are read", async () => {
  const body = { object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field: "calls", value: { messaging_product: "whatsapp", metadata: {}, calls: [{ id: "C1", from: "40711111111", event: "connect", type: "video", status: "rejected" }, { id: "C2", from: "40722222222", event: "terminate" }] } }] }] };
  const ev = gw.parseWebhook(body);
  assert.deepEqual(ev.calls, [{ from: "40711111111", video: true }]);
  assert.deepEqual(ev.messages, []);
  const { callNote } = await import("../dist/util.js");
  assert.match(callNote("English"), /only read messages.*voice message/);
  assert.match(callNote("Romanian"), /citesc mesajele.*mesaj vocal/);
});
