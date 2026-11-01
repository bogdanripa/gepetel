# GEP-56 — Unprompted posts must not address people who aren't in the group or revive stale topics

## Goal
An unprompted post (`/cron/unprompted`, `prompts/gossip.txt`) must only address people who
are actually in the group, and must only build on this group's *recent* context.

## What happened
Vila 18, 2026-10-28 06:00Z: Gepetel posted unprompted about a second-hand inverter and ended
with "Andrei, ai ieșit din faza „nu încă”?". Asked "cine e Andrei?", it admitted nobody in
the group is Andrei and that it assumed it "from the old conversation". It addressed a
non-member by name, revived a topic nobody had raised, and looked like another chat's
context leaking in.

## Findings from the code (not from production data)
- Unprompted inputs are `getRecentMemoriesText(chatId)` (no age limit, last 10 memories) and
  `getCachedMessages(chatId)` (last 30, may be days old). Both are per-chat in code, so a
  cross-group leak is not indicated by the code path, but it is **unverified**: the origin of
  "Andrei" (this group's old messages/memories vs another chat) needs a look at the
  production `interactions`/memory records for that post. QA/dev: report what you find; if it
  came from another chat, raise it as a privacy bug immediately.
- The prompt warns about stale plans but not about stale *people* or topics, and nothing
  validates the generated text against the participant list.

## Behaviour
1. **Name check (code, not prompt):** after generating an unprompted post, every person it
   addresses by name must be in the group's participant list (`g.participants`, bot stripped;
   match on display name / first name, case- and diacritics-insensitive). A name that matches
   no member → skip the post (do not post a version with the name removed unless trivially
   safe). Pass the member names to the prompt as the only people it may name.
2. **Recency window:** unprompted posts rest only on messages and memories from this group
   within a recent window (default 7 days, one constant). Older material is not passed in, or
   is passed marked as old and may not be the basis of the post. Exception: a topic a member
   brought up inside the window.
3. **Prompt:** `gossip.txt` states both rules: address only the listed members; do not
   resurrect topics not raised in the window; if nothing qualifies, "no answer".
4. Skips are logged (`Unprompted skip <chat>: unknown name "<x>"` / `no recent context`).

## Acceptance criteria
- Unit tests: a post naming a non-member is rejected; naming a member (incl. diacritics,
  first name only) passes; a post with no names passes.
- Unit tests: messages/memories older than the window are excluded from the gossip input.
- Prompt contains the member list and the two rules.
- No change to reply flows, DM prompts, cooldown/pushback logic or scheduling.

## Out of scope
Group *replies* addressing non-members (not reported); changing gossip frequency; the
pushback classifier.
