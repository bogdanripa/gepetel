# Gepetel — Architecture & Cadence Rules

## What Gepetel Is

Gepetel is a WhatsApp bot that behaves like a real group member rather than an automated assistant. It joins groups, participates in conversations when appropriate, handles practical tasks (reminders, polls, bill-splitting, image generation), posts recurring scheduled items set up privately by members, and occasionally kicks off gossip on its own. Its design is intentionally anti-intrusive: staying silent is the default; speaking is the exception.

---

## System Architecture

```
WhatsApp user
     │
     ▼  (webhook POST)
whapi.cloud ──────────────────► POST /whapi
                                    │
                          ┌─────────▼──────────┐
                          │     app.ts          │
                          │  (Express router)   │
                          └──┬──────────────────┘
                             │
              ┌──────────────┼──────────────────┐
              ▼              ▼                   ▼
          mongo.ts        oai.ts             whapi.ts
       (MongoDB Atlas)  (OpenAI API)     (WhatsApp API)
              │              │
              │    ┌─────────┤
              │    │  util.ts│  (pure helpers, no I/O)
              └────┘─────────┘
```

**Runtime**: Google Cloud Function (gen2), `europe-west3`. The Express app is wrapped with `@google-cloud/functions-framework`. Locally it falls back to `app.listen`.

**Auto-deploy**: Every push to `main` triggers a GitHub Actions workflow that deploys via Workload Identity Federation (no service-account keys stored).

**Key modules**:

| Module | Responsibility |
|--------|---------------|
| `app.ts` | Express routes, webhook handler, cron endpoints, message dispatch |
| `mongo.ts` | MongoDB schemas and all database operations |
| `oai.ts` | OpenAI API calls, tool execution loop, response generation |
| `util.ts` | Pure, testable helpers: reply gate, scheduling, group membership, region/language inference |
| `whapi.ts` | WhatsApp API integration (send, typing indicator, poll, URL fetch) |
| `telegram.ts` | Operator notifications (optional; no-ops when unconfigured) |
| `prompts.ts` | Prompt template loader with variable substitution |

**Models used**:
- `gpt-5-mini` — main reply generation (group, DM, gossip, greeting)
- `gpt-5-nano` — fast gatekeeper decision (`should-reply.txt`)

---

## Conversation Threading ("the book")

Every group and 1:1 chat has a `previousMessageId` field in its MongoDB `Group` document. This is OpenAI's `response_id` from the previous call. Passing it as `previous_response_id` in the next API call lets the model maintain full conversation context across turns without re-sending the raw history.

This threading (`previousMessageId`) is used in three places:

1. **Reactive replies** — when Gepetel responds to a message, the new `responseId` replaces the old one.
2. **Catchup processing** — when 20+ unread messages pile up (see below), they are silently fed through `updateMessages()` with the current `previousMessageId` so the model stays informed without sending a reply.
3. **Unprompted gossip** — the gossip generator also receives `previousMessageId` so that its out-of-the-blue message feels contextually coherent rather than random.

---

## Incoming Message Handling

All incoming messages arrive at `POST /whapi`. The handler:

1. Normalises bot mention variants (`@279697464266959`, `@+40750271099`) to `@gepetel`.
2. Records the message hour in the group's activity histogram (`activityByHour`).
3. Marks the WhatsApp message as read.
4. Decodes the message content type: plain text, image (described by vision model), voice/audio (transcribed via Whisper), GIF, or link preview.
5. Passes the resolved text to `processIncomingMessage`.

**Group roster updates** arrive as `groups` events in the same webhook and trigger a participant list refresh. **Contact name changes** arrive as `contacts` events and update stored names. **Poll vote updates** arrive as `messages_updates` events and update vote tallies.

---

## Reply Decision: When to Reply

`processIncomingMessage` runs a three-way gate before doing any expensive model work.

```
┌─────────────────────────────────────────────────────┐
│ Is it a 1:1 (DM) message?                           │
│   YES ──► always reply (skip gate entirely)          │
│   NO ───► is @gepetel mentioned?                     │
│             YES ──► always reply                     │
│             NO ───► how long since Gepetel last spoke│
│                       < 5 min ──► CONSULT gatekeeper │
│                       ≥ 5 min ──► stay silent        │
└─────────────────────────────────────────────────────┘
```

