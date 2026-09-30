# GEP-4 — Scheduled tasks silently miss their slot

## Problem
`isTaskDue` (`src/util.ts`) only matches during the task's exact local hour, and
`fireDueScheduledTasks` (`src/mongo.ts`) never spills into the next hour. If the
single hourly tick for that hour is lost (scheduler hiccup, transient Mongo error,
downtime), the day's occurrence is dropped with no trace. On Mon 2026-09-28 the
"Poll: Birou" (every workday, 08:00 Europe/Bucharest) never fired; a colleague
noticed and sent it manually.

## Goal
A single missed tick no longer loses a recurring occurrence, and if an occurrence
is still lost, an operator finds out.

## Behaviour
1. **Catch-up grace window (recurring tasks).** A recurring task that matches its
   day rules is also due in the following hours up to `hour_local + 2`
   (inclusive, same local day only — never crosses midnight), provided it has not
   fired for *this occurrence*. "Fired for this occurrence" = `last_fired_at` falls
   on the same local date at or after `hour_local`. The window is a constant
   (`CATCHUP_HOURS = 2`), easy to tune.
2. Days-of-week / days-of-month / fortnightly rules are evaluated against the
   *current local date*, as today.
3. Existing guarantees stay: no double post for one slot (atomic claim), inactive
   tasks never fire, one-offs behave as now, a failed delivery releases the claim
   so a later tick may retry (now also within the grace window).
4. **Missed-occurrence alert.** When, on a tick, a recurring task is past its grace
   window today (i.e. local hour > `hour_local + CATCHUP_HOURS`), matches today's
   day rules, and has not fired for today's occurrence, send **one** Telegram
   message via `telegram.ts` (`notify`) naming the task (id + title + group), the
   scheduled time and last_fired_at. Must be deduped (once per task per
   occurrence — e.g. persist `missed_alerted_for` local date on the task doc) so
   hourly ticks do not repeat it. Telegram failures are caught and never break
   the tick. If Telegram is not configured, log at error level instead.
5. Alerts contain metadata only — no message content.
6. Tasks created *after* their slot on the same day must not trigger a catch-up or
   an alert for that day (use `created_at` / first-active time as a lower bound).

## Acceptance criteria
- Unit tests (`tests/util.test.mjs`): a workday 08:00 task with last_fired_at
  Friday is due Mon 08:00, 09:00, 10:00 local; not due 11:00; not due Mon if it
  already fired Mon 08:05 or 09:10; DST-day and midnight boundary cases; a
  fortnightly off-week task is never due.
- Unit tests (`tests/mongo.test.mjs`): tick at 09:00 fires a task whose 08:00 tick
  was skipped, exactly once across repeated ticks; alert sent once when the window
  has passed, not again on later ticks, not for a task created after its slot.
- Existing tests pass; `npm run build` clean.
- The `isTaskDue` and `fireDueScheduledTasks` comments are updated to describe the
  grace window (they currently state "never spill", which is no longer true).

## Out of scope
- Changing the cron cadence, moving to a queue/scheduler service.
- Making the assistant itself proactively check schedules when asked "where is the
  poll" (separate behavioural/prompt issue; may be filed later).
- Reminders (`fireDueReminders`) — they are already catch-up by design.
