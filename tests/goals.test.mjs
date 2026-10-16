// A 1:1 request carried to its end (goals.ts): what a reply waits for, and the check.
import { test } from "node:test";
import assert from "node:assert/strict";
const goals = (await import("../dist/goals.js")).default;

test("a reply waits for a login link, or a job still running on their computer — not a connection made", () => {
  assert.equal(goals.waitsIn([{ kind: "tool", name: "add_mcp_connector", result: { label: "Google Calendar", authorize_url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" } }]), "a login (Google Calendar)");
  assert.equal(goals.waitsIn([{ kind: "tool", name: "add_mcp_connector", result: { connected: true, label: "Trello" } }]), "");
  assert.equal(goals.waitsIn([{ kind: "mcp", name: "browse", output: '{"job":"j_1","status":"running","note":"…"}' }]), "their computer");
  assert.equal(goals.waitsIn([{ kind: "mcp", name: "read_url", output: '{"status":"running"}' }]), "");
});

test("the check is asked about their words, and read back", () => {
  const req = goals.goalCheckRequest("When is my next ski trip?", ["Google Calendar is connected."]);
  assert.match(req.input[0].content[0].text, /When is my next ski trip\?[^]*Google Calendar is connected/);
  assert.match(req.instructions, /only promised, set something up \(a connection, a login\)/);
  assert.deepEqual(goals.readGoalCheck({ output: [{ type: "function_call", name: "goal_check", arguments: '{"achieved":false,"missing":"read the calendar"}' }] }), { achieved: false, missing: "read the calendar" });
  assert.equal(goals.readGoalCheck({ output: [] }), null);
});

test("the note a turn gets keeps their words and the stopping rules", () => {
  const n = goals.goalNote({ chatId: "x", asked: "When is my next ski trip?", waitingFor: "", continues: 0, lastMissing: "", updatedAt: new Date() });
  assert.match(n, /When is my next ski trip\?/);
  assert.match(n, /ask one clear question/);
});
