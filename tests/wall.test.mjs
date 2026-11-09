// The wall (wall.ts): working in a group, no read can reach a member's
// private chat — whatever the code or the model asks for.
import { test } from "node:test";
import assert from "node:assert/strict";
const wall = (await import("../dist/wall.js")).default;
const G = "120363392171791536@g.us", OTHER = "40723418290-1523522048@g.us", ME = "40723418290@s.whatsapp.net";

test("outside a group, nothing is walled", () => {
  assert.equal(wall.refuse("", "Memory", { chatId: ME }), "");
});

test("in a group: its own rows only", () => {
  assert.equal(wall.refuse(G, "Memory", { chatId: G }), "");
  assert.equal(wall.refuse(G, "Playbook", { chat_id: { $eq: G } }), "");
  assert.match(wall.refuse(G, "Memory", { chatId: ME }), /private chat/);
  assert.match(wall.refuse(G, "MemoryCard", { chat_id: { $in: [G, ME] } }), /private chat/);
  assert.match(wall.refuse(G, "Memory", { $or: [{ chatId: G }, { chatId: ME }] }), /private chat/);
  assert.match(wall.refuse(G, "Memory", { chatId: OTHER }), /another group/);
  assert.match(wall.refuse(G, "Memory", { chatId: { $ne: "x" } }), /left open/);
  assert.match(wall.refuse(G, "Memory", { chatId: /.*/ }), /private chat|open|another|check/);
});

test("in a group: what's only ever someone's own is never read, whatever the filter", () => {
  for (const model of ["PulseState", "GetToKnow", "Device", "UserMcpToken", "DmQuota"])
    assert.match(wall.refuse(G, model, { chat_id: G }), /never read from a group/);
});

test("a read not pinned by its filter runs only if every row it returns is this group's", () => {
  assert.equal(wall.refuse(G, "McpConnector", { _id: "abc" }), wall.CHECK_ROWS);
  assert.equal(wall.foreignRows(G, [{ chat_id: G }], "McpConnector"), "");
  assert.match(wall.foreignRows(G, [{ chat_id: G }, { chat_id: ME }], "McpConnector"), /private chat/);
  assert.match(wall.foreignRows(G, { chatId: OTHER }, "Memory"), /another group/);
});

test("shared directories stay readable: the group itself and people's names", () => {
  assert.equal(wall.refuse(G, "Person", { phoneNumber: { $in: ["40723418290"] } }), "");
  assert.equal(wall.refuse(G, "Group", { chatId: G }), "");
});

test("the scope follows the work, including what it starts in the background", async () => {
  assert.equal(wall.currentGroup(), "");
  await wall.inGroup(G, async () => {
    assert.equal(wall.currentGroup(), G);
    await new Promise(r => setTimeout(r, 5));
    await Promise.resolve().then(() => assert.equal(wall.currentGroup(), G));
  });
  assert.equal(wall.currentGroup(), "");
  assert.throws(() => wall.inGroup(ME, async () => {}), /not a group/);
});
