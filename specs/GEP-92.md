# GEP-92 — `botPresent` goes back to true whenever Gepetel is evidently in a group

Related: GEP-90 (daily review for 2026-11-17), GEP-81 (where the stale flag was first seen).

## What happened
Group *Daily SI SI SI … 🍹* (`40728555860-1578581780@g.us`) has `botPresent: false` in Mongo, and
the admin page shows it as **"not a member any more"**. Gepetel is in that group and posts there:

- wa-gateway logged `message sent` to that chat at 2026-11-16T20:00:12Z (the unprompted post);
- the group's stored `participants` contain the bot's number.

The flag was already false on 2026-11-15. This deploy's logs (from 2026-11-16 07:35Z) have no
`is no longer a member` line for the chat, so it was set earlier and never cleared.

Note on the evidence: the stored roster is **weak** evidence on its own. When `handleGroupEvents`
decides the bot was removed, it `continue`s *before* `setParticipants`, so a group he really left
also keeps a roster that still contains him. The successful send is the evidence that settles it.

## Why it matters
- `shouldGreetGroup` (`src/util.ts`) returns `true` whenever `botPresent === false`. The next
  membership or subject event in that group makes Gepetel post a "just joined" greeting to 11
  people he has been talking to all along.
- The admin page reports him as removed from a group he is active in.

## Root cause (as far as the code shows)
1. **Nothing clears the flag except a group event.** `botPresent` goes back to `true` only in
   `handleGroupEvents` (after the greet decision) and in `deliverScheduledTask`'s self-heal.
   A successful send, which proves membership, does not touch it.
2. **A partial roster can set it to false.** In `handleGroupEvents`, when `wa.getGroupInfo` fails
   (returns `null` or throws), the code falls back to the webhook payload's `group.participants`.
   That list can be partial. If the bot is not in it, the code records `botPresent: false`, as if
   it had been removed. This is the likely cause here, but it is not proven.

## Goal
`botPresent: false` means one thing: an authoritative roster showed that Gepetel is not in the
group. Anything that shows he is in the group sets it back to `true`.

## Behaviour
1. **A successful send to a group sets `botPresent: true`.** Every send path that goes through
   `sayAndRemember` / `showAndRemember` (`src/say.ts`) counts: replies, greetings, scheduled and
   unprompted posts, pictures. Only a send that returned a message id counts. A failed send
   leaves the flag as it was.
2. **A roster that contains the bot sets `botPresent: true`.** Whenever a group's roster is
   saved (`setParticipants`) and it contains one of `BOT_PHONE_DIGITS`, the flag is set to
   `true` in the same write.
3. **Only an authoritative roster can set `botPresent: false`.** In `handleGroupEvents`, the
   bot is treated as removed only when `wa.getGroupInfo` returned a non-empty roster without him.
   If `getGroupInfo` failed and the code is using the webhook payload's participants, a missing
   bot is **inconclusive**: the flag is left unchanged, the event is not used to greet, and
   one log line says so (chat id, and that the roster could not be read). This matches how
   `deliverScheduledTask` already treats a failed `checkGroup`.
4. **Re-add greetings still work.** A genuine removal (authoritative roster without him) still
   sets `false`, and the next add still greets. `handleGroupEvents` decides whether to greet from
   the flag as it was *before* the event (`existing.botPresent`), so item 2 setting `true` inside
   `setParticipants` must not change that decision. A test covers it.
5. **Writes are cheap and don't fail the send.** Updating the flag after a send costs at most one
   small write per group send, and an error there is caught and logged. It never fails or delays
   the reply.

## One-off data fix
The row for `40728555860-1578581780@g.us` is set back to `botPresent: true`. Behaviour 1 heals it
automatically on the first group send after the deploy (Gepetel replies and posts there daily).
The release check confirms it is `true`. If it isn't, it is set by hand with a targeted update for
that chat id only. No bulk backfill: the stored roster can't tell a removed group from a present
one (see the note above), so a migration keyed on it would undo genuine removals.

