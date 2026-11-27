// Gmail and Calendar through Google's plain APIs (googleRest.ts), for a
// connector whose Google MCP server refuses its login. No network: every
// Google call goes to a fake fetch that records what was asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import g from "../dist/googleRest.js";
import gmailFiles from "../dist/gmailFiles.js";

function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.authorization });
    for (const [re, reply] of routes) {
      if (re.test(`${init.method || "GET"} ${url}`)) {
        const { status = 200, body = {} } = typeof reply === "function" ? reply(String(url), init) : reply;
        return { status, json: async () => body, text: async () => JSON.stringify(body) };
      }
    }
    return { status: 404, json: async () => ({ error: { message: "no route" } }), text: async () => "" };
  };
  f.calls = calls;
  return f;
}
const b64 = s => Buffer.from(s, "utf8").toString("base64url");

test("serviceOf: Google's two MCP hosts and our stand-in, nothing else", () => {
  assert.equal(g.serviceOf("https://gmailmcp.googleapis.com/mcp/v1"), "gmail");
  assert.equal(g.serviceOf("https://calendarmcp.googleapis.com/mcp/v1"), "calendar");
  assert.equal(g.serviceOf("https://gepetel.com/google-mcp/calendar"), "calendar");
  assert.equal(g.serviceOf("https://drivemcp.googleapis.com/mcp/v1"), null);
  assert.equal(g.isGoogleMcpHost("https://gepetel.com/google-mcp/gmail"), false);
  assert.ok(gmailFiles.isGmailServer("https://gepetel.com/google-mcp/gmail"), "attachments still find the Gmail connector once it is rerouted");
});

test("rerouted: only a connector marked for this chat, and only until it expires", () => {
  const entry = { type: "mcp", server_label: "gmail_work", server_url: "https://gmailmcp.googleapis.com/mcp/v1", authorization: "t" };
  assert.equal(g.rerouted("chat-a", entry), entry);
  g.routeHere("chat-a", "gmail_work", Date.now());
  const r = g.rerouted("chat-a", entry);
  assert.match(r.server_url, /\/google-mcp\/gmail$/);
  assert.equal(r.authorization, "t");
  assert.equal(g.rerouted("chat-b", entry), entry, "another chat's connector with the same label is untouched");
  assert.equal(g.routedHere("chat-a", "gmail_work", Date.now() + 13 * 3600_000), false, "tries Google's server again after 12 h");
});

test("mcpRefuses: Google's 401 invalid_token is a refusal; a working answer is not", async () => {
  const refuse = fakeFetch([[/gmailmcp/, { status: 401, body: { result: { content: [{ text: "Request had invalid authentication credentials." }], isError: true } } }]]);
  assert.equal(await g.mcpRefuses("https://gmailmcp.googleapis.com/mcp/v1", "t", refuse), true);
  assert.equal(refuse.calls[0].body.params.name, "list_labels");
  const fine = fakeFetch([[/calendarmcp/, { status: 200, body: { result: { content: [{ text: "{}" }] } } }]]);
  assert.equal(await g.mcpRefuses("https://calendarmcp.googleapis.com/mcp/v1", "t", fine), false);
});

test("handle: no token is a 401; tools/list names Google's own tools", async () => {
  const [s] = await g.handle("gmail", "", { id: 1, method: "tools/list" });
  assert.equal(s, 401);
  const [, list] = await g.handle("gmail", "Bearer t", { id: 2, method: "tools/list" });
  const names = list.result.tools.map(t => t.name);
  for (const n of ["search_threads", "get_thread", "list_labels", "create_draft", "trash_thread"]) assert.ok(names.includes(n), n);
  assert.ok(list.result.tools.find(t => t.name === "search_threads").annotations.readOnlyHint);
  assert.ok(!list.result.tools.find(t => t.name === "trash_thread").annotations.readOnlyHint);
});

