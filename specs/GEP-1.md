# GEP-1 — Scheduled tasks auto-pause silently and can't be reactivated

## Goal
A recurring poll/reminder must not be lost to a transient "bot not in group" reading, and when a task does pause the operator must know and be able to undo it.

## Background
`deliverScheduledTask` (src/mongo.ts) sets `active:false` the first time `Group.botPresent === false` (or the group row is missing). On 2026-09-25 all 9 tasks paused at once — almost certainly a transient gateway/webhook hiccup, not 9 removals. There is no way to reactivate and no alert.

## Behaviour
1. **Re-verify before pausing.** When the cached check says the bot is absent, fetch fresh group info (`wa.getGroupInfo(chatId)`, as app.ts:310 does) via an injected dep. Only if that fetch *confirms* absence (bot not a participant / gateway says the group is gone) pause the task. If the fetch shows the bot present, self-heal: `setBotPresent(chatId, true)` and deliver normally. If the fetch itself fails or is inconclusive (error, timeout), do **not** pause: return `{sent:false, reason:"group-check-failed"}` and retry on the next tick.
2. **Reactivate.** The `/scheduled-tasks/` admin page shows a "reactivate" button on paused tasks, backed by `POST /scheduled-tasks/:id/reactivate` (same auth as the other admin routes) that sets `active:true`. JSON response `{ok:true}`. Also a "pause" is out of scope. Reactivating must not cause a burst of catch-up posts: it follows whatever missed-run rules `fireDueScheduledTasks` already applies.
3. **Alert.** When a task auto-pauses, send a Telegram note through `src/telegram.ts` (task title, kind, chat id/group name, reason). Never throws; must not block delivery. One alert per pause event (a task already inactive isn't re-alerted).

## Acceptance criteria
- Cached `botPresent:false` + fresh fetch says present → message is sent, group flag restored, task stays active, no alert.
- Cached `botPresent:false` + fresh fetch confirms absence → task paused, exactly one Telegram alert.
- Fresh fetch throws → task stays active, nothing sent, no alert, next run retries.
- Paused task in admin page has a working "reactivate" button; after click it shows active.
- Reactivate on unknown id → 404.
- Unit tests cover the three branches above and the reactivate route/function.

## Out of scope
Auto-reactivating already-paused tasks (the 9 existing ones are reactivated by the operator via the new button); changing how `botPresent` is set elsewhere; other alert types.