## Acceptance criteria
- [ ] After a successful group send through `sayAndRemember` or `showAndRemember`, the group's
      `botPresent` is `true`, even if it was `false` before. A failed send (no message id) leaves it
      unchanged. Unit or integration test.
- [ ] `setParticipants` with a roster containing a `BOT_PHONE_DIGITS` entry leaves
      `botPresent: true`. A roster without the bot does not change the flag. Test.
- [ ] `handleGroupEvents` with `getGroupInfo` failing and a payload roster that lacks the bot:
      `botPresent` stays as it was, no greeting is sent, and a log line says the roster was
      inconclusive. Test.
- [ ] `handleGroupEvents` with an authoritative roster that lacks the bot still sets
      `botPresent: false` and logs `is no longer a member`. A later event that adds him still
      greets (existing behaviour, regression test).
- [ ] A group with `botPresent: false` whose authoritative roster contains the bot greets on that
      event (existing re-add behaviour, unchanged by item 2 of *Behaviour*).
- [ ] After the release, the *Daily SI SI SI* row reads `botPresent: true` and the admin page no
      longer shows it as "not a member any more".
- [ ] The tests that cover the changed files pass (`node scripts/test-changed.mjs`).

## Out of scope
- Changing what `shouldGreetGroup` decides from the flag. With the flag now accurate, its rules stay.
- Saving a partial webhook roster through `setParticipants` when `getGroupInfo` fails and the bot
  *is* in the payload. That is a separate (roster accuracy) problem; this issue only stops it
  from setting the flag to false.
- Any change to wa-gateway.
- Bulk-correcting other groups' flags. They heal by behaviour 1 on their next send.

## Design

Three small backend changes and one pure helper. No schema change: `Group.botPresent` already
exists (`default: true`). No API or frontend change; the admin page reads the same field.

### 1. `src/mongo.ts` — one way to say "he is evidently here"
- New `confirmBotPresent(chatId): Promise<boolean>`:
  `Group.updateOne({ chatId, botPresent: { $ne: true } }, { $set: { botPresent: true } })`, no upsert.
  The filter makes it a no-op on the usual row (one indexed read, no write), matches rows where the
  field is missing, and never creates a row for a chat it doesn't know. Returns `modifiedCount > 0`.
  When it flips, log one line: `botPresent restored for <chatId> (<why>)` — that line is what the
  release check and future debugging look for. Export it on the default object.
- `setParticipants(chatId, participants, name?)`: if `participants` contains a `BOT_PHONE_DIGITS`
  entry (same digit test as everywhere else — use the helper below), add `botPresent: true` to the
  same `$set`. A roster without the bot does not touch the flag. Still one write.
- `newMessage`'s daily roster refresh (the other place a roster is saved, from `getGroupInfo` via
  `cb`): when the fetched non-empty roster contains the bot, also set `group.botPresent = true`
  before `group.save()`. Same rule, same write; never sets `false`.
- `setBotPresent(chatId, present)` stays for the authoritative-removal path.

