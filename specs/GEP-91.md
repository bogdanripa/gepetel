# GEP-91 — Unprompted posts take an event's date and identity from the link being discussed

Related: GEP-90 (daily review for 2026-11-17), where this was found.

## What happened
Group *Daily SI SI SI … 🍹*, 2026-11-16.

- 19:23Z, Nicolae: "https://luma.com/aic-ta-11-24 are cineva chef de un mic hackathon? Eu nu
  m-am mai jucat cu Lovable până acum 🤣"
- 20:00Z, Gepetel (unprompted, `/cron/unprompted`): "**Pe 23 noiembrie** e un Prompathon
  Lovable în București: demo scurt, apoi 60 de minute să construiți în echipe, inclusiv pentru
  începători. **Pare încălzirea decentă pentru hackathonul lui Nicolae** — fără să pretindeți
  că știți deja ce faceți."

The linked page *is* that event: "Lovable Promptathon Bucharest: From Vibe to Live (w/ The AI
Collective)", `startDate 2026-11-24T16:00+02:00`. So the post had:

1. **the wrong date**: 23, not 24 November;
2. **one event split into two**: the Promptathon *is* the hackathon Nicolae linked. Calling it
   "a warm-up for Nicolae's hackathon" also made Nicolae its organiser, when he only shared
   the link.

Verified by the issue's author two ways: the luma page's `startDate`/`name` fields, and the
container log line `Unprompted -> 40728555860-1578581780@g.us …` at 20:00:10Z. wa-gateway
logged `message sent` at 20:00:12Z.

## Why it matters
Nobody asks for an unprompted post and nobody checks it before it goes out. Here an 11-person
group got a wrong date for an event someone was trying to organise. Anyone acting on "23"
turns up on the wrong day. A missing date costs nothing, but a wrong one costs a wasted trip.

## Root cause (as far as the code shows)
`generateGossip` (`src/oai.ts`) gets the recent conversation as text and has `web_search`. The
prompt (`prompts/gossip.txt`) tells it to search for something new that is tied to the
conversation. Nothing tells it that a URL in the conversation is the subject already under
discussion, and nothing makes it read that URL. So it searched, found the same event from
another source (or recalled it), restated the date from that source or from memory, and
presented it as a separate find.

## Goal
When the recent conversation links something (an event, a place, an article), the unprompted
post treats **that page** as the thing being discussed. It takes the page's name and date from
the page itself and never presents it as something new or separate. Dates in unprompted posts
are copied from a source, never written from memory.

## Behaviour
1. **Links in the conversation are read.** Before the gossip model runs, the URLs in the
   conversation window passed to `generateGossip` (the newest few, e.g. at most 3) are
   resolved to at least their **title** and, when the page states one, their **date/time**
   (schema.org `Event.startDate`/`name`, OpenGraph, `<title>`, or what the model reads when it
   opens the page). This goes into the prompt as a separate block, *"Links shared in the
   conversation"*, with: who shared it, the URL, the title and the date, or "date not stated".
   Whether the server fetches the page or the model opens it with `web_search` is a design
   decision (see *Open for design*).
