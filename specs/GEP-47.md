# GEP-47 — Don't call a user's own authorised payment a security incident when reacting to a screenshot

## Goal
When someone posts a screenshot in a group, Gepetel must not read a payment the poster
asked for and approved as fraud. A false "security incident" in a group damages trust and
could make someone dispute a legitimate payment.

## What happened
Group Adancata.next (2026-10-19): a member posted a screenshot of his own DM with Gepetel
("pay this invoice" → payment prepared → he confirmed "Done"), captioned as a flex. Gepetel
answered in the group that it was a security incident, told everyone to stop approving, call
the bank (a hotline pulled from a web search) and contest the payment. 53 people saw it.

## Behaviour (group replies)
1. Before calling anything fraud, a scam, an attack or a security incident from a
   screenshot, check what it shows. If the poster themself asked for the action and approved
   it (their own request plus their own confirmation), it is **authorised**: treat it as a
   flex or a joke. Reply at most with a light line in Gepetel's usual dry tone, or stay silent.
2. Never give "call the bank / block the payment / dispute it" instructions unless a person
   says they did NOT authorise the transaction.
3. Don't volunteer a bank or other hotline number from web search in a group unprompted.
4. Unchanged: if someone genuinely says a payment/message wasn't theirs, Gepetel may help.

## Acceptance criteria
- `prompts/group-reply.txt` contains the rules above, in the group-reply prompt.
- The "screenshot of own authorised payment" scenario yields a light reply or silence — no
  fraud/incident wording, no bank instructions, no hotline.
- No change to the DM prompt or any tool behaviour.

## Out of scope
Image understanding itself, payment flow, DM prompts (`dm.txt`), `should-reply.txt`.
