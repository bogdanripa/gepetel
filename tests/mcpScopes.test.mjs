// Which scopes this app asks Google for.
//
// Google's MCP servers advertise their entire API in scopes_supported — twenty
// Gmail scopes including https://mail.google.com/ and gmail.messages.delete,
// twelve Calendar ones including calendar.acls. Asking for all of them because
// they were listed put scopes on the consent screen that no feature uses, and
// Google's verification refuses an app whose consent screen does not match what
// it asked to be verified for. These are the scopes we pin instead.
import { test } from "node:test";
import assert from "node:assert/strict";
const registry = (await import("../dist/mcpRegistry.js")).default;

test("Gmail and Calendar are pinned to the narrowest scope the features need", () => {
  assert.deepEqual(registry.pinnedScopesFor("https://gmailmcp.googleapis.com/mcp/v1"),
    ["https://www.googleapis.com/auth/gmail.modify"]);
  assert.deepEqual(registry.pinnedScopesFor("https://calendarmcp.googleapis.com/mcp/v1"),
    ["https://www.googleapis.com/auth/calendar.events"]);

  // Matched on the host, since by the time OAuth discovery runs the label the
  // person typed is gone.
  assert.deepEqual(registry.pinnedScopesFor("https://gmailmcp.googleapis.com/anything/else"),
    ["https://www.googleapis.com/auth/gmail.modify"]);
});

test("the scopes we must never ask for are not in the list", () => {
  const all = [
    ...registry.pinnedScopesFor("https://gmailmcp.googleapis.com/mcp/v1"),
    ...registry.pinnedScopesFor("https://calendarmcp.googleapis.com/mcp/v1"),
  ];
  for (const forbidden of [
    "https://mail.google.com/",                                 // the whole mailbox
    "https://www.googleapis.com/auth/gmail.messages.delete",    // permanent deletion
    "https://www.googleapis.com/auth/gmail.settings.basic",
    "https://www.googleapis.com/auth/gmail.settings.filters",
    "https://www.googleapis.com/auth/calendar",                 // the whole calendar
    "https://www.googleapis.com/auth/calendar.acls",            // sharing rules
  ]) assert.equal(all.includes(forbidden), false, `must not request ${forbidden}`);
  assert.equal(all.length, 2, "exactly the two scopes submitted for verification");
});

test("everything else still takes whatever its server advertises", () => {
  // Pinning is for servers that advertise more than the app uses. Trello, Linear
  // and the rest describe themselves accurately, so nothing is overridden.
  assert.equal(registry.pinnedScopesFor("https://mcp.trello.com/v1"), null);
  assert.equal(registry.pinnedScopesFor("https://mcp.linear.app/mcp"), null);
  assert.equal(registry.pinnedScopesFor("https://example.com/mcp"), null);
  assert.equal(registry.pinnedScopesFor("not a url"), null);
  assert.equal(registry.pinnedScopesFor(""), null);
});
