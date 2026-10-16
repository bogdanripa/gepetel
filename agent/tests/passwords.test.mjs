// Sign-ins and codes (Phase 10): what a page asks for, read from its snapshot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInFields, codeRequest, isTheirNumber, codeIn, codeFromFeed } from "../dist/passwords.js";

test("a sign-in form's boxes, by their names; a search box is not a username", () => {
  const f = signInFields(`- textbox "Email or phone" [ref=e1]\n- textbox "Password" [ref=e2]\n- button "Sign in" [ref=e3]`);
  assert.deepEqual(f, { user: { name: "Email or phone", ref: "e1" }, password: { name: "Password", ref: "e2" } });
  assert.deepEqual(signInFields(`- searchbox "Search account settings" [ref=e1]`), {});
  assert.deepEqual(signInFields(`- textbox "Parola" [ref=e9]`), { password: { name: "Parola", ref: "e9" } });
});

test("a code page: where the code went", () => {
  const sms = codeRequest(`- heading "Enter the code" [level=1]\n- paragraph: We texted a code to •••• ••34.\n- textbox "Code" [ref=e5]`);
  assert.equal(sms.via, "sms"); assert.equal(sms.last, "34"); assert.equal(sms.field.ref, "e5");
  const mail = codeRequest(`- paragraph: We sent a verification code to b•••@gmail.com. Check your inbox.\n- textbox "Enter code" [ref=e7]`);
  assert.equal(mail.via, "email"); assert.equal(mail.email, "b•••@gmail.com");
  assert.equal(codeRequest(`- paragraph: Open Google Authenticator and enter the 6-digit code\n- textbox "Enter code" [ref=e2]`).via, "app");
  const send = codeRequest(`- paragraph: Confirm it's you. We'll text a code to your phone ending in 1234.\n- button "Send code" [ref=e3]`);
  assert.equal(send.via, "sms"); assert.equal(send.last, "1234"); assert.equal(send.send.ref, "e3");
  assert.equal(codeRequest(`- heading "Your orders"\n- textbox "Promo code" [ref=e1]`), null, "a promo code box isn't a sign-in code");
});

test("their number, by its last digits", () => {
  assert.ok(isTheirNumber("34", ["40722111234"]));
  assert.ok(!isTheirNumber("35", ["40722111234"]));
  assert.ok(isTheirNumber("1234", ["0722 111 999", "+40 722 11 12 34"]));
  assert.ok(!isTheirNumber("x1", ["1"]));
});

test("a code in an email, and only from the site, only new", () => {
  assert.equal(codeIn("Your Booking.com verification code is 482913"), "482913");
  assert.equal(codeIn("482913 is your code"), "482913");
  assert.equal(codeIn("Order 2026 shipped, ref 77, 88"), null);
  const now = Date.parse("2026-10-15T08:00:00Z");
  const feed = `<feed><entry><title>Your code</title><summary>Use 111111 to sign in</summary><issued>2026-10-15T08:00:10Z</issued><author><name>Other Shop</name><email>no-reply@other.test</email></author></entry>
<entry><title>Booking.com: your verification code</title><summary>Your code is 482913. It expires in 10 minutes.</summary><issued>2026-10-15T08:00:20Z</issued><author><name>Booking.com</name><email>noreply@booking.com</email></author></entry>
<entry><title>Booking.com: your verification code</title><summary>Your code is 999999</summary><issued>2026-10-14T08:00:20Z</issued><author><name>Booking.com</name></author></entry></feed>`;
  assert.equal(codeFromFeed(feed, "account.booking.com", now), "482913");
  assert.equal(codeFromFeed(feed, "olx.ro", now), null);
});

test("API keys: named as ‹api key: site›, filled in from the store, a missing one said by site", async () => {
  const { apiKeyPlaceholders, fillApiKeys, looksLikeApiKey } = await import("../dist/passwords.js");
  assert.deepEqual(apiKeyPlaceholders("curl 'https://api.x.test/w?appid=‹api key: OpenWeatherMap.org›'"), [{ whole: "‹api key: OpenWeatherMap.org›", site: "openweathermap.org" }]);
  const key = ["k", "3y", "9f8e7d6c5b4a3210"].join("");
  const r = await fillApiKeys("curl 'https://api.x.test/w?appid=‹api key: openweathermap.org›'", async site => site === "openweathermap.org" ? key : null);
  assert.equal(r.command, `curl 'https://api.x.test/w?appid=${key}'`);
  assert.equal(r.keys.get("‹api key: openweathermap.org›"), key);
  assert.deepEqual(await fillApiKeys("curl ‹api key: nope.test›", async () => null), { missing: "nope.test" });
  assert.ok(looksLikeApiKey(key));
  assert.ok(!looksLikeApiKey("••••••••••••••••••••"), "a masked key");
  assert.ok(!looksLikeApiKey("Copy your key below"), "a sentence");
});

test("a code or link instead of a password: the option found, a link-sent page told, only the site's own link taken", async () => {
  const { codeOrLinkOption, linkSent, signInLinkIn } = await import("../dist/passwords.js");
  assert.deepEqual(codeOrLinkOption(`- textbox "Email" [ref=e1]\n- button "Continue" [ref=e2]\n- button "Email me a sign-in link" [ref=e3]`), { name: "Email me a sign-in link", ref: "e3" });
  assert.equal(codeOrLinkOption(`- button "Send me a code" [ref=e4]`).ref, "e4");
  assert.equal(codeOrLinkOption(`- link "Sign in with a one-time code" [ref=e5]`).ref, "e5");
  assert.equal(codeOrLinkOption(`- button "Forgot password?" [ref=e6]\n- button "Log in" [ref=e7]`), null);
  assert.ok(linkSent(`- heading "Check your email"\n- paragraph: We've sent a sign-in link to b…@gmail.com.`));
  assert.ok(!linkSent(`- paragraph: We sent a code.\n- textbox "Code" [ref=e1]`), "a code box: the code step's");
  assert.equal(signInLinkIn("here https://www.medium.com/m/callback/email?token=abc123&state=x thanks", "medium.com"), "https://www.medium.com/m/callback/email?token=abc123&state=x");
  assert.equal(signInLinkIn("https://evil.test/login?token=1", "medium.com"), null, "another site's link");
});
