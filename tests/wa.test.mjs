// Tests for the WhatsApp provider switch (src/wa.ts) and the two webhook
// parsers. No DB, no network: parseWebhook is pure, and provider selection is
// just an environment variable.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import wa from "../dist/wa.js";
import whapi from "../dist/whapi.js";
import gateway from "../dist/wagateway.js";

// A whapi delivery: two messages (one of them ours), a group and a poll update.
const WHAPI_BODY = {
  messages: [
    {
      id: "wamid.1", chat_id: "120363012345678901@g.us", from: "40750271099",
      from_name: "Bogdan", chat_name: "Team lunch", type: "text", text: { body: "hey @gepetel" },
    },
    {
      id: "wamid.2", chat_id: "40712345678@s.whatsapp.net", from: "40712345678",
      from_name: "Ana", type: "image", image: { link: "https://x/full.jpg", preview: "BASE64", caption: "look" },
    },
    { id: "wamid.3", chat_id: "40712345678@s.whatsapp.net", from_me: true, type: "text", text: { body: "my own reply" } },
  ],
  groups: [{ id: "120363012345678901@g.us", name: "Team lunch", participants: [{ id: "40750271099", name: "Bogdan" }] }],
  contacts: [{ id: "40712345678", name: "Ana" }],
  messages_updates: [
    { after_update: { id: "wamid.poll", type: "poll", poll: { total: 2, results: [{ name: "Pizza", count: 2, voters: ["40712345678"] }] } } },
  ],
};

// The same delivery as wa-gateway sends it: Meta's envelope, one change per field.
const GATEWAY_BODY = {
  object: "whatsapp_business_account",
  entry: [{
    id: "WABA", changes: [
      {
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "40723418290", phone_number_id: "gepetel" },
          contacts: [{ profile: { name: "Bogdan" }, wa_id: "40750271099" }],
          messages: [{
            from: "40750271099", group_id: "120363012345678901@g.us", id: "3EB01",
            timestamp: "1754300000", type: "text", text: { body: "hey @gepetel" },
          }],
        },
      },
      {
        field: "messages",
        value: {
          contacts: [{ profile: { name: "Ana" }, wa_id: "40712345678" }],
          messages: [{ from: "40712345678", id: "3EB02", type: "image", image: { link: "https://x/full.jpg", caption: "look" } }],
        },
      },
      {
        field: "group_participants_update",
        value: { groups: [{ group_id: "120363012345678901@g.us", subject: "Team lunch", participants: [{ wa_id: "40750271099", name: "Bogdan" }] }] },
      },
      { field: "contacts", value: { contacts: [{ profile: { name: "Ana" }, wa_id: "40712345678" }] } },
      {
        field: "message_polls",
        value: { polls: [{ id: "3EBpoll", group_id: "120363012345678901@g.us", name: "Lunch?", total: 2, results: [{ name: "Pizza", count: 2, voters: ["40712345678"] }] }] },
      },
      { field: "statuses", value: { statuses: [{ id: "3EB01", status: "delivered" }] } },   // ignored
    ],
  }],
};

describe("provider selection", () => {
  beforeEach(() => { delete process.env.WA_PROVIDER; });

  test("defaults to whapi", () => {
    assert.equal(wa.providerName(), "whapi");
  });
  test("WA_PROVIDER=wa-gateway switches everything over", () => {
    process.env.WA_PROVIDER = "wa-gateway";
    assert.equal(wa.providerName(), "wa-gateway");
  });
  test("spelling variants and case are tolerated", () => {
    for (const v of ["WA-Gateway", "wagateway", " gateway "]) {
      process.env.WA_PROVIDER = v;
      assert.equal(wa.providerName(), "wa-gateway", v);
    }
  });
  test("an unknown value falls back to whapi rather than breaking every send", () => {
    process.env.WA_PROVIDER = "nope";
    assert.equal(wa.providerName(), "whapi");
  });
});