2. **A linked thing is THE thing.** The prompt says: something linked in the chat is the
   subject being discussed. Don't present it again as new, separate, a warm-up, or a "related"
   event. If the post is about it at all, it builds on it (a practical detail from the page,
   who's going, what to bring). The person who shared a link only shared it: don't call them
   its organiser or owner ("hackathonul lui Nicolae") unless the conversation says so.
3. **No dates from memory.** The prompt says to state a date or time for an event only if it is
   copied from a source in the context (the links block, or a page the model opened in this
   turn). If the sources disagree, or none states the date, leave the date out. A post without
   a date is fine. A wrong date isn't.
4. **A link that can't be read changes nothing else.** On a timeout, non-HTML response, block
   or error, the entry says "could not be read". Rules 2 and 3 still apply: the model must not
   guess the page's date. A failed read must never fail the cron for the group.
5. **Logs carry metadata only**, as elsewhere: the URL's host and whether it was read, not page
   content and not the query string.

## Acceptance criteria
- **Regression (the observed case).** A gossip run with the conversation above (Nicolae's
  19:23Z message) and the luma page's metadata (name as above, `startDate
  2026-11-24T16:00+02:00`) produces either "no answer" or a post that:
  - does not contain "23" as the event's date;
  - if it states a date, states 24 November;
  - does not describe the Promptathon as separate from, a warm-up for, or before "the
    hackathon" Nicolae linked;
  - does not call Nicolae its organiser or owner.
  This is an LLM test case in `tests/llm.test.mjs` (where the gossip cases live) and runs with
  `node scripts/test-changed.mjs`.
- **Unreadable link.** Same conversation, with the link marked "could not be read": the post
  contains no date for that event (or the answer is "no answer").
- **Unit: link extraction.** A pure helper pulls the URLs out of the conversation lines (newest
  first, deduplicated, capped) and keeps who shared each. It is unit-tested in
  `tests/util.test.mjs`.
- **Unit: page metadata.** If the server fetches pages: a pure parser pulls name/startDate from
  JSON-LD `Event`, falls back to OpenGraph/`<title>`, and is unit-tested on a saved luma-shaped
  HTML fixture. A non-HTML or oversized body returns "could not be read".
- **No regression.** A conversation without links produces the same prompt as today, apart from
  the date rule (the links block reads "(none)").
- **Production check (by product after release).** The deployed image contains the change,
  and the next `/cron/unprompted` run logs no error from the link step. This can only be read
  from the logs; there is no live replay.

## Open for design (architecture decides)
- **Who reads the link: the server, or the model?** If the server fetches it, the date is
  deterministic and unit-testable. But that means fetching user-supplied URLs, so it needs an
  SSRF guard (public http(s) only, no private/link-local/ULA addresses in either family, short
  timeout, size cap, no credentials). On this box, see pironman's rag SSRF guard for the IPv6
  `fddf:…` lesson. If the model opens the page (via web_search or an instruction), there is no
  new fetch code, but it is weaker and harder to test. The acceptance criteria above hold
  either way.
- Whether the same links block should also feed the normal group reply path. Not required
  here (see *Out of scope*), but the helper should be reusable.

## Out of scope
- The group reply path (`generateGroupReply`), DMs and scheduled posts. This issue covers
  unprompted posts only. A follow-up can reuse the helper.
- Correcting the 2026-11-16 post in the group after the fact.
- General fact-checking of everything in unprompted posts beyond event dates and identity.

## Design (architecture, GEP-93)

### Decision: the server reads the link
The server fetches each linked page itself and hands the model what it found. The model does
not open it.

- **The failure was the model reading the wrong source.** It already had `web_search` and a URL
  in its context, and it came back with 23 instead of 24. Telling it to open the link more
  firmly leaves the same component in charge of the same decision. A parsed `startDate` cannot
  drift by a day.
- **Testable.** Extraction, parsing, the address guard and the prompt block are all pure and
  unit-tested. The model path could only be tested by sampling.
- **Checked, not assumed.** On 2026-11-17 a plain `GET https://luma.com/aic-ta-11-24` from
  outside returned `200`, `text/html`, 212 KB, with a JSON-LD `Event` at byte ~3.2 KB:
  `name` "Lovable Promptathon Bucharest: From Vibe to Live (w/ The AI Collective)",
  `startDate 2026-11-24T16:00:00.000+02:00`. `og:title` was at byte ~0.8 KB.
- **The cost is an SSRF surface, and it is real on this box.** Gepetel runs on the Pironman Pi on
  the dual-stack `coolify` Docker network. Its neighbours (Sablier, Postgres, the other apps)
  are on `10.0.1.0/24` *and* `fddf:6e69:23a7::/48`, and a guard that only checks IPv4 misses
  half of them. Pironman found exactly this in its own audit recipe. The guard below is
  therefore part of the feature, not an add-on.

`web_search` stays on the gossip model for finding something new. It is just no longer how a
linked page gets read.

### Components

**1. `extractLinks` (`src/util.ts`, pure)**
```ts
export type SharedLink = { url: string; from: string };
export function extractLinks(msgs: { from: string; text: string }[], max = 3): SharedLink[];
```
- Takes the **untruncated** message texts (the cron cuts lines to 300 chars for the prompt, so
  extract before cutting).
- Only `http://` and `https://` URLs. Trailing punctuation that is not part of the URL
  (`.,;:!?)]}»"'`) is stripped, but a `)` stays when the URL has a matching `(`.
- Dedupe on the URL with the fragment removed. `from` is the **first** person in the window who
  shared it.
- Ordered by **most recent** mention, capped at `max`.

**2. `src/links.ts` (new)**
```ts
export type LinkRead =
  | { url: string; from: string; ok: true; title: string | null; startDate: string | null; endDate: string | null; location: string | null }
  | { url: string; from: string; ok: false; reason: "blocked" | "timeout" | "not-html" | "too-large" | "http-error" | "error" };

export function isPublicAddress(ip: string): boolean;            // pure
export function parsePageMeta(html: string): { title; startDate; endDate; location }; // pure
export function formatLinksBlock(reads: LinkRead[]): string;      // pure; "(none)" when empty
export async function readLinks(links: SharedLink[]): Promise<LinkRead[]>; // never throws
```

`parsePageMeta`, in priority order:
1. JSON-LD (`<script type="application/ld+json">`), including `@graph` and top-level arrays.
   The first node whose `@type` is or includes `Event` (or a subtype: `*Event`) gives `name`,
   `startDate`, `endDate` and `location.name`/`location.address`. Malformed JSON-LD is skipped,
   not fatal.
2. OpenGraph `og:title`, then `<title>`, for the title only. Entities are decoded, whitespace is
   collapsed and the title is capped at 200 chars.
3. **A date only ever comes from structured data** (JSON-LD `startDate`). It never comes from
   body text, `article:published_time` or the title. If there is no structured date,
   `startDate` is null and the block says "date not stated".

`formatLinksBlock` renders one entry per link:
```
- Nicolae shared https://luma.com/aic-ta-11-24
  title: Lovable Promptathon Bucharest: From Vibe to Live (w/ The AI Collective)
  date: Tuesday 24 November 2026, 16:00–22:00 (UTC+02:00, as stated on the page)
- Ana shared https://example.org/x
  could not be read
```
- The human date is computed from the **offset written in the `startDate` string**, not the
  server's timezone, so a page in +02:00 is never moved to the previous day. A date-only
  `startDate` (`2026-11-24`) renders without a time. An unparseable one is printed verbatim.
- URLs are shown without their query string (it can carry tokens), like the logs.
- Weekday and month names are in English. The model translates, and English keeps the block the
  same for every group.

**`readLinks`: the fetch and its guard.** It uses `node:http`/`node:https` directly (no new
dependency) and reads the links in parallel. Each read:
- **Scheme and port:** `http`/`https` only, port 80/443 only (an explicit `:8080` is `blocked`).
  A URL carrying credentials (`user:pass@`) is `blocked`.
- **Address:** every resolved address must pass `isPublicAddress`.
  - The hostname is resolved with `dns.lookup(host, { all: true })`. If **any** returned address
    is non-public, the read is `blocked`. Otherwise the request connects to a vetted address via
    the request's `lookup` option, so the address checked is the address used. This rules out
    DNS rebinding between check and connect.
  - **An IP literal in the URL never goes through `lookup`** (Node skips resolution for
    literals), so it is checked explicitly with `net.isIP` before the request. This includes
    bracketed IPv6 literals.
  - `isPublicAddress` uses `net.BlockList` and covers both families:
    - IPv4: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`,
      `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`,
      `203.0.113/24`, `224/4`, `240/4`.
    - IPv6: anything outside `2000::/3` (this rejects `::`, `::1`, `fc00::/7` **ULA** including
      this box's `fddf:6e69:23a7::/48`, `fe80::/10`, `fec0::/10` and `ff00::/8`). Within
      `2000::/3`, it also rejects `2001:db8::/32` and `2001::/32` (Teredo).
    - **Embedded IPv4 is unwrapped and re-checked:** `::ffff:a.b.c.d` (mapped), `64:ff9b::/96`
      (NAT64) and `2002::/16` (6to4). `::ffff:10.0.1.6` must be blocked.
- **Redirects:** followed by hand, at most 3. **Every hop** goes through the same scheme, port
  and address checks. A redirect to `http://10.0.1.6:10000/` is `blocked`.
- **Request:** `GET`, a 5 s timeout per link covering connect through body, and an overall
  budget of 8 s for `readLinks`. Headers are a fixed `User-Agent` (a normal browser-compatible
  string naming Gepetel), `Accept: text/html,application/xhtml+xml` and
  `Accept-Encoding: gzip, deflate, br`. No cookies, no `Authorization` and no forwarded headers.
- **Response:**
  - Non-2xx after redirects gives `http-error`.
  - A `Content-Type` that is not `text/html`/`application/xhtml+xml` gives `not-html`.
  - The body is capped at **1 MB after decompression**. A `Content-Length` over the cap, or a
    stream that passes it, gives `too-large`. Luma is 212 KB.
  - The body is decoded as UTF-8 and given to `parsePageMeta`.
- It **never throws**. Any failure becomes `{ ok: false, reason }`, and a failed read never fails
  the cron for that group (spec rule 4).

**Logs** (spec rule 5): one line per group with links, host and outcome only. For example:
`Unprompted links <chatId>: luma.com ok (event, dated); example.org could not be read (timeout)`.
No titles, page content, paths or query strings.

**3. Prompt: `prompts/gossip.txt`**
- New block after the conversation:
  ```
  Links shared in the conversation (read by us just now — this is what each page says):
  {{links}}
  ```
- New rule, *a linked thing is THE thing* (spec rule 2): something linked above is the subject
  already being discussed. Never present it, or the same event found elsewhere, as new,
  separate, a warm-up, a "related" event or "before" it. If you post about it, build on it with
  something they don't have yet (a practical detail, what to bring, who's going). Whoever shared
  a link only shared it: never call them its organiser or owner, and never write "X's
  hackathon", unless the conversation says so.