### 2. `src/util.ts` — the membership verdict, pure and tested
```ts
export function rosterHasBot(ids: unknown[]): boolean      // digits of any id ∈ BOT_PHONE_DIGITS
export function groupMembership(info: { participants?: unknown[] } | null | undefined,
                                payload: unknown[]):
  { participantIds: string[]; authoritative: boolean; verdict: "present" | "removed" | "inconclusive" }
```
- `authoritative` = `info` has a non-empty `participants` array; `participantIds` are then
  `info.participants`, otherwise the payload ids (today's fallback, unchanged).
- `verdict`: bot in `participantIds` → `"present"`; not in it and authoritative → `"removed"`;
  not in it and not authoritative → `"inconclusive"`.
- Replace the three copies of the inline digit test (`app.ts:503`, `mongo.ts` scheduled-task
  self-heal, the new `setParticipants` check) with `rosterHasBot`.

### 3. `src/app.ts` — `handleGroupEvents`
- `existing` is read first, exactly as now, and the greet decision keeps using
  `existing?.botPresent` — the value from **before** this event. Do not re-read the row after
  `setParticipants`; that would turn every re-add into "already present" and stop re-add greetings.
- Compute `const ms = u.groupMembership(info, payloadIds)` and branch on `ms.verdict`:
  - `"removed"` → unchanged: `setBotPresent(chatId, false)` if the row exists, log
    `Gepetel is no longer a member of <chatId>.`, `continue`.
  - `"inconclusive"` → leave the flag and roster alone, no greeting, log
    `Group event for <chatId>: roster could not be read and the payload doesn't list Gepetel — inconclusive, botPresent left as it was.`, `continue`.
  - `"present"` → today's path: `setParticipants` (which now also sets `true`), greet decision from
    `existing?.botPresent`, the existing `setBotPresent(chatId, true)` calls stay (harmless, and the
    greet branch's one also covers a brand-new row).
- Spec behaviour 3 vs. the payload-with-bot case: when `getGroupInfo` failed but the payload
  *does* list him, behaviour is unchanged (out of scope per spec).

### 4. `src/say.ts` — a successful send proves membership
- In `sayAndRemember`, after the send: `if (sentId && isGroup) { try { await m.confirmBotPresent(chatId, ...) } catch (e) { console.error(...) } }`.
  Independent of `opts.openWindow` (an out-of-credits line still proves membership). Placed in the
  non-`[[next]]` branch, so each recursive part covers itself; in a group `[[next]]` is collapsed
  anyway.
- In `showAndRemember`, the same after `sent`, guarded by `u.isGroupChatId(chatId)`.
- Failed send (`sentId` falsy) → no call. Errors are caught and logged, never rethrown; the
  return value is unchanged.
- Cost: one filtered `updateOne` per successful group send, a no-op on every healthy row.

### Tests
- `tests/util.test.mjs` — `rosterHasBot` (plain digits, `@s.whatsapp.net`, LID entry, none) and
  `groupMembership`: authoritative with/without bot, `null`/empty info with payload with/without
  bot (`inconclusive`), empty both. Plus the re-add regression at the decision level: with
  `existing.botPresent === false`, an authoritative roster containing the bot → verdict `present`
  and `shouldGreetGroup({ botPresent: false, … })` → `true`.
- New `tests/botPresentDb.test.mjs` (skips without `TEST_DATABASE_URL`, like the other `*Db`
  tests): `setParticipants` with the bot sets `false → true`; without the bot leaves `false` as
  `false`; `confirmBotPresent` flips `false → true` and returns `true`, returns `false` when already
  true, creates no row for an unknown chat. `sayAndRemember`/`showAndRemember` against a group row
  with `botPresent: false`, with the provider's send stubbed (patch the `whapi` provider object's
  `sendWhatsAppMessage`/`sendWhatsAppImage`): a returned id → `true`; a `null` return → still `false`.
- `handleGroupEvents` is not exported and `app.ts` boots the server on import, so its branches are
  covered through the pure `groupMembership` + `shouldGreetGroup`; keep the `app.ts` change a thin
  `switch` on the verdict so there is nothing else in it to test.
- `node scripts/test-changed.mjs` must pass; the DB suite runs with `TEST_DATABASE_URL` set.

### Environments and verification
`main` is both the development and the production branch: no staging, no release step. The
builder works on `task/<KEY-N>` branch → PR into `main` → review → merge, which deploys
production (`https://gepetel-coolify.bogdanripa.com`, Pironman app `gepetel`).
QA verifies by (a) running the tests that cover the change, including the DB suite against a
throwaway database, and (b) after the deploy, reading the production row:
`db.groups.findOne({ chatId: "40728555860-1578581780@g.us" }, { botPresent: 1 })` via the
Pironman `db_run_script` tool (read-only), expecting `true` after the group's next send, with a
`botPresent restored for 40728555860-1578581780@g.us` line in the app log; and the admin page no
longer showing "not a member any more" for it. If the row is still `false` a day after deploy, QA
reports it; the targeted one-row fix is the spec's fallback, done with the human's agreement.