describe("whapi webhook parsing", () => {
  const e = whapi.parseWebhook(WHAPI_BODY);

  test("skips our own messages", () => {
    assert.equal(e.messages.length, 2);
    assert.ok(!e.messages.some(msg => msg.id === "wamid.3"));
  });
  test("text, author and chat come through", () => {
    const [first] = e.messages;
    assert.equal(first.text, "hey @gepetel");
    assert.equal(first.chatId, "120363012345678901@g.us");
    assert.equal(first.fromName, "Bogdan");
    assert.equal(first.chatName, "Team lunch");
  });
  test("an image prefers the full-res link over the thumbnail", () => {
    assert.deepEqual(e.messages[1].image, { link: "https://x/full.jpg", caption: "look" });
  });
  test("groups, contacts and poll tallies", () => {
    assert.equal(e.groups[0].name, "Team lunch");
    assert.deepEqual(e.groups[0].participants, [{ id: "40750271099", name: "Bogdan" }]);
    assert.deepEqual(e.contacts, [{ id: "40712345678", name: "Ana" }]);
    assert.equal(e.polls[0].id, "wamid.poll");
    assert.equal(e.polls[0].poll.results[0].count, 2);
  });
});

describe("wa-gateway webhook parsing", () => {
  const e = gateway.parseWebhook(GATEWAY_BODY);

  test("a group message keeps the group jid as its chat id", () => {
    assert.equal(e.messages[0].chatId, "120363012345678901@g.us");
    assert.equal(e.messages[0].text, "hey @gepetel");
    assert.equal(e.messages[0].fromName, "Bogdan");   // resolved from contacts[]
  });
  test("a 1:1 chat id keeps the stored '@s.whatsapp.net' form, so histories don't fork", () => {
    assert.equal(e.messages[1].chatId, "40712345678@s.whatsapp.net");
    assert.deepEqual(e.messages[1].image, { link: "https://x/full.jpg", caption: "look" });
  });
  test("group updates, contacts and polls land in the same places as whapi's", () => {
    assert.equal(e.groups[0].id, "120363012345678901@g.us");
    assert.equal(e.groups[0].name, "Team lunch");
    assert.deepEqual(e.groups[0].participants, [{ id: "40750271099", name: "Bogdan" }]);
    assert.deepEqual(e.contacts, [{ id: "40712345678", name: "Ana" }]);
    assert.equal(e.polls[0].id, "3EBpoll");
    assert.equal(e.polls[0].poll.total, 2);
  });
  test("unknown fields are ignored, not crashed on", () => {
    assert.equal(e.messages.length, 2);
  });
  test("an inbound video is treated as a gif (WhatsApp sends GIFs as video)", () => {
    const [msg] = gateway.parseWebhook({
      entry: [{ changes: [{ field: "messages", value: { messages: [{ from: "40712345678", id: "v1", type: "video", video: { link: "https://x/c.mp4", caption: "lol" } }] } }] }],
    }).messages;
    assert.deepEqual(msg.gif, { link: "https://x/c.mp4", caption: "lol" });
  });
});

describe("wa.parseWebhook routes by payload shape, not by WA_PROVIDER", () => {
  beforeEach(() => { delete process.env.WA_PROVIDER; });

  test("a Meta envelope is parsed as wa-gateway even while whapi is configured", () => {
    const e = wa.parseWebhook(GATEWAY_BODY);
    assert.equal(e.messages.length, 2);
    assert.equal(e.messages[0].chatId, "120363012345678901@g.us");
  });
  test("a whapi payload still works after the switch is flipped", () => {
    process.env.WA_PROVIDER = "wa-gateway";
    const e = wa.parseWebhook(WHAPI_BODY);
    assert.equal(e.messages.length, 2);
    assert.equal(e.messages[0].text, "hey @gepetel");
  });
  test("junk in, empty events out", () => {
    for (const body of [undefined, null, {}, { messages: null }, { entry: [] }]) {
      const e = wa.parseWebhook(body);
      assert.deepEqual([e.messages.length, e.groups.length, e.contacts.length, e.polls.length], [0, 0, 0, 0]);
    }
  });
});

describe("webhook auth", () => {
  const reqWith = (token) => ({ get: (h) => (h.toLowerCase() === "x-wa-gateway-token" && token ? token : undefined) });
  beforeEach(() => { delete process.env.WA_GATEWAY_TOKEN; });

  test("no header (whapi) is accepted", () => {
    assert.equal(wa.webhookAuthOk(reqWith(null)), true);
  });
  test("a matching token is accepted, a wrong one is not", () => {
    process.env.WA_GATEWAY_TOKEN = "s3cret";
    assert.equal(wa.webhookAuthOk(reqWith("s3cret")), true);
    assert.equal(wa.webhookAuthOk(reqWith("wrong")), false);
  });
  test("with no configured token there is nothing to check against", () => {
    assert.equal(wa.webhookAuthOk(reqWith("anything")), true);
  });
});
