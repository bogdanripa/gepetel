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
