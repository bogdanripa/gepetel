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
