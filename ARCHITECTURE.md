# Gepetel — Architecture & Cadence Rules

## What Gepetel Is

Gepetel is a WhatsApp bot that behaves like a real group member rather than an automated assistant. It joins groups, participates in conversations when appropriate, handles practical tasks (reminders, polls, bill-splitting, image generation), and occasionally kicks off gossip on its own. Its design is intentionally anti-intrusive: staying silent is the default; speaking is the exception.

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
| `util.ts` | Pure, testable helpers: reply gate, scheduling, region/language inference |
| `whapi.ts` | WhatsApp API integration (send, typing indicator, poll, URL fetch) |
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
| `Memory` | Tagged facts/decisions persisted across conversations. |
| `Interaction` | Audit log of every incoming message and Gepetel's response or silence reason. TTL: 14 days. |
| `People` | Phone number → display name mapping, kept fresh from incoming messages and contact events. |

---

## Admin UI

Protected by HTTP Basic Auth (`CRON_SECRET` as password):

- `GET /groups/` — list all known groups.
- `GET /groups/:id` — interaction history for one group (last 2 weeks).
- `POST /groups/:id` — inject a test message into a group for debugging.

---

## Configuration

| Variable | Source | Purpose |
|----------|--------|---------|
| `WHAPI_TOKEN` | Secret Manager / `.env` | whapi.cloud channel token |
| `OPENAI_API_KEY` | Secret Manager / `.env` | OpenAI API key |
| `GEPETEL_DATABASE_URL` | Secret Manager / `.env` | MongoDB Atlas connection string |
| `CRON_SECRET` | Secret Manager / `.env` | Auth token for cron endpoints and admin UI |
| `K_SERVICE` | Injected by Cloud Run | When present, skips local `app.listen` |