test("search_threads: the query goes to Gmail, each thread comes back with who, what and when", async () => {
  const f = fakeFetch([
    [/GET .*\/threads\?/, { body: { threads: [{ id: "th1" }] } }],
    [/GET .*\/threads\/th1\?/, { body: { messages: [
      { id: "m1", labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "Ana <ana@x.ro>" }, { name: "Subject", value: "Oferta" }] } },
      { id: "m2", labelIds: ["INBOX", "UNREAD"], snippet: "Revin cu detalii", payload: { headers: [{ name: "From", value: "Dan <dan@y.ro>" }, { name: "Date", value: "Wed, 25 Nov 2026" }] } },
    ] } }],
  ]);
  const [, out] = await g.handle("gmail", "Bearer tok", { id: 1, method: "tools/call", params: { name: "search_threads", arguments: { query: "is:unread", pageSize: 99 } } }, f);
  const res = JSON.parse(out.result.content[0].text);
  assert.match(f.calls[0].url, /q=is%3Aunread/);
  assert.match(f.calls[0].url, /maxResults=25/);
  assert.equal(f.calls[0].auth, "Bearer tok", "the person's own token goes on to Google");
  assert.deepEqual({ subject: res.threads[0].subject, from: res.threads[0].from, lastFrom: res.threads[0].lastFrom, unread: res.threads[0].unread, messages: res.threads[0].messages },
    { subject: "Oferta", from: "Ana <ana@x.ro>", lastFrom: "Dan <dan@y.ro>", unread: true, messages: 2 });
});

test("get_message: the text part, or the HTML with its tags taken out, and the files by name", () => {
  const plain = g.messageView({ id: "m", threadId: "t", payload: { mimeType: "multipart/mixed", parts: [
    { mimeType: "text/plain", body: { data: b64("Salut,\nfactura e atașată.") } },
    { mimeType: "application/pdf", filename: "factura.pdf", body: { attachmentId: "a1", size: 1200 } },
  ] } });
  assert.equal(plain.body, "Salut,\nfactura e atașată.");
  assert.deepEqual(plain.attachments, [{ filename: "factura.pdf", mimeType: "application/pdf", size: 1200 }]);
  const html = g.bodyText({ mimeType: "text/html", body: { data: b64("<style>p{}</style><p>Hello&nbsp;<b>there</b></p><p>bye</p>") } });
  assert.equal(html, "Hello there\nbye");
});

test("create_draft as a reply: addressed and threaded from the original, not from the model", async () => {
  const f = fakeFetch([
    [/GET .*\/messages\/orig\?/, { body: { threadId: "th9", payload: { headers: [
      { name: "Message-ID", value: "<abc@mail>" }, { name: "Subject", value: "Programare" }, { name: "From", value: "clinica@x.ro" },
    ] } } }],
    [/POST .*\/drafts$/, { body: { id: "d1", message: { id: "m7", threadId: "th9" } } }],
  ]);
  const out = await g.callTool("gmail", "create_draft", { body: "Confirm, mulțumesc.", replyToMessageId: "orig" }, "t", f);
  assert.equal(out.to, "clinica@x.ro");
  assert.equal(out.subject, "Re: Programare");
  const sent = f.calls.find(c => c.method === "POST");
  assert.equal(sent.body.message.threadId, "th9");
  const mime = Buffer.from(sent.body.message.raw, "base64url").toString("utf8");
  assert.match(mime, /In-Reply-To: <abc@mail>/);
});

test("Gmail refusing the token is a 401 for the connection; any other refusal is the tool's answer", async () => {
  const f401 = fakeFetch([[/labels/, { status: 401, body: { error: { message: "Invalid Credentials" } } }]]);
  const [s1, b1] = await g.handle("gmail", "Bearer t", { id: 1, method: "tools/call", params: { name: "list_labels", arguments: {} } }, f401);
  assert.equal(s1, 401);
  assert.ok(b1.error);
  const f404 = fakeFetch([[/threads\/nope/, { status: 404, body: { error: { message: "Requested entity was not found." } } }]]);
  const [s2, b2] = await g.handle("gmail", "Bearer t", { id: 2, method: "tools/call", params: { name: "get_thread", arguments: { threadId: "nope" } } }, f404);
  assert.equal(s2, 200);
  assert.equal(b2.result.isError, true);
  assert.match(b2.result.content[0].text, /not found/);
});

test("when: a time with an offset keeps it; one without takes the calendar's zone; a date is all-day", () => {
  assert.deepEqual(g.when("2026-11-27T09:00:00+02:00", false, "Europe/Bucharest"), { dateTime: "2026-11-27T09:00:00+02:00" });
  assert.deepEqual(g.when("2026-11-27T09:00", false, "Europe/Bucharest"), { dateTime: "2026-11-27T09:00:00", timeZone: "Europe/Bucharest" });
  assert.deepEqual(g.when("2026-11-27", false, "UTC"), { date: "2026-11-27" });
  assert.deepEqual(g.when("2026-11-27T00:00:00Z", true, "UTC"), { date: "2026-11-27" });
});

