// Email attachments sent on WhatsApp (gmailFiles.ts): which parts are files,
// which one they meant, and what comes back when Gmail says no.
import { test } from "node:test";
import assert from "node:assert/strict";
const g = (await import("../dist/gmailFiles.js")).default;

const payload = { mimeType: "multipart/mixed", parts: [
  { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", filename: "", body: { data: "aGk" } }] },
  { mimeType: "application/pdf", filename: "Beyond GEO AI Recommendation Intelligence.pdf", body: { attachmentId: "A1", size: 1000 } },
  { mimeType: "image/png", filename: "logo.png", body: { data: Buffer.from("png").toString("base64url"), size: 3 } },
] };

test("the files in a message, and the one they meant", () => {
  const parts = g.attachmentParts(payload);
  assert.deepEqual(parts.map(p => p.filename), ["Beyond GEO AI Recommendation Intelligence.pdf", "logo.png"]);
  assert.deepEqual(g.pick(parts, "beyond geo").map(p => p.filename), ["Beyond GEO AI Recommendation Intelligence.pdf"]);
  assert.deepEqual(g.pick(parts, "recommendation intelligence pdf").map(p => p.filename), ["Beyond GEO AI Recommendation Intelligence.pdf"]);
  assert.equal(g.pick(parts, "").length, 2);
  assert.equal(g.pick(parts, "budget").length, 0);
  assert.equal(g.isGmailServer("https://gmailmcp.googleapis.com/mcp/v1"), true);
  assert.equal(g.isGmailServer("https://evil.example/gmailmcp.googleapis.com"), false);
});

const fake = (routes) => async (url) => {
  const path = new URL(url).pathname.replace("/gmail/v1/users/me", "");
  const hit = Object.entries(routes).find(([k]) => path.startsWith(k));
  const [status, body] = hit ? hit[1] : [404, {}];
  return { status, json: async () => body };
};

test("a thread id: the newest message with the file, fetched by its attachment id", async () => {
  const f = await g.fetchAttachments("t", "T1", "beyond", fake({
    "/messages/T1": [404, {}],
    "/threads/T1": [200, { messages: [{ id: "M1", payload }, { id: "M2", payload: { parts: [] } }] }],
    "/messages/M1/attachments/A1": [200, { data: Buffer.from("%PDF").toString("base64url") }],
  }));
  assert.equal(f.error, undefined);
  assert.equal(f.files[0].filename, "Beyond GEO AI Recommendation Intelligence.pdf");
  assert.equal(f.files[0].mimetype, "application/pdf");
  assert.equal(f.files[0].data.toString(), "%PDF");
});

test("Gmail switched off for the project, or no such file: said as such", async () => {
  const off = [403, { error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } }];
  assert.equal((await g.fetchAttachments("t", "M1", "", fake({ "/messages/M1": off, "/threads/M1": off }))).error, "service_disabled");
  assert.equal((await g.fetchAttachments("t", "M1", "budget", fake({ "/messages/M1": [200, { id: "M1", payload }] }))).error, "no_such_file");
  const big = { parts: [{ filename: "huge.zip", mimeType: "application/zip", body: { attachmentId: "Z", size: 50 * 1024 * 1024 } }] };
  const r = await g.fetchAttachments("t", "M1", "", fake({ "/messages/M1": [200, { id: "M1", payload: big }] }));
  assert.deepEqual([r.files.length, r.skipped.length], [0, 1]);
});