**The gatekeeper** (`should-reply.txt` / `gpt-5-nano`): given Gepetel's last message and the recent conversation, it answers "yes" only if the new message is a direct follow-up *to Gepetel's own line* — an answer, a follow-up question, or a clear continuation. Any topic change, side comment, or conversation between other members returns "no". When in doubt the gatekeeper says "no".

The 5-minute window exists because reacting to messages that arrived long after Gepetel last spoke would be intrusive random interjections. Re-engaging a quiet group is handled deliberately by the unprompted cron, not reactively here.

---

## When Gepetel Stays Silent

If the gate decision is "silent" (out-of-window) or the gatekeeper says "no":

1. The message is cached in MongoDB (`saveMessage`).
2. An `Interaction` record is logged with `action: "silent:<reason>"`.
3. No model call is made, no reply is sent.

**Catchup mode** (bulk-message processing): if the cached message count for a group exceeds 20, Gepetel calls `updateMessages()` — a silent model pass that consumes the backlog and updates `previousMessageId`. This keeps the conversation thread current so that when Gepetel does eventually reply (reactively or via gossip), the model's context isn't stale. No message is sent to the group.

Even when Gepetel decides to reply, the group-reply model may still return `"no answer"` — for example if the conversation is completely unaddressed to it. That outcome is also logged as silent.

---

## How Gepetel Replies

### Group messages (`group-reply.txt`)

- Tone: relaxed, funny, with light self-irony. Short (1–2 sentences). Emojis OK but not overdone.
- Language: always matches the group's language. Uses natural spoken register including common English loanwords.
- **Golden rule**: never offer to do things, never list capabilities. Act like a real member — if the group wants something, they'll ask.
- Tools are available (web search, reminders, polls, bill-splitting, image generation, memories) but are used silently only when explicitly requested. Never announced.
- Will not invent member names. Only refers to people who have spoken or who appear in the group roster.
- Returns `"no answer"` if there is genuinely nothing to add.

### DM messages (`dm.txt`)

- Always replies — every message in a 1:1 is addressed to Gepetel.
- Casual friend, not an assistant. Never lists capabilities.
- For educational/problem-solving requests: guides rather than hands over the answer. One suggestion at a time, concise.
- Matches the sender's language; defaults to English if unclear.

### New group greeting (`group-greeting.txt`)

- Triggered when Gepetel is added to a group it has never seen before.
- One short sentence (two at most), friendly and slightly ironic.
- May nod lightly to the group name if it hints at a topic.
- Hard rules: no offers, no capability hints, no participant count, no instructions on how to summon Gepetel.

---

## Unprompted Messages: The Gossip Cadence

Gepetel sends unsolicited conversation starters on a schedule — not in reaction to any incoming message.

### Scheduling

When a group is added (or after each gossip send), a `nextUnpromptedAt` timestamp is computed:

```
days  = random integer in [3, 6]
hour  = pickSendHourUTC(group)   ← active hour, ideally just before daily peak
nextUnpromptedAt = now + days days, at that hour (random minute)
```

`pickSendHourUTC` reads the group's `activityByHour` histogram (UTC hour → message count). It picks an active hour at or before the daily peak. If the group has no activity history yet, it falls back to the hour the group was first added.

### Cron trigger

`POST /cron/unprompted` runs hourly via Cloud Scheduler (authenticated with `X-Cron-Key`). It:

