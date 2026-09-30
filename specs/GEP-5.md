# GEP-5 — Gepetel deflects instead of checking when asked directly

## Problem
When a member @-mentions Gepetel with a direct status question about something he
manages ("where's the poll?"), he answers in character (a joke) instead of looking
at his own state. He only does the real lookup when pressed a second time.

## Goal
A direct, on-topic status question about something Gepetel controls (poll,
reminder, scheduled task/recurring post) is always answered from real state,
on the first ask.

## Behaviour
1. A message addressed to Gepetel that asks about the status/whereabouts/existence
   of a poll, reminder, action item or scheduled post ("where's the poll?", "did
   the poll go out?", "what reminders do you have?") must make him call the
   matching lookup tool (`list_polls`/`search_polls`, `list_reminders`/
   `search_reminders`, and — where available in that chat — `list_scheduled_tasks`)
   BEFORE replying. The reply states what the lookup found (or that nothing exists).
2. Humour is still welcome, but only after/around the factual answer, never instead of it.
3. The trigger is the direct question, not a follow-up: no second nudge needed.
4. Ordinary chatter, jokes and side comments between members stay unanswered
   (the reply-gate's "never intrusive" rule is unchanged); only messages clearly
   addressed to him (mention/reply to him) qualify.
5. Group-scope note: recurring/scheduled posts are configured in private chats and
   the scheduled-task tools are 1:1-only today. In a group he must not deflect on a
   question about a scheduled post: if he cannot read scheduled-task state there,
   the implementer should either expose a read-only listing scoped to that group
   or have him say plainly he can't see it from the group — never a joke instead.

## Acceptance criteria
- Prompt (`prompts/group-reply.txt`, and `prompts/dm.txt` where relevant) instructs
  lookup-before-reply for direct status questions, with the examples above.
- If the should-reply gate can drop a direct @-mention status question, it doesn't
  (`prompts/should-reply.txt`); verify addressed-to-him messages pass.
- Unit test(s) where the existing test setup allows (gate/tool-selection logic);
  otherwise a documented manual check on staging/production.
- On production: @-mention "where's the poll?" in a test group with an existing
  poll → first reply reflects real poll state, no deflection.
- No regression: unrelated banter still gets no reply.

## Out of scope
- Changing the gate for non-addressed messages.
- New tools beyond a possible read-only group-scoped scheduled-task listing.
- Changing tone/humour rules.
