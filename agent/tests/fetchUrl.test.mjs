// fetch_url, against a real HTTP server rather than a mocked fetch.
//
// The mock would have proved the parts that never break. What can actually go
// wrong here is a redirect that escapes the private-address guard, a byte cap
// that does not cap, a content type that comes back as garbage instead of "I
// can't read that", and a budget that is exceeded by exactly the passage that
// matters. All of those need a socket, so there is one.
//
// Loopback is a private address and the guard refuses it, which is the point of
// the guard — so every call here passes `allowLoopback`, a flag the tool path
// never sets and which permits loopback ONLY. Every other private range stays
// refused, including on a redirect hop, so the guard is still the thing under
// test rather than something the test switched off.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
    fetchUrl, guardUrl, chunk, rank, compose, extract,
    DEFAULT_MAX_CHARS, MAX_MAX_CHARS,
} from "../dist/fetchUrl.js";

const ARTICLE = `<!doctype html><html><head><title>Snagov lake guide</title></head><body>
<nav>Home About Contact Subscribe</nav>
<article>
  <h1>Snagov lake guide</h1>
  <p>${"The lake sits north of Bucharest and is reached by car in under an hour. ".repeat(8)}</p>
  <h2>Opening hours</h2>
  <p>The boat rental opens at 09:00 and closes at 19:00 from May to September. ${"Padding sentence about the shoreline. ".repeat(10)}</p>
  <h2>Prices</h2>
  <p>A kayak is 40 lei per hour and a pedal boat is 60 lei per hour. ${"Padding sentence about the pier. ".repeat(10)}</p>
  <h2>Istoric</h2>
  <p>Mănăstirea a fost construită în secolul al XIV-lea pe insulă. ${"Propoziție de umplutură despre lac. ".repeat(10)}</p>
</article>
<footer>Copyright</footer></body></html>`;

let server, base, hits;

