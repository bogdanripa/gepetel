// A connection whose login stopped working: the person is told, once, with a
// link that signs it in again (reauth.ts). No DB, no network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import r from "../dist/reauth.js";
import { loginVerdict } from "../dist/mcp.js";

const ME = "40700000001@s.whatsapp.net";
const GROUP = "40700000001-1234567890@g.us";
const conn = (over = {}) => ({ connector_id: "c1", chat_id: ME, label: "Gmail (ana@example.com)", server_url: "https://mail.example/mcp", auth_kind: "oauth", added_by: "40700000001", headers: { Authorization: "Bearer T" }, ...over });

function setup(over = {}) {
  const x = { said: [], probes: 0, claims: 0, released: 0, hour: 11, probe: "refused", language: "English", claimed: false, sends: true, row: conn(), ...over };
  const deps = {
    connector: async () => x.row,
    probe: async () => { x.probes++; return x.probe; },
    localHour: () => x.hour,
    language: async () => x.language,
    groupName: async () => "Trip to Vama",
    claim: async () => { x.claims++; if (x.claimed) return false; x.claimed = true; return true; },
    release: async () => { x.released++; x.claimed = false; },
    link: async () => "https://gepetel.example/r/TOKEN",
    say: async (chat, text) => { x.said.push([chat, text]); return x.sends; },
    log: () => {},
  };
  return { x, ask: (why = "failing", chat = ME) => r.askToReconnect(chat, "gmail_ana_example_com", why, deps) };
}

describe("when the person is told", () => {
  test("a login the provider refused to renew: told, with the link, in their own chat", async () => {
    const { x, ask } = setup();
    assert.equal(await ask("lapsed"), "asked");
    assert.equal(x.probes, 0, "nothing to find out: the provider already said no");
    assert.equal(x.said.length, 1);
    assert.equal(x.said[0][0], ME);
    assert.match(x.said[0][1], /Your Gmail \(ana@example\.com\) connection has stopped working: its login has expired/);
    assert.match(x.said[0][1], /\nhttps:\/\/gepetel\.example\/r\/TOKEN$/, "the link bare, on its own line, last");
  });

  test("a connection that keeps failing: the server is asked first, and only a refused login counts", async () => {
    const refused = setup();
    assert.equal(await refused.ask("failing"), "asked");
    assert.equal(refused.x.probes, 1);
    assert.match(refused.x.said[0][1], /the service no longer accepts my login/);
    for (const probe of ["unclear", "answers"]) {
      const down = setup({ probe });
      assert.equal(await down.ask("failing"), "not a login problem", `${probe}: the service is down, signing in again fixes nothing`);
      assert.deepEqual(down.x.said, []);
      assert.equal(down.x.claims, 0);
    }
  });

  test("once: a second failure, a second reply, a second process all find it already said", async () => {
    const { x, ask } = setup();
    assert.equal(await ask(), "asked");
    assert.equal(await ask(), "asked already");
    assert.equal(await ask("lapsed"), "asked already");
    assert.equal(x.said.length, 1);
  });

  test("two at the same moment: one message", async () => {
    const { x, ask } = setup();
    const both = await Promise.all([ask(), ask()]);
    assert.deepEqual(both.sort(), ["asked", "busy"]);
    assert.equal(x.said.length, 1);
  });

  test("not at night — and the turn isn't used up, so the morning's first failure says it", async () => {
    const { x, ask } = setup({ hour: 3 });
    assert.equal(await ask(), "night");
    assert.equal(x.claims, 0);
    assert.deepEqual(x.said, []);
    x.hour = 22; assert.equal(await ask(), "night");
    x.hour = 8; assert.equal(await ask(), "asked");
    assert.equal(x.said.length, 1);
  });

  test("a message that didn't go out gives the turn back", async () => {
    const { x, ask } = setup({ sends: false });
    assert.equal(await ask(), "not sent");
    assert.equal(x.released, 1);
    x.sends = true;
    assert.equal(await ask(), "asked");
  });

  test("their own computer is never a login to redo; a connection that's gone is nothing", async () => {
    for (const row of [conn({ auth_kind: "device" }), conn({ auth_kind: "headers", server_url: "https://gepetel.example/device/abc/mcp" })]) {
      const { x, ask } = setup({ row });
      assert.equal(await ask(), "not a login");
      assert.deepEqual(x.said, []);
      assert.equal(x.probes, 0);
    }
    const gone = setup({ row: null });
    assert.equal(await gone.ask(), "no such connection");
  });
});

describe("what they're told", () => {
  test("a group's connection: whoever connected it hears, privately, and which group it is", async () => {
    const { x, ask } = setup({ row: conn({ chat_id: GROUP, label: "Trello", added_by: "40700000002" }) });
    assert.equal(await ask("lapsed", GROUP), "asked");
    assert.equal(x.said[0][0], "40700000002@s.whatsapp.net");
    assert.match(x.said[0][1], /^The Trello connection in the group "Trip to Vama" has stopped working/);
    const nobody = setup({ row: conn({ chat_id: GROUP, added_by: "" }) });
    assert.equal(await nobody.ask("lapsed", GROUP), "no such connection");
  });

  test("a key can't be renewed from a link: they're asked for a new one", async () => {
    const { x, ask } = setup({ row: conn({ auth_kind: "headers", label: "Trello" }) });
    assert.equal(await ask(), "asked");
    assert.doesNotMatch(x.said[0][1], /https?:\/\//);
    assert.match(x.said[0][1], /Send me a new key here/);
  });

  test("in their language", () => {
    const ro = r.reauthMessage("Romanian", { label: "Gmail (ana@example.com)", link: "https://gepetel.example/r/T", why: "failing" });
    assert.match(ro, /^Conexiunea ta Gmail \(ana@example\.com\) nu mai merge: serviciul nu-mi mai acceptă autentificarea\./);
    assert.match(ro, /\nhttps:\/\/gepetel\.example\/r\/T$/);
    assert.match(r.reauthMessage("Romanian", { label: "Trello", link: "", group: "Excursie", why: "lapsed" }), /^Conexiunea Trello din grupul „Excursie” nu mai merge: autentificarea a expirat\..*cheie nouă/s);
  });
});

describe("what a server's answer says about the login", () => {
  test("401, or the token named as the problem: refused — even with a full tool list in the body", () => {
    assert.equal(loginVerdict(401, 'Bearer realm="https://accounts.example/", error="invalid_token"'), "refused");
    assert.equal(loginVerdict(401), "refused");
    assert.equal(loginVerdict(403, 'Bearer error="invalid_token"'), "refused");
  });
  test("a 403 alone is not a dead login: a call the login doesn't cover, or a service that puts one on good answers", () => {
    assert.equal(loginVerdict(403, 'Bearer error="insufficient_scope", scope="x"'), "unclear");
    assert.equal(loginVerdict(403), "unclear");
  });
  test("an outage is not a login problem", () => {
    for (const s of [500, 502, 503, 429, 404]) assert.equal(loginVerdict(s), "unclear", String(s));
    assert.equal(loginVerdict(200), "answers");
  });
  test("which outcomes mean the login is what's wrong", () => {
    for (const o of ["asked", "asked already", "night", "not sent"]) assert.equal(r.loginIsTheProblem(o), true, o);
    for (const o of ["not a login problem", "not a login", "no such connection", "busy"]) assert.equal(r.loginIsTheProblem(o), false, o);
  });
});
