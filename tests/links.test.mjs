// GEP-91: link reading — page metadata, the prompt block, and the dual-stack SSRF guard.
// No outside network: `readLinks` runs against a local server only.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { readFileSync } from "node:fs";
import * as L from "../dist/links.js";

const luma = readFileSync(new URL("./fixtures/luma-aic-ta-11-24.html", import.meta.url), "utf8");
const NAME = "Lovable Promptathon Bucharest: From Vibe to Live (w/ The AI Collective)";

describe("parsePageMeta", () => {
  test("the saved luma page gives its name and dates from JSON-LD", () => {
    const m = L.parsePageMeta(luma);
    assert.equal(m.title, NAME);
    assert.equal(m.startDate, "2026-11-24T16:00:00.000+02:00");
    assert.equal(m.endDate, "2026-11-24T22:00:00.000+02:00");
    assert.match(m.location, /Builders House/);
    assert.match(m.location, /București/);
  });
  test("@graph and top-level array forms, and Event subtypes", () => {
    const graph = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","name":"Page"},{"@type":["Thing","MusicEvent"],"name":"Concert","startDate":"2026-12-01T20:00:00Z"}]}</script>`;
    assert.deepEqual([L.parsePageMeta(graph).title, L.parsePageMeta(graph).startDate], ["Concert", "2026-12-01T20:00:00Z"]);
    const arr = `<script type='application/ld+json'>[{"@type":"Organization","name":"Org"},{"@type":"Event","name":"Meetup","startDate":"2026-12-02"}]</script>`;
    assert.deepEqual([L.parsePageMeta(arr).title, L.parsePageMeta(arr).startDate], ["Meetup", "2026-12-02"]);
  });
  test("malformed JSON-LD falls back to og:title, with no date", () => {
    const html = `<head><script type="application/ld+json">{"@type":"Event", broken</script><meta property="og:title" content="Fallback &amp; co · Site"><title>T</title></head>`;
    assert.deepEqual(L.parsePageMeta(html), { title: "Fallback & co · Site", startDate: null, endDate: null, location: null });
  });
  test("<title> only gives a title and no date", () => {
    assert.deepEqual(L.parsePageMeta("<html><head><title>\n  Just   a page\n</title></head></html>"), { title: "Just a page", startDate: null, endDate: null, location: null });
  });
  test("a date in body text, published_time or the title is never used", () => {
    const html = `<head><title>Hackathon 23 noiembrie</title><meta property="article:published_time" content="2026-11-23T10:00:00Z"></head><body>Ne vedem pe 23 noiembrie 2026!</body>`;
    const m = L.parsePageMeta(html);
    assert.equal(m.startDate, null);
    assert.equal(m.endDate, null);
  });
  test("the title is capped at 200 chars", () => {
    const m = L.parsePageMeta(`<title>${"a".repeat(500)}</title>`);
    assert.ok(m.title.length <= 200);
  });
});

describe("parsePageMeta on hostile HTML", () => {
  // It runs synchronously after the body is read, so no request timeout can stop it: every scan
  // must be linear. The regex version took 35 s on the first input and 55 s on the second.
  const MB = 1_000_000;
  const fill = (unit) => unit.repeat(Math.ceil(MB / unit.length));
  const cases = {
    "unclosed <script": fill("<script "),
    "unclosed <meta": fill("<meta "),
    "unclosed <title>": fill("<title>"),
    "<script> with no closing tag": fill("<script>"),
    "long attribute names": fill(`<meta ${"a".repeat(8000)}>`),
    "unterminated quoted values": fill(`<meta x='${"a".repeat(8000)}>`),
  };
  for (const [name, html] of Object.entries(cases)) {
    test(`${name} (~1 MB) parses in well under a second`, () => {
      const t = performance.now();
      const m = L.parsePageMeta(html);
      const ms = performance.now() - t;
      assert.ok(ms < 500, `${name}: ${ms.toFixed(0)} ms`);
      assert.equal(m.startDate, null);
    });
  }

  test("tag names are matched whole and case-insensitively", () => {
    const html = `<metadata property="og:title" content="no"><scripts type="application/ld+json">{"@type":"Event","name":"no"}</scripts>`
      + `<SCRIPT TYPE='application/ld+json'>{"@type":"Event","name":"E","startDate":"2026-12-01"}</Script >`;
    assert.deepEqual([L.parsePageMeta(html).title, L.parsePageMeta(html).startDate], ["E", "2026-12-01"]);
    assert.equal(L.parsePageMeta(`<metadata name="og:title" content="no"><meta name=og:title content=Yes><title>T</title>`).title, "Yes");
  });
});