- New rule, *dates only from a source* (spec rule 3): a date, weekday or time for an event may
  appear only if it is copied from the links block or from a page you opened in this turn. A
  link marked "could not be read" or "date not stated" has **no** date. Do not supply one from
  memory or from search results about it. If sources disagree, leave the date out. A post
  without a date is fine. A wrong date sends people on the wrong day.
- Amend the existing "Carry the facts that make it actionable: the date, …" paragraph so it
  points to that rule, and does not read as an instruction to produce a date.

**4. `generateGossip` (`src/oai.ts`)**
- Adds a trailing parameter `links: string = "(none)"`, passed to the prompt as `{{links}}`. The
  existing call sites and the existing LLM test keep working unchanged.
- A conversation with no links produces the same prompt as today, apart from the new rules and a
  links block reading "(none)". That is the *No regression* criterion.

**5. Wiring (`src/cron.ts`, `/cron/unprompted`)**
- Runs after `recent` is computed:
  `extractLinks(recent)` → `readLinks` (only when there are links) → `formatLinksBlock` → the
  new argument to `generateGossip`, plus the log line.
- The whole step sits in its own `try/catch`. On any exception it logs host-free
  `Unprompted links <chatId>: failed (<error name>)` and passes "(none)" when nothing was read,
  so the post decision still runs.
