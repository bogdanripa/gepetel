// Site notes (Phase 9): what's kept about each site, and what never is.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SiteNotes, siteKey, unfit, addressPath, PER_SITE } from "../dist/siteNotes.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "notes-")), "site-notes.json");

test("a site is its registrable domain", () => {
  assert.equal(siteKey("https://secure.booking.com/login.html"), "booking.com");
  assert.equal(siteKey("www.olx.ro"), "olx.ro");
  assert.equal(siteKey("https://www.bbc.co.uk/news"), "bbc.co.uk");
  assert.equal(siteKey("my.synevo.ro"), "synevo.ro");
  assert.equal(siteKey("http://127.0.0.1:8080/x"), "127.0.0.1");
});

test("never kept: numbers, emails, secrets, amounts; a plain sentence about the site is", () => {
  assert.equal(unfit("The person signs in here with Google."), "");
  assert.equal(unfit("The sign-in button takes 5–6 seconds; it works."), "");
  assert.match(unfit("Their account is 4111 1111 1111 1111"), /number/);
  assert.match(unfit("Logged in as ana@example.com"), /email/);
  assert.match(unfit("password: hunter2"), /secret/);
  assert.match(unfit("The cheapest was €745"), /amount/);
  assert.match(unfit("x".repeat(201)), /200/);
});

test("addresses: a page's path, never the front page, a query or one item's own page", () => {
  assert.equal(addressPath("https://www.tripit.com/app/trips?x=1#y"), "/app/trips");
  assert.equal(addressPath("https://www.booking.com/"), "");
  assert.equal(addressPath("https://www.booking.com/searchresults.en-gb.html?ss=x"), "", "a search's results");
  assert.equal(addressPath("https://www.tripit.com/app/trips/10d68bf8765890000001"), "");
});

test("kept on disk, read back, the same note refreshed not repeated, forgotten by words", () => {
  const f = tmp();
  const a = new SiteNotes(f);
  a.add("https://www.booking.com/x", "The person signs in here with Google.", "job");
  a.add("booking.com", "the person signs in here with google.", "person");
  a.add("booking.com", "/mytrips", "job", "address");
  const b = new SiteNotes(f);
  assert.equal(b.forSite("booking.com").length, 2);
  assert.equal(b.forSite("booking.com")[0].source, "person", "the person's own first");
  assert.deepEqual(b.addresses("secure.booking.com"), ["/mytrips"]);
  assert.equal(b.forget({ site: "booking.com", text: "google" }), 1);
  assert.equal(new SiteNotes(f).forSite("booking.com").length, 1);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600, "readable by the person only");
});

test("bounded: at most PER_SITE a site; a note unused for 90 days goes", () => {
  let t = new Date("2026-01-01T00:00:00Z");
  const n = new SiteNotes(null, () => t);
  for (let i = 0; i < PER_SITE + 5; i++) n.add("olx.ro", `Note number ${String.fromCharCode(97 + i)} about the site`, "job");
  assert.equal(n.forSite("olx.ro", 100).length, PER_SITE);
  t = new Date("2026-05-01T00:00:00Z");
  n.add("tripit.com", "A fresh note", "job");
  assert.equal(n.forSite("olx.ro").length, 0, "unused since January");
  assert.equal(n.forSite("tripit.com").length, 1);
});