1. Fetches groups where `nextUnpromptedAt ≤ now` **and** `incomingMessagesSinceLastReply ≥ 10`.
2. For each due group, checks that the current UTC hour is in the group's active hours. If not, skips that group — *without* rescheduling. It will try again next hour.
3. Generates gossip via `generateGossip` (see below).
4. If gossip is found, sends it, marks the group replied, updates `previousMessageId`, and always reschedules `nextUnpromptedAt` (even if no gossip was found, so a dud doesn't retry every hour).

The minimum 10-message threshold ensures Gepetel only re-engages active groups, not dormant ones.

### Gossip generation (`gossip.txt`)

The gossip prompt instructs the model to:

1. Web-search for something recent, hot, controversial, or gossip-worthy.
2. Prefer topics tied to the group's known memories or its region. Fall back to a major global story if nothing local is found.
3. Drop it as 1–2 sentences the way a friend would share a rumor — relaxed, with a hook. No "according to", no headline phrasing, no links or citations, no sources.
4. Only share something it's reasonably confident actually happened.
5. If nothing worth sharing is found, return `"no answer"` (and that send is skipped, but `nextUnpromptedAt` is still rolled forward).

---

## Daily Reply Limit

Each group has a configurable daily cap on Gepetel's outgoing replies (default: **64**, stored as `dailyReplyLimit` on the Group document and adjustable per group).

When the cap is reached:
- The **first two** subsequent reply-eligible messages trigger a short, casual limit-reached message in the group's language ("I've hit my daily limit…"), generated by the model so it sounds natural.
- After **two warnings**, Gepetel goes completely silent for the rest of the UTC day — no typing indicator, no reply, just a logged `silent:daily-limit` interaction.
- Counters (`dailyReplyCount`, `dailyLimitWarningCount`) reset automatically at UTC midnight on the next incoming message.

Unprompted gossip messages and reminder deliveries do **not** count toward the daily limit; only reactive replies do.

---

## Reminders Cron

`POST /cron/fire-reminders` also runs hourly. It queries due reminders and calls `sendWhatsAppMessage` for each one. Recurring reminders (daily / weekly / monthly) have their next occurrence computed and re-saved after firing.

The same hourly tick then runs the scheduled tasks (see below); their failures are caught so they can never fail the reminders run.

---

## Scheduled Tasks

Recurring things Gepetel posts into a group on a timer: a poll, a fixed message,
or content he writes fresh each time.

### Setup happens in a 1:1, never in the group

Configuring this in the group itself would be noisy for everyone else, so the
tools live only on the DM path (`create/list/update/delete_scheduled_task`).
Any member of a group can set something up for that group.

**Authorization** is enforced in `assertGroupAccess` (`mongo.ts`) and is
deliberately fail-closed. Every operation takes a `TaskContext` — either
`{admin: true}` (the operator, behind Basic auth) or `{requesterChatId}` (a real
person, identified by the chat id whapi puts on the DM). A caller supplying
neither is rejected, so forgetting to pass context can never widen access.

Membership is re-checked against the database on **every** call. The list of a
user's groups is injected into the DM prompt so the model can talk about them by
name — but that list never authorizes anything: a chat id the model invents (or
is talked into) simply won't match. Related guarantees: a non-member gets the
same "not found" as a missing task (no existence leak), a task can't be
re-pointed at another group, and `listScheduledTasks` scopes non-admins to their
own groups.

### Schedule model

`hour_local` (0–23) + `days_of_week` (`0`=Sun … `6`=Sat) evaluated in the
**group's own timezone** (`util.isTaskDue` / `localParts`, via `Intl`). DST is
handled for free: "9am" stays 9am, firing at 07:00Z in winter and 06:00Z in
summer. "Every workday" is `[1,2,3,4,5]`.

**One-offs** come in two shapes:

- `run_on_date` (`"YYYY-MM-DD"`, local to the group) replaces `days_of_week`: the
  task runs once on that date and deactivates itself. It fires at *or after* its
  hour, so a missed cron run still lands the same day, but it can never spill onto
  another day. Impossible dates (`2026-02-30`) and past dates are refused at
  creation rather than silently never firing.
- `sendPollNow` skips scheduling entirely — one poll, posted immediately, no row
  stored. It reuses the same delivery path, so it inherits vote tracking,
  attribution and the silence guarantee.

### Kinds

| Kind | Payload | Behaviour |
|------|---------|-----------|
| `poll` | `{question, options[], allow_multiple}` | Native WhatsApp poll. Registered in `Poll` so votes tally through the normal webhook. |
| `text` | `{text}` | The same message verbatim every time. |
| `generated` | `{instruction, web_search}` | Written fresh each run by the model. |

**whapi poll semantics** (learned the hard way — every poll was silently arriving
as a plain-text list): `POST /messages/poll` takes a **flat** body
`{to, title, options, count}`, not a nested `poll` object. `count` is the cap on
how many answers *one person* may pick, and the API rejects anything above 1
(`/body/count must be <= 1`) — it is **not** the number of options:

- `count: 1` → single answer
- `count: 0` → no cap, i.e. multi-select (verified against a live send)

Options must be unique and number 2–12. When the native call fails, `whapi.ts`
falls back to a numbered text list — which is *not* a poll: nobody can tap it and
no votes are recorded. That fallback logs loudly, because a silent degrade here
hid the malformed payload for a long time.

`generated` replaced earlier fixed `news`/`joke` kinds. The `instruction` is
composed during the DM from what the user described, and must be self-contained
— it's read with no memory of that conversation. `web_search` is opt-in per task
so a joke doesn't pay for a lookup.

`prompts/scheduled-generated.txt` holds the invariant rules (language, length,
no preamble, never reveal it's scheduled, no links, nothing mean about a member)
and injects `{{instruction}}` as **delimited data**, explicitly marked as
describing the subject and unable to override the rules. The instruction is
untrusted text that executes daily, so the guardrails must sit outside what the
requester controls.

### Firing

`fireDueScheduledTasks` runs on the existing hourly `/cron/fire-reminders` tick —
no extra Cloud Scheduler job. `POST /cron/scheduled-tasks` (same `X-Cron-Key`)
triggers the same work manually.

- **Slots are claimed atomically** (conditional update on `last_fired_at`), so
  overlapping cron runs can't double-post.
- **A failed send releases the claim**, allowing a retry within the same hour but
  never spilling into the next — better a skipped 9am poll than one at 10.
- **Nothing to say → nothing sent.** A `generated` task whose model call returns
  `"no answer"` (or fails) is skipped silently.
- **Left the group** → the task pauses itself instead of erroring hourly.
- Each post is credited to whoever scheduled it (`util.attributeToScheduler`):
  `(via @Name)` in a poll title, `— via @Name` on its own line otherwise. Plain
  text, not a real mention, which would otherwise ping that person daily.

### Scheduled posts do NOT wake Gepetel up

A scheduled post is something Gepetel was *told* to publish, not something he
chose to say, so the group can react to it without him butting in.

This is achieved **by omission**: the firing path never calls `markGroupReplied`
or `recordGroupAnnouncement` (both set `lastReplyAt`) and never increments
`dailyReplyCount`. The reply gate keeps measuring silence from his last *real*
reply, so an unmentioned follow-up still resolves to `out-of-window` → silent. An
explicit `@gepetel` still wakes him, because a mention short-circuits the gate
before timing is considered.

To keep him informed without breaking that, what was posted is written to the
message cache as a line from "Gepetel". It gets ingested the next time he
genuinely wakes up — so he knows he posted the poll — while `lastReplyAt`,
`dailyReplyCount` and `messagesSinceLastSend` all stay untouched. There is an
integration test asserting exactly this ("THE SILENCE GUARANTEE").

---

## Operator Notifications (Telegram)

`telegram.ts` sends notes to the operator — not to users; Gepetel talks to people
on WhatsApp only. Today it fires when Gepetel is added to a **brand-new** group,
with the group's name, size, region and language.

Deliberately only for new groups: a re-add, or a group waking after a quiet day,
also triggers a greeting, and pinging for those would be noise.

Entirely optional and **fail-soft**. With `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
unset it logs a line and does nothing; if Telegram errors or times out the failure
is swallowed. A notification must never stop Gepetel greeting a group.

---

## Region, Language, and Timezone Inference

Gepetel infers group attributes from participant phone numbers:

- **Country / Language**: phone prefixes are matched against `CALLING_CODES` (e.g. `+40` → Romania / Romanian). The dominant value among non-bot members wins.
- **Timezone**: mapped from the dominant country via `COUNTRY_TIMEZONE`.

These values are passed into prompts as `{{region}}`, `{{language}}`, and as the current local time string so the model can reason about time correctly.

---

## Data Model Highlights

| Collection | Purpose |
|------------|---------|
| `Group` | One doc per chat. Tracks `participants`, `lastReplyAt`, `lastReplyText`, `previousMessageId`, `activityByHour`, `nextUnpromptedAt`, `numUnsentMessages`. |
| `Message` | Cached unread messages per group (cleared after catchup or on reply). |
| `Reminder` | Recurring and one-off reminders with assignee, due date, recurrence. |
| `ActionItem` | Tasks with assignee, status, optional due date. |
| `Poll` | Poll question, options, and vote tally. |
| `ScheduledTask` | Recurring group post (poll / text / generated) with its weekday+hour schedule, target group, and who set it up. |
| `Memory` | Tagged facts/decisions persisted across conversations. |
| `Interaction` | Audit log of every incoming message and Gepetel's response or silence reason. TTL: 14 days. |
| `People` | Phone number → display name mapping, kept fresh from incoming messages and contact events. |

---

## DM Upsell Flow (Extending the Daily Limit)

1:1 messages are handled as a general conversation, but the DM prompt is aware of the upsell capability. If a user mentions extending their group's limit, Gepetel guides them through the flow naturally.

The DM path also carries the scheduled-task tools (see *Scheduled Tasks*). Its group list includes each group's chat id so the model can resolve "the Greece group" to a real target.

**Conversation flow:**
1. User sends Gepetel a DM about anything.
2. On every DM, Gepetel fetches all groups the user is a participant of (queried by phone digits from the `Group.participants` array).
3. The group list is injected into the system prompt so the model can reference group names and IDs.
4. If the topic of extending a limit comes up, the model generates a payment link:
   `https://gepetel.bogdanripa.com/pay?groupId=<chatId>&userId=<userChatId>`

**After payment — `POST /payment/callback`:**

The payment provider POSTs with `{ groupId, userId, limit, secret }`:

1. `secret` is verified against the `PAYMENT_SECRET` env var (403 on mismatch).
2. `dailyReplyLimit` is updated on the group document.
3. A short announcement is generated in the group's language and sent to the group: *"X extended the daily limit. Now I have Y messages I can send every day."*
4. A confirmation DM is sent to the user who paid.

---

## Admin UI

Protected by HTTP Basic Auth (`CRON_SECRET` as password):

- `GET /groups/` — list all known groups.
- `GET /groups/:id` — interaction history for one group (last 2 weeks).
- `POST /groups/:id` — inject a test message into a group for debugging.
- `GET /scheduled-tasks/` — all scheduled tasks with schedule, status and last fire
  (`Accept: application/json` for JSON). Each row has **run now** and **delete**.
- `POST /scheduled-tasks/` — create one directly (validation errors return 400).
- `POST /scheduled-tasks/:id/run` — post it immediately, ignoring its schedule.
  Deliberately does *not* set `last_fired_at`, so testing never eats the real slot.
- `DELETE /scheduled-tasks/:id` — remove one.

---

## Public Send API

`POST /api/send` lets an authorised 3rd party post a message to a group; Gepetel
delivers it **verbatim** (no model rewrite).

- **Auth**: `X-Api-Key` header must equal `PUBLIC_API_KEY` (403 otherwise).
- **Body**: `{ "groupId": "<chatId@g.us>", "message": "<text>" }`.
- **Validation**: `groupId` must be a WhatsApp group id and the group must be one
  Gepetel already belongs to (404 `group_not_found` otherwise); empty/invalid input → 400.
- **Effect**: sends the text via whapi, then records it like a system announcement —
  `lastReplyAt`/`lastReplyText` are refreshed (so the reply gate knows Gepetel just
  spoke) but the gossip counter and the OpenAI conversation thread are left untouched.
  Logged as a `replied` interaction with author `(api)`.
- **Responses**: `200 {status:"ok"}`, `400`, `403`, `404`, `502 send_failed`, `500`.

```bash
curl -X POST https://<host>/api/send \
  -H "X-Api-Key: $PUBLIC_API_KEY" -H "Content-Type: application/json" \
  -d '{"groupId":"12036…@g.us","message":"Heads up: standup moved to 10am."}'
```

---

## Configuration

| Variable | Source | Purpose |
|----------|--------|---------|
| `WHAPI_TOKEN` | Secret Manager / `.env` | whapi.cloud channel token |
| `OPENAI_API_KEY` | Secret Manager / `.env` | OpenAI API key |
| `GEPETEL_DATABASE_URL` | Secret Manager / `.env` | MongoDB Atlas connection string |
| `CRON_SECRET` | Secret Manager / `.env` | Auth token for cron endpoints and admin UI |
| `PUBLIC_API_KEY` | Secret Manager / `.env` | Auth key for the public `POST /api/send` endpoint |
| `TELEGRAM_BOT_TOKEN` | Secret Manager / `.env` | Operator notifications (optional — skipped when unset) |
| `TELEGRAM_CHAT_ID` | Secret Manager / `.env` | Where those notifications go (optional) |
| `K_SERVICE` | Injected by Cloud Run | When present, skips local `app.listen` |