- No new environment variables. No data-model changes, because nothing is persisted.

### Data model / API
None. There is no schema change, no new route and no frontend.

### Tests
- `tests/util.test.mjs` (`extractLinks`):
  - order is newest first;
  - dedupe keeps the first sharer;
  - the cap is 3;
  - trailing punctuation is stripped and a balanced `)` is kept;
  - non-http schemes are ignored;
  - a URL beyond 300 chars into a message is still found.
- `tests/links.test.mjs` (new, mapped to `server` by `scripts/test-changed.mjs`'s
  `^(src|prompts|website|tests)/` rule):
  - `parsePageMeta` on a **saved luma-shaped fixture** (`tests/fixtures/luma-aic-ta-11-24.html`,
    trimmed to its `<head>`) gives the name and `2026-11-24T16:00:00.000+02:00`;
  - the `@graph`/array JSON-LD forms work;
  - a malformed JSON-LD block falls back to OG;
  - `<title>` only gives no date;
  - a page whose body text mentions "23 noiembrie" but has no JSON-LD date gives `startDate`
    null.
  - `formatLinksBlock`:
    - the luma entry renders "Tuesday 24 November 2026, 16:00–22:00 (UTC+02:00…)";
    - a `+02:00` time just after midnight stays on its own day;
    - failures render "could not be read";
    - an empty list gives "(none)";
    - the query string is dropped.
  - `isPublicAddress` table:
    - each IPv4 range above;
    - `::1`, `fe80::1`;
    - `fddf:6e69:23a7::d`, `fc00::1`;
    - `::ffff:10.0.1.6`, `::ffff:127.0.0.1`, `64:ff9b::a00:106`, `2002:0a00:0106::1` are all
      blocked;
    - `2606:4700::1111` and `1.1.1.1` are allowed.
  - `readLinks` against a local `http.createServer` on `127.0.0.1`:
    - it is `blocked`, which proves the guard runs on real requests;
    - a test-only seam that disables the guard then proves the timeout, the 1 MB cap,
      `not-html`, a non-2xx, the 3-redirect limit, and that a redirect to `127.0.0.1` with the
      guard enabled is `blocked`.
    - The seam is a module-level setter, not an env var, so production cannot switch it off.
