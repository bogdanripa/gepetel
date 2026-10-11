# GEP-29 — Back off unprompted posts after pushback, and honour "only when asked" promises

## Problem
In Adancata.next (2026-10-05) an unprompted post (a loosely relevant event listing)
was mocked by the group ("So random it's almost beautiful", "hint hint"). Gepetel
answered "Am înțeles aluzia. Trec pe modul «răspund doar când sunt întrebat»" and
then kept answering banter for 30 minutes, including a message not addressed to him.
He made a promise he has no mechanism to keep, and the group noticed.

## Goal
1. A group's negative reaction to an unprompted post silences his unprompted posting
   in that group for a while.
2. If he says he will speak only when asked, that holds: for a bounded period he
   replies only to messages addressed to him.
3. Unprompted posts need a higher bar of relevance.

## Behaviour
### A. Unprompted cooldown after pushback
- After an unprompted post, the next few messages in that group (a short window, e.g.
  the next ~10 messages or 2 hours, whichever ends first) are checked for a negative
  reaction to it: mockery, sarcasm, "hint hint", "why is the bot talking", explicit
  "stop"/"don't". Detection may be a small LLM classifier call on that window, run only
  when such a post is "open" (not on every message).
- On a negative reaction, store on the group a `unpromptedCooldownUntil` (default
  7 days; configurable constant) and push `nextUnpromptedAt` past it. `/cron/unprompted`
  skips groups in cooldown. Log it at info level.
- Positive or no reaction changes nothing.

### B. "Only when asked" mode
- When Gepetel, in a group, commits to staying quiet unless asked (or a member
  explicitly tells him to, and he agrees), record `askedOnlyUntil` on the group
  (default 24 h; configurable). Prefer a deterministic mechanism over trusting prose:
  e.g. a tool/flag the reply flow sets when it makes that commitment, or the post-reply
  classifier detecting it.
- While active, the reply gate treats a message as "addressed to him" only if it is an
  explicit mention or a direct reply (quote) to one of his messages. Everything else —
  including the follow-up-window gatekeeper path — stays silent (cached, logged as
  `silent:asked-only`).
- Direct questions to him are still always answered; mode expires on its own, and a
  member can lift it ("you can talk again"/mentioning him with an invitation is enough
  to end it early only if the reply flow sets that explicitly — otherwise just expiry).
- If the mode cannot be enforced for some reason, the reply prompt must not make the
  promise (instruct him not to promise silence).

### C. Higher bar for unprompted posts
- `generateGossip` (prompt `prompts/gossip.txt`) must return "no answer" unless the post
  is tied to something the group actually discussed or is clearly useful to them; generic
  event listings, trivia and "I saw that…" items with no link to the group's recent
  topics are rejected. Tighten the prompt with this example (the track-day post) as a
  negative one.

## Acceptance criteria
- Group schema has cooldown / asked-only fields; unit tests cover the date logic and the
  gate decision (`util`/gate tests): in asked-only mode, an unaddressed message is
  silent even inside the follow-up window; a mention or quote-reply still replies; after
  expiry behaviour is unchanged.
- `/cron/unprompted` skips a group in cooldown and does not consume the slot wrongly.
- Pushback detection test with the Adancata exchange as a fixture (positive) and
  ordinary friendly replies as a negative.
- Prompt changes in `gossip.txt` / group-reply prompt as described; README/ARCHITECTURE
  updated if config constants are added.
- On production: simulating the scenario (unprompted post → mocking replies) results in
  no unprompted post for that group during the cooldown, and, after he promises to speak
  only when asked, an unaddressed banter message gets no reply while an @-mention does.
- No regression: normal mention replies and follow-up-window replies work as before when
  no mode is active.

## Out of scope
- Per-user mute, manual admin controls/UI, changing the normal unprompted frequency.
- Retroactively changing past groups' state.