describe("formatLinksBlock", () => {
  const ok = (over = {}) => ({ url: "https://luma.com/aic-ta-11-24", from: "Nicolae", ok: true, ...L.parsePageMeta(luma), ...over });
  test("the luma entry renders the stated day and time", () => {
    const block = L.formatLinksBlock([ok()]);
    assert.match(block, /^- Nicolae shared https:\/\/luma\.com\/aic-ta-11-24$/m);
    assert.match(block, new RegExp(`^  title: ${NAME.replace(/[()]/g, "\\$&")}$`, "m"));
    assert.match(block, /^  date: Tuesday 24 November 2026, 16:00–22:00 \(UTC\+02:00, as stated on the page\)$/m);
  });
  test("a +02:00 time just after midnight stays on its own day", () => {
    const block = L.formatLinksBlock([ok({ startDate: "2026-11-24T00:30:00+02:00", endDate: null })]);
    assert.match(block, /date: Tuesday 24 November 2026, 00:30 \(UTC\+02:00/);
  });
  test("date-only, unparseable and missing dates", () => {
    assert.match(L.formatLinksBlock([ok({ startDate: "2026-11-24", endDate: null })]), /date: Tuesday 24 November 2026 \(as stated on the page\)/);
    assert.match(L.formatLinksBlock([ok({ startDate: "next Tuesday", endDate: null })]), /date: next Tuesday \(as stated on the page\)/);
    assert.match(L.formatLinksBlock([ok({ startDate: null, endDate: null })]), /date: not stated/);
  });
  test("an end on another day names that day", () => {
    assert.match(L.formatLinksBlock([ok({ startDate: "2026-11-24T22:00:00+02:00", endDate: "2026-11-25T02:00:00+02:00" })]),
      /Tuesday 24 November 2026, 22:00 – Wednesday 25 November 2026, 02:00/);
  });
  test("failures render 'could not be read'; empty gives (none)", () => {
    const block = L.formatLinksBlock([{ url: "https://example.org/x", from: "Ana", ok: false, reason: "timeout" }]);
    assert.equal(block, "- Ana shared https://example.org/x\n  could not be read");
    assert.equal(L.formatLinksBlock([]), "(none)");
  });
  test("the query string and fragment are dropped", () => {
    const block = L.formatLinksBlock([ok({ url: "https://luma.com/aic-ta-11-24?tk=SECRET#x" })]);
    assert.doesNotMatch(block, /SECRET|tk=|#x/);
    assert.match(block, /shared https:\/\/luma\.com\/aic-ta-11-24$/m);
  });
});

describe("isPublicAddress", () => {
  const blocked = [
    "0.0.0.0", "10.0.1.6", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.86.250", "198.18.0.1", "198.19.255.1", "198.51.100.7",
    "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fe80::1%eth0", "fec0::1", "ff02::1",
    "fddf:6e69:23a7::d", "fddf:6e69:23a7::1", "fc00::1",
    "::ffff:10.0.1.6", "::ffff:127.0.0.1", "::ffff:a00:106", "[::ffff:10.0.1.6]",
    "64:ff9b::a00:106", "64:ff9b::10.0.1.6", "2002:0a00:0106::1", "2002:7f00:1::1",
    "2001:db8::1", "2001:0:4136:e378::1",
    "", "not-an-ip", "1.2.3", "localhost",
  ];
  const allowed = ["1.1.1.1", "8.8.8.8", "104.23.1.1", "2606:4700::1111", "[2606:4700::1111]", "::ffff:1.1.1.1", "2002:0101:0101::1", "2a00:1450:4001::200e"];
  for (const ip of blocked) test(`blocks ${JSON.stringify(ip)}`, () => assert.equal(L.isPublicAddress(ip), false));
  for (const ip of allowed) test(`allows ${ip}`, () => assert.equal(L.isPublicAddress(ip), true));
});

describe("readLinks", () => {
  const routes = {};
  const server = http.createServer((req, res) => {
    const h = routes[req.url];
    if (h) return h(req, res);
    res.writeHead(404).end();
  });
  const ready = new Promise(r => server.listen(0, "127.0.0.1", r));
  const other = http.createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<title>inside</title>"));
  const readyOther = new Promise(r => other.listen(0, "127.0.0.1", r));
  after(() => { L.__setTestOverrides(); server.close(); other.close(); server.closeAllConnections?.(); });

  const base = async () => { await ready; return `http://127.0.0.1:${server.address().port}`; };
  const trust = async (o = {}) => L.__setTestOverrides({ trustedOrigins: [await base()], ...o });
  const read1 = async (path, from = "Ana") => (await L.readLinks([{ url: (await base()) + path, from }]))[0];

  routes["/page"] = (req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(luma);

  test("with the guard on, a request to 127.0.0.1 is blocked", async () => {
    L.__setTestOverrides();
    assert.deepEqual(await read1("/page"), { url: (await base()) + "/page", from: "Ana", ok: false, reason: "blocked" });
  });
  test("literal private addresses, odd ports, credentials and other schemes are blocked without a request", async () => {
    L.__setTestOverrides();
    const urls = ["http://10.0.1.6:10000/health", "http://[fddf:6e69:23a7::d]/", "http://[::ffff:10.0.1.6]/", "http://0x7f.1/",
      "http://example.com:8080/", "https://user:pass@example.com/", "ftp://example.com/", "http://169.254.169.254/latest/meta-data/", "http://localhost/"];
    const reads = await L.readLinks(urls.map(url => ({ url, from: "X" })));
    assert.deepEqual(reads.map(r => r.reason), urls.map(() => "blocked"));
  });
  test("with the seam, a page is read and parsed", async () => {
    await trust();
    const r = await read1("/page");
    assert.equal(r.ok, true);
    assert.equal(r.title, NAME);
    assert.equal(r.startDate, "2026-11-24T16:00:00.000+02:00");
  });
  test("gzip and brotli bodies are decoded", async () => {
    await trust();
    routes["/gz"] = (req, res) => res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }).end(zlib.gzipSync(luma));
    routes["/br"] = (req, res) => res.writeHead(200, { "content-type": "text/html", "content-encoding": "br" }).end(zlib.brotliCompressSync(luma));
    assert.equal((await read1("/gz")).startDate, "2026-11-24T16:00:00.000+02:00");
    assert.equal((await read1("/br")).startDate, "2026-11-24T16:00:00.000+02:00");
  });
  test("sends only the fixed headers", async () => {
    await trust();
    let seen;
    routes["/hdr"] = (req, res) => { seen = req.headers; res.writeHead(200, { "content-type": "text/html" }).end("<title>x</title>"); };
    await read1("/hdr");
    assert.match(seen["user-agent"], /Gepetel/);
    assert.equal(seen.cookie, undefined);
    assert.equal(seen.authorization, undefined);
  });
  test("timeout", async () => {
    await trust({ timeoutMs: 300 });
    routes["/slow"] = (req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.write("<title>"); };
    const t0 = Date.now();
    assert.equal((await read1("/slow")).reason, "timeout");
    assert.ok(Date.now() - t0 < 3000);
  });
  test("1 MB cap: by Content-Length, by stream, and after decompression", async () => {
    await trust();
    const big = "<p>" + "a".repeat(1024 * 1024 + 10);
    routes["/big"] = (req, res) => res.writeHead(200, { "content-type": "text/html" }).end(big);
    routes["/bigchunked"] = (req, res) => { res.writeHead(200, { "content-type": "text/html", "transfer-encoding": "chunked" }); res.end(big); };
    routes["/bomb"] = (req, res) => res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }).end(zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024, 97)));
    assert.equal((await read1("/big")).reason, "too-large");
    assert.equal((await read1("/bigchunked")).reason, "too-large");
    assert.equal((await read1("/bomb")).reason, "too-large");
  });
  test("not-html and non-2xx", async () => {
    await trust();
    routes["/json"] = (req, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}");
    routes["/503"] = (req, res) => res.writeHead(503, { "content-type": "text/html" }).end("<title>busy</title>");
    assert.equal((await read1("/json")).reason, "not-html");
    assert.equal((await read1("/503")).reason, "http-error");
    assert.equal((await read1("/missing")).reason, "http-error");
  });
  test("redirects: three are followed, a fourth is refused", async () => {
    await trust();
    routes["/r3"] = (req, res) => res.writeHead(302, { location: "/r2" }).end();
    routes["/r2"] = (req, res) => res.writeHead(301, { location: "/r1" }).end();
    routes["/r1"] = (req, res) => res.writeHead(307, { location: "/page" }).end();
    routes["/r4"] = (req, res) => res.writeHead(302, { location: "/r3" }).end();
    assert.equal((await read1("/r3")).title, NAME);
    assert.equal((await read1("/r4")).reason, "http-error");
  });
  test("every hop is guarded: a redirect to an untrusted 127.0.0.1 port or a private literal is blocked", async () => {
    await readyOther;
    await trust();
    const target = `http://127.0.0.1:${other.address().port}/`;
    routes["/to-local"] = (req, res) => res.writeHead(302, { location: target }).end();
    routes["/to-sablier"] = (req, res) => res.writeHead(302, { location: "http://10.0.1.6:10000/health" }).end();
    routes["/to-ula"] = (req, res) => res.writeHead(302, { location: "http://[fddf:6e69:23a7::d]/" }).end();
    for (const p of ["/to-local", "/to-sablier", "/to-ula"]) assert.equal((await read1(p)).reason, "blocked", p);
  });
  test("never throws, whatever it is given", async () => {
    L.__setTestOverrides();
    const reads = await L.readLinks([{ url: "not a url", from: "A" }, { url: undefined, from: undefined }, null]);
    assert.deepEqual(reads.map(r => r.ok), [false, false, false]);
    assert.deepEqual(await L.readLinks(undefined), []);
  });
});

describe("linksLogLine", () => {
  test("host and outcome only: no path, query, title or sharer", () => {
    const line = L.linksLogLine([
      { url: "https://Luma.com/aic-ta-11-24?tk=secret", from: "Nicolae", ok: true, title: "AI Promptathon", startDate: "2026-11-24T16:00:00.000+02:00", endDate: null, location: "Cluj" },
      { url: "https://example.org/private/path?token=abc", from: "Ana", ok: false, reason: "timeout" },
      { url: "https://x.test/p", from: "B", ok: true, title: null, startDate: null, endDate: null, location: null },
    ]);
    assert.equal(line, "luma.com ok (titled, dated); example.org could not be read (timeout); x.test ok (untitled, undated)");
    for (const leak of ["aic-ta", "secret", "private", "token", "Promptathon", "Nicolae", "Cluj"]) assert.ok(!line.includes(leak), leak);
  });
  test("an unparseable url does not throw", () => {
    assert.equal(L.linksLogLine([{ url: "not a url", from: "", ok: false, reason: "error" }]), "(bad url) could not be read (error)");
  });
});