- `tests/llm.test.mjs`, in the "unprompted gossip hygiene" block (needs `RUN_LLM_TESTS`):
  - **Regression:**
    - **Input:**
      - the conversation is
        `Nicolae: https://luma.com/aic-ta-11-24 are cineva chef de un mic hackathon? Eu nu m-am mai jucat cu Lovable până acum 🤣`;
      - group "Daily SI SI SI", Romania, Romanian, timezone `Europe/Bucharest`;
      - members include Nicolae and others;
      - the links block is `formatLinksBlock` of the luma metadata.
    - **Sampling:** 3 samples, and every one must pass.
    - **A sample passes when** it is "no answer", or:
      - no `\b23\b`;
      - any `\d{1,2} (noiembrie|nov…)` / `\d{1,2}[./]11` is 24;
      - no `încălz|warm.?up|separat|înainte de|pregătire pentru` about the hackathon;
      - no `hackathonul lui Nicolae|organiz\w*.{0,20}Nicolae|Nicolae.{0,20}organiz`.
    - The failing sample is printed in the assertion message. Timeout is 120 s per sample,
      because `web_search` is slow.
  - **Unreadable:** same conversation, with the link "could not be read". Every one of 3 samples
    contains no day-of-month date, or is "no answer".
  - **Existing case:** the Greece case keeps passing.

### Build order
`links.ts` (+ `extractLinks`) and the prompt/`generateGossip` change are independent and can be
built in parallel. Wiring the cron needs both. QA comes last, on production: there is no
staging, so `main` deploys to https://gepetel-coolify.bogdanripa.com.

### Risks / notes
- **Sites that block bots.** Some sites (Cloudflare challenges) will answer 403/503. That is
  `could not be read`, which is the safe outcome by rule 3.
- **Latency.** Adds at most ~8 s per group with links to an hourly cron that already waits on a
  `web_search` model call. No group without links pays anything.
- **Fetch timing.** A fetch only happens when a group's unprompted slot is due and the window
  holds a link, so at most 3 fetches per group per slot. This is not a crawler.