test("list_events: from now on, one row per occurrence, soonest first", async () => {
  const f = fakeFetch([[/GET .*\/calendars\/primary\/events\?/, { body: { timeZone: "Europe/Bucharest", items: [{ id: "e1", summary: "Tenis", start: { dateTime: "2026-11-27T10:00:00+02:00" }, attendees: [{ email: "a@x.ro", self: true, responseStatus: "accepted" }] }] } }]]);
  const out = await g.callTool("calendar", "list_events", {}, "t", f);
  assert.match(f.calls[0].url, /singleEvents=true/);
  assert.match(f.calls[0].url, /orderBy=startTime/);
  assert.match(f.calls[0].url, /timeMin=/);
  assert.equal(out.events[0].summary, "Tenis");
  assert.equal(out.timeZone, "Europe/Bucharest");
});

test("create_event: a time without an offset is read in the calendar's own zone; guests get an email by default", async () => {
  const f = fakeFetch([
    [/GET .*\/events\?maxResults=1/, { body: { timeZone: "Europe/Bucharest", items: [] } }],
    [/POST .*\/events/, (url, init) => ({ body: { id: "new", ...JSON.parse(init.body) } })],
  ]);
  const out = await g.callTool("calendar", "create_event", { summary: "Dentist", startTime: "2026-11-30T10:00", endTime: "2026-11-30T11:00", attendeeEmails: ["dan@y.ro"] }, "t", f);
  const post = f.calls.find(c => c.method === "POST");
  assert.match(post.url, /sendUpdates=all/);
  assert.deepEqual(post.body.start, { dateTime: "2026-11-30T10:00:00", timeZone: "Europe/Bucharest" });
  assert.deepEqual(post.body.attendees, [{ email: "dan@y.ro" }]);
  assert.equal(out.id, "new");
});

test("update_event: guests added and removed against the current list, nothing else touched", async () => {
  const f = fakeFetch([
    [/GET .*\/events\/e1$/, { body: { id: "e1", attendees: [{ email: "A@x.ro" }, { email: "b@x.ro" }] } }],
    [/PATCH .*\/events\/e1/, (url, init) => ({ body: { id: "e1", ...JSON.parse(init.body) } })],
  ]);
  await g.callTool("calendar", "update_event", { eventId: "e1", addedAttendeeEmails: ["c@x.ro", "b@x.ro"], removedAttendeeEmails: ["a@x.ro"] }, "t", f);
  const patch = f.calls.find(c => c.method === "PATCH");
  assert.deepEqual(patch.body, { attendees: [{ email: "b@x.ro" }, { email: "c@x.ro" }] });
});

test("respond_to_event: their own answer on the guest list; not a guest, nothing to answer", async () => {
  const f = fakeFetch([
    [/GET .*\/events\/e2$/, { body: { id: "e2", attendees: [{ email: "org@x.ro", responseStatus: "accepted" }, { email: "me@x.ro", self: true, responseStatus: "needsAction" }] } }],
    [/PATCH .*\/events\/e2/, (url, init) => ({ body: { id: "e2", ...JSON.parse(init.body) } })],
  ]);
  const out = await g.callTool("calendar", "respond_to_event", { eventId: "e2", responseStatus: "DECLINED" }, "t", f);
  assert.equal(out.attendees.find(a => a.self).responseStatus, "declined");
  const none = fakeFetch([[/GET .*\/events\/e3$/, { body: { id: "e3", attendees: [{ email: "org@x.ro" }] } }]]);
  await assert.rejects(g.callTool("calendar", "respond_to_event", { eventId: "e3", responseStatus: "accepted" }, "t", none), /not on this event's guest list/);
});

test("list_calendars: a sign-in that covers events only still offers the primary calendar", async () => {
  const f = fakeFetch([[/calendarList/, { status: 403, body: { error: { message: "Insufficient Permission" } } }]]);
  const out = await g.callTool("calendar", "list_calendars", {}, "t", f);
  assert.equal(out.calendars[0].id, "primary");
});
