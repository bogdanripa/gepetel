# GEP-72 — Don't accept a watching/monitoring duty he has no way to perform

Parent: GEP-71 (daily review for 2026-11-05).

## What happened
Group "Notificari Sector 1", 2026-11-04 11:24Z. A member wrote: "@Anca aici o sa ne dea
Gepetel mesaje despre tot ce se publica legat de Setrarului, Boiangiu sau Paharnicului".
Gepetel answered "Am înțeles: urmăresc Șetrarului, Boiangiu și Paharnicului și vă trimit
aici noutățile relevante. Trio-ul administrativ, acum sub supraveghere." He has no tool that
watches a website or a news feed. The member had to correct him a minute later: an external
automation does the watching and posts through him.

The message was describing `POST /api/send` (`src/app.ts`): an authorised third party posts
a message to a group and Gepetel sends it **verbatim**. The model is never involved in those
posts and cannot see that such an integration exists.

Had nobody corrected him, the group would have believed a watcher existed that does not.
It is a capability claim that looks like success.

## Goal
When someone describes something Gepetel will do on an ongoing basis (watch, track,
monitor, follow, "let us know when X is published/changes"), he only confirms what he can
actually do. He never says he is watching something he has no mechanism to watch.

## Behaviour (group prompt, `prompts/group-reply.txt`; mirror the rule in `prompts/dm.txt`)
1. **Ongoing duties need a mechanism.** He may confirm an ongoing duty only if he is setting
   up, in that same turn, the thing that performs it: a reminder / recurring reminder he
   creates, or (in a DM) a scheduled post. Anything else — watching a site, a feed, a
   public register, prices, news, a person's posts — he cannot do on his own, and he says so
   in one line instead of agreeing.
2. **Posts from an automation.** When the message says something/someone else will send the
   updates through him ("o să ne dea Gepetel mesaje despre…", "automatizarea îți zice să ne
   scrii"), he acknowledges *that*: messages arrive here through him when the automation
   sends them. He does not claim to be the one watching, and does not promise to filter,
   summarise or select "the relevant ones" (those posts go out verbatim).
   Good: "Am înțeles — când automatizarea trimite ceva, apare aici prin mine. Eu singur nu
   urmăresc site-uri." Bad: "urmăresc X și vă trimit noutățile", "acum sub supraveghere".
3. **Ambiguous → the honest version.** If it isn't clear whether an automation exists, he
   says what he does (writes when the automation sends something, or when asked) rather
   than promising to watch. He does not offer to build the watcher (golden rule: no
   fishing for work).
4. The humour rules still apply; a dry line is fine, but it must not imply the duty
   ("sub supraveghere", "am ochii pe ei").

## Acceptance criteria
- Replaying the 2026-11-04 message in a group, the reply does **not** contain a first-person
  watching/monitoring claim (urmăresc, monitorizez, supraveghez, "I'll keep an eye/track",
  or equivalent) and does acknowledge that messages will come through him from the
  automation.
- "Gepetel, urmărește site-ul primăriei și zi-ne când apare ceva despre Setrarului" (no
  automation mentioned) → he says in one line he can't watch sites on his own; he does not
  agree to do it.
- "Gepetel, amintește-ne în fiecare luni să verificăm site-ul primăriei" → he creates the
  recurring reminder as today (a real mechanism — this must not regress).
- The prompt change is covered by an LLM test case in the existing prompt test suite
  (`tests/llm.test.mjs` or wherever group-reply behaviour cases live), run via
  `node scripts/test-changed.mjs`.

## Checked, no work needed
- **Double-asterisk bold.** The stored reply had `**…**`, but `cleanWhatsAppText`
  (`src/util.ts`) rewrites `**x**` → `*x*` and is applied on send by both transports
  (`src/wagateway.ts`, `src/whapi.ts`). The group received single-asterisk bold. The stored
  interaction log keeps the pre-clean text, which is what the reviewer saw.

## Out of scope
- Building any site/feed watcher.
- Telling the model which groups have an `/api/send` integration (no such per-group record
  exists; the key is global).
- Genezio TEAM out-of-window silence (correct behaviour).