before(async () => {
    hits = [];
    server = http.createServer((req, res) => {
        hits.push(req.url);
        const send = (code, type, body) => {
            res.writeHead(code, { "content-type": type });
            res.end(body);
        };
        if (req.url === "/article") return send(200, "text/html; charset=utf-8", ARTICLE);
        if (req.url === "/plain") return send(200, "text/plain", "just words, no markup at all");
        if (req.url === "/paper.pdf") return send(200, "application/pdf", "%PDF-1.4 binary junk");
        if (req.url === "/empty") return send(200, "text/html", "   ");
        if (req.url === "/gone") return send(404, "text/html", "<h1>no</h1>");
        if (req.url === "/huge") {
            // 12 MB of HTML: the 5 MB cap must stop reading and still parse.
            res.writeHead(200, { "content-type": "text/html" });
            res.write("<html><body><article><h1>Huge</h1><p>");
            for (let i = 0; i < 12_000; i++) res.write("x".repeat(1000));
            return res.end("</p></article></body></html>");
        }
        if (req.url === "/to-article") {
            res.writeHead(302, { location: "/article" });
            return res.end();
        }
        if (req.url === "/to-router") {
            // The attack the guard exists for: a public URL that bounces the
            // fetch onto the home network.
            res.writeHead(302, { location: "http://192.168.1.1/admin" });
            return res.end();
        }
        if (req.url === "/loop") {
            res.writeHead(302, { location: "/loop" });
            return res.end();
        }
        if (req.url === "/slow") return setTimeout(() => send(200, "text/html", ARTICLE), 30_000);
        send(404, "text/plain", "?");
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const read = (path, extra = {}) =>
    fetchUrl({ url: `${base}${path}`, allowLoopback: true, ...extra });

describe("fetch_url", () => {
    test("a question gets the passage that answers it, not the page", async () => {
        const r = await read("/article", { query: "how much does a kayak cost" });
        assert.equal(r.ok, true, r.content);
        assert.match(r.content, /40 lei/);
        assert.match(r.content, /# Snagov lake guide/);
        // The heading path is what lets the model say where the number came from.
        assert.match(r.content, /\[Prices\]/);
        assert.ok(r.content.length <= DEFAULT_MAX_CHARS, `${r.content.length} chars`);
        // The whole point: far less than the page itself.
        assert.ok(r.rawChars > r.chars * 2, `raw ${r.rawChars} vs sent ${r.chars}`);
    });

    test("diacritics are folded both ways", async () => {
        // Typed without them, matched against a page that has them. This is how
        // the question actually arrives in a Romanian chat.
        const r = await read("/article", { query: "manastirea construita secolul" });
        assert.equal(r.ok, true, r.content);
        assert.match(r.content, /secolul al XIV-lea/);
    });

    test("without a question it answers with the outline and the opening", async () => {
        const r = await read("/article");
        assert.equal(r.ok, true, r.content);
        assert.match(r.content, /Sections: /);
        assert.match(r.content, /Opening hours/);
        assert.ok(r.content.length <= DEFAULT_MAX_CHARS, `${r.content.length} chars`);
    });

    test("a question nothing matches says so instead of inventing a match", async () => {
        const r = await read("/article", { query: "zebra quantum ballet" });
        assert.equal(r.ok, true, r.content);
        assert.match(r.content, /nothing on the page matched/i);
    });

    test("max_chars is honoured and clamped", async () => {
        const small = await read("/article", { query: "kayak", max_chars: 600 });
        assert.ok(small.content.length <= 600, `${small.content.length} chars`);
        const absurd = await read("/article", { max_chars: 10 ** 7 });
        assert.ok(absurd.content.length <= MAX_MAX_CHARS, `${absurd.content.length} chars`);
    });

    test("boilerplate is dropped", async () => {
        const r = await read("/article");
        assert.doesNotMatch(r.content, /Subscribe|Copyright/);
    });

    test("plain text needs no parser", async () => {
        const r = await read("/plain");
        assert.equal(r.ok, true, r.content);
        assert.match(r.content, /just words/);
    });

    test("a PDF is 'not yet', never garbage", async () => {
        const r = await read("/paper.pdf");
        assert.equal(r.ok, false);
        assert.match(r.content, /PDF/);
        assert.doesNotMatch(r.content, /%PDF/);
    });

    test("an error page, an empty page and a dead host each say which", async () => {
        const gone = await read("/gone");
        assert.equal(gone.ok, false);
        assert.match(gone.content, /404/);
        const empty = await read("/empty");
        assert.equal(empty.ok, false);
        assert.match(empty.content, /empty/i);
        const dead = await fetchUrl({ url: "http://127.0.0.1:1/x", allowLoopback: true });
        assert.equal(dead.ok, false);
        assert.match(dead.content, /couldn't reach/i);
    });

    test("the byte cap holds on a page that will not stop", async () => {
        const r = await read("/huge", { query: "huge" });
        assert.ok(r.rawChars <= 5_000_000, `read ${r.rawChars} chars`);
        assert.ok(r.content.length <= DEFAULT_MAX_CHARS);
    });

    test("a slow page gives up rather than holding the reply open", async () => {
        const t0 = Date.now();
        const r = await read("/slow");
        assert.equal(r.ok, false);
        assert.match(r.content, /didn't answer within 15s/);
        // The relay promotes a call to a job at 20s, so this has to land first.
        assert.ok(Date.now() - t0 < 19_000, `took ${Date.now() - t0}ms`);
    });

    test("a redirect is followed, and guarded on every hop", async () => {
        const ok = await read("/to-article", { query: "kayak" });
        assert.equal(ok.ok, true, ok.content);
        assert.match(ok.content, /40 lei/);

        // The one that matters: the Mac is inside a home network, so a page
        // that bounces the fetch at the router must be refused. allowLoopback
        // covers 127.0.0.1 and nothing else, so this hop is judged exactly as
        // it would be in production.
        const router = await read("/to-router");
        assert.equal(router.ok, false, router.content);
        assert.match(router.content, /private network/);

        const loop = await read("/loop");
        assert.equal(loop.ok, false);
        assert.match(loop.content, /too many redirects/);
    });
});

describe("where fetch_url may go", () => {
    test("private, local and loopback addresses are refused", async () => {
        for (const u of ["http://192.168.1.1/", "http://10.0.0.5/", "http://172.16.0.1/",
                         "http://127.0.0.1:8080/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/",
                         "http://localhost:3000/", "http://nas.local/", "http://printer.lan/"]) {
            const r = await guardUrl(u);
            assert.ok("why" in r, `${u} was allowed`);
            assert.match(r.why, /private network/);
        }
    });

    test("a name that resolves into the network is refused too", async () => {
        // The string looks public; the answer is 127.0.0.1. A check that only
        // read the hostname would wave this through.
        const r = await guardUrl("http://localtest.me/");
        assert.ok("why" in r, "a name resolving to loopback was allowed");
    });

    test("only http and https, and never a password in the URL", async () => {
        for (const [u, pattern] of [["file:///etc/passwd", /only open http/],
                                    ["ftp://example.com/x", /only open http/],
                                    ["https://user:pw@example.com/", /password/]]) {
            const r = await guardUrl(u);
            assert.ok("why" in r, `${u} was allowed`);
            assert.match(r.why, pattern);
        }
    });

    test("a public address is allowed", async () => {
        const r = await guardUrl("https://example.com/page");
        assert.ok("url" in r, "why" in r ? r.why : "");
    });
});

describe("the pieces", () => {
    test("chunks carry their heading path", () => {
        const cs = chunk("# A\n\ntext one\n\n## B\n\ntext two\n\n### C\n\ntext three");
        assert.deepEqual(cs.map(c => c.heading), ["A", "A > B", "A > B > C"]);
        // A deeper heading does not leak into the next shallower one.
        const back = chunk("# A\n\n## B\n\nb\n\n# D\n\nd");
        assert.deepEqual(back.map(c => c.heading), ["A > B", "D"]);
    });

    test("ranking prefers the chunk that actually says it", () => {
        const cs = chunk("# P\n\nnothing relevant here at all\n\n## Q\n\nthe kayak costs 40 lei");
        const [best] = rank(cs, "kayak cost");
        assert.equal(cs[best.at].text.includes("40 lei"), true);
        assert.deepEqual(rank(cs, "the and for"), []);   // stopwords only: no match
    });

    test("passages come back in page order, not in score order", () => {
        const cs = chunk("# T\n\n## One\n\nkayak\n\n## Two\n\nkayak kayak kayak");
        const { text } = compose("T", cs, "kayak", 3000);
        assert.ok(text.indexOf("[T > One]") < text.indexOf("[T > Two]"), text);
    });

    test("a page Readability cannot make an article of still yields text", () => {
        const { markdown } = extract(
            "<html><body><div><span>bare</span> <b>words</b> in a div</div></body></html>",
            "https://example.com/");
        // turndown keeps the emphasis, which is the point of markdown.
        assert.match(markdown, /bare \*\*words\*\* in a div/);
    });
});
