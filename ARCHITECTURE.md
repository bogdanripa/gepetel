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
wa-gateway  ──────────────────► POST /wa
                                    │
                          ┌─────────▼──────────┐
                          │     app.ts          │
                          │  (Express router)   │
                          └──┬──────────────────┘
                             │
              ┌──────────────┼──────────────────┐
              ▼              ▼                   ▼
          mongo.ts        oai.ts               wa.ts
       (MongoDB Atlas)  (OpenAI API)     (provider switch)
              │              │                  │
              │              │          ┌───────┴────────┐
              │              │          ▼                ▼
              │              │      whapi.ts        wagateway.ts
              │    ┌─────────┤     (whapi.cloud)    (wa-gateway)
              │    │  util.ts│  (pure helpers, no I/O)
              └────┘─────────┘
```

**Runtime**: a Docker container on the Pironman (Coolify), served at `https://gepetel-coolify.bogdanripa.com`. The same hostname also serves the marketing site: the static bundle answers any path it has a file for, and everything else — plus every write — falls through to Express. `app.listen` binds `::` (dual-stack), which both the container's IPv6 healthcheck and the proxy's IPv4 connection need.

The Express app is still wrapped with `@google-cloud/functions-framework`, so it runs unchanged as a Cloud Function; `K_SERVICE` is what decides which mode it starts in.

**Rollback**: the Cloud Function (gen2, `europe-west3`) is kept deployed and frozen at the last revision that served production. Going back means repointing the wa-gateway webhook at it and re-enabling its two Cloud Scheduler jobs — no rebuild. `.github/workflows/deploy-gcp.yml` redeploys it on demand and is `workflow_dispatch`-only so `main` never ships to two places at once.

**Auto-deploy**: every push to `main` builds an arm64 image, pushes it to GHCR and calls the app's `/refresh` hook; the same run uploads `website/` as the static bundle.

**Key modules**:

| Module | Responsibility |
|--------|---------------|
| `app.ts` | Express routes, webhook handler, cron endpoints, message dispatch |
| `mongo.ts` | MongoDB schemas and all database operations |
| `oai.ts` | OpenAI API calls, tool execution loop, response generation |
| `util.ts` | Pure, testable helpers: reply gate, scheduling, group membership, region/language inference |
| `wa.ts` | The WhatsApp provider switch — everything else imports this, never a provider directly. Also holds the provider-independent bits (`notifyCreator`, `readUrl`) |
| `whapi.ts` | whapi.cloud provider (send, typing indicator, poll, webhook parsing) |
| `wagateway.ts` | wa-gateway provider — same surface, Meta Cloud API shapes |
| `watypes.ts` | The provider-neutral types both providers translate into |
| `telegram.ts` | Operator notifications (optional; no-ops when unconfigured) |
| `fx.ts` | Exchange rates (ECB via Frankfurter) for reconciling a mixed-currency tab |
| `prompts.ts` | Prompt template loader with variable substitution |

**Models used**:
- `gpt-5.6-luna` — main reply generation (group, DM, gossip, greeting) and image description
- `gpt-5-nano` — fast gatekeeper decision (`should-reply.txt`)
- `gpt-image-2` (quality `medium`) — image generation and editing
- `gpt-transcribe` — voice note transcription

Use the exact `gpt-5.6-luna` id, never the `gpt-5.6` alias — that alias routes
to Sol, which costs 25x as much per token.

### The WhatsApp provider switch

Gepetel reaches WhatsApp through one of two gateways, chosen by `WA_PROVIDER`
(currently `wa-gateway`):

| | `whapi` | `wa-gateway` (current) |
|---|---|---|
| Service | whapi.cloud, hosted | self-hosted, [docs](https://wa-gateway-coolify.bogdanripa.com/docs.html) |
| Credential | `WHAPI_TOKEN` | `WA_GATEWAY_TOKEN` (per number) |
| Shapes | whapi's own | Meta WhatsApp Cloud API |
| Webhook path | `/whapi` | `/wa` |

`wa.ts` resolves the provider **per call**, not at import time — on Cloud
Functions the secrets arrive in the environment after module load, and several
call sites pass `wa.sendWhatsAppMessage` around as a callback.

Four things about that seam are deliberate:

0. **An uncredentialed provider falls back rather than failing.** `WA_PROVIDER=wa-gateway`
   with an empty `WA_GATEWAY_TOKEN` sends through whapi and logs why, because every
   call would otherwise 401 and Gepetel would go mute in every group. That makes the
   cutover a single step — add the token and the switch completes itself — and it
   means a rotated-away token degrades instead of disappearing.

1. **Inbound is routed by payload shape, not by `WA_PROVIDER`.** `wa.parseWebhook`
   sends Meta-shaped bodies (`{object, entry[]}`) to `wagateway.ts` and everything
   else to `whapi.ts`, so both webhooks can be live while the switch is flipped and
   nothing is dropped mid-migration. Both routes accept both shapes.
2. **1:1 chat ids stay in whapi's `<digits>@s.whatsapp.net` form.** wa-gateway
   reports senders as bare digits; storing that as the chat id would open a
   second, empty history for everyone Gepetel already knows.
3. **Typing indicators carry the incoming message id.** wa-gateway models typing
   as Meta does — a read receipt for a specific message — so `sendTypingIndicator`
   takes the id. whapi ignores it and types into the chat.

Native polls work on both gateways, but the bodies differ (see the poll semantics
under Scheduled Tasks). Either provider falls back to a numbered text list — which
is *not* a poll — and logs loudly when the native send is refused.

---

## Conversation Memory: a sliding window

Each turn, the model is sent the **last 50 user-facing messages** of that chat —
both sides — rebuilt from `MessageArchive` and appended to the instructions. That
is the whole conversational memory. There is no cross-turn thread.

**Why not `previous_response_id`.** It chains forever, and every turn re-bills the
entire history as input. Unbounded, it reached **450,000 input tokens** on one 1:1
— the two-word message "mai multe" cost 454,033 — with 9.3M input tokens over two
days of which only 8% were cached, because prompts that large mostly miss the
prompt cache too. A window is ~600–3,000 tokens depending on the chat, and cannot
grow.

It also removed a whole bug class. A thread carried stale state indefinitely: old
refusals survived a prompt change and had to be overridden explicitly, and a voice
note once got answered with the *previous* question's reply. A window can't do
that — it only ever holds what was actually said, recently.

Details that matter:

- **Only user-facing messages.** Tool calls and tool results never enter the
  window; they belong to the single reply that produced them.
- **Gepetel's own lines come back as `assistant`**, so he recognises his own voice.
  Every outbound path goes through `sayAndRemember`, so greetings, scheduled posts,
  gossip and API sends are all in the window — a gap there would leave him reading
  a conversation in which he apparently never spoke.
- **Group messages are prefixed with the speaker's name**; a 1:1 isn't, since there
  is only one other person.
- **Each message is capped at 500 characters**, so one long image description or
  transcription can't crowd out the other 49.
- **`previous_response_id` still exists inside a single reply's tool loop** — that
  is what carries the tool results back to the model. It is short-lived by
  construction and never stored.
- **Long-range facts live in `Memory`** (`remember_fact` / `list_memories`), not in
  the window. Anything older than 50 messages is recoverable only if it was saved
  there.

---

## Incoming Message Handling

All incoming messages arrive at `POST /whapi` or `POST /wa`, are normalised into
the provider-neutral shapes in `watypes.ts`, and then take the same path. The handler:

1. Normalises bot mention variants (`@279697464266959`, `@+40750271099`) to `@gepetel`.
2. Records the message hour in the group's activity histogram (`activityByHour`).
3. Marks the WhatsApp message as read.
4. Decodes the message content type: plain text, image (described by vision model), voice/audio (transcribed via Whisper), GIF, document (named, never opened), or link preview.
5. Passes the resolved text to `processIncomingMessage`.

**Mentions arrive as names.** wa-gateway resolves a mention's LID to a phone
number in the body where it can (leaving the raw LID visible when it can't — a
missing mapping should be seen, not hidden), and `resolveMentionNames` then turns
that number into the person's name. So `@81656102801535 pe la cat plecati?` —
which used to reach the model verbatim and read as nonsense — becomes
`@Ana pe la cat plecati?`. Done before archiving, so the conversation window holds
readable text rather than phone numbers, and consistent with keeping numbers away
from the model everywhere else.

LID is WhatsApp's privacy migration away from phone-number JIDs, and LID→phone is
explicitly best-effort: the mapping is learned from traffic, so it will sometimes
be absent, and WhatsApp treats LIDs as canonical going forward. Worth knowing that
Gepetel currently keys membership, names, and region/language/timezone inference
on phone numbers — if those stop appearing in groups, timezone and language
silently fall back to UTC/English and membership checks fail closed.

**Replies are resolved against a message archive.** The gateway sends only the
quoted message's *id*, never its content, so `MessageArchive` records every
message seen — keyed by WhatsApp id, 30-day TTL — and a reply is rewritten for the
model as `[replying to Ana: "…"] mie îmi convine`. Gepetel's own sends are archived
too (`sendWhatsAppMessage` now returns the id where the gateway reports one), since
people reply to him as often as to each other.

Kept separate from `Message`, the unread backlog, which is *deleted* once consumed —
an archive has to survive being read. Two limits follow from taking only the id: a
reply quoting something older than the TTL, or from before Gepetel joined the group,
can never be resolved, and is shown as "an earlier message I don't have a record of"
rather than silently dropped. Only the gateway holds that history.

**Poll votes are recorded but never wake him.** A vote arrives from wa-gateway as
an inbound message (`type: "interactive"` with `interactive.poll_response`, and
`context.id` naming the poll it answers), so `parseWebhook` intercepts it *before*
`normalizeMessage` and routes it to the `polls` event stream instead. That stream
only ever updates a tally — it never reaches `processIncomingMessage`, so answering
a poll can't make Gepetel start talking in a group he was quiet in. Each delivery
carries the full current tally rather than a delta, so a missed or out-of-order
webhook self-corrects.

`get_poll_results` then answers the two questions a group actually asks — "who
won?" and "did everyone vote?" — returning the leading option(s) (several when
it's a tie), voter **names** (never phone numbers), the group size excluding
Gepetel, and who hasn't voted yet, with a count of those whose names he doesn't
know so a partial list never reads as complete. The tool is only offered when the
provider actually delivers votes (`observesPollVotes`); otherwise he'd confidently
report "0 votes" on a poll people had answered.

**Media is only decoded when Gepetel is awake in that chat.** Vision and Whisper
run per message, so a photo-heavy group nobody tags used to cost real money
describing images no one would ever read: over 14 days, **97% of vision
descriptions were generated while out-of-window** — written, stored, never used.

`isAwakeFor` asks the reply gate *before* decoding, using only what is free: the
message body, or an image/GIF caption (where an `@gepetel` would be). A 1:1 is
always awake; a group is awake when mentioned or inside the 5-minute continuation
window. Otherwise the message is logged as `a photo` / `a GIF` /
`a voice message`, keeping any caption verbatim — captions are text and cost
nothing.

Two consequences worth knowing:

- A photo posted while he's quiet has **no description** in the backlog, so he
  can't refer back to what was in it. The caption survives; the image content
  doesn't.
- A **spoken** "Gepetel" in a voice note can no longer wake a quiet group. A voice
  note has no caption, so there is nothing free to read, and transcribing every
  note in a chat he isn't part of is exactly the cost being avoided. Tagging him
  in text still works, and once he's awake notes are transcribed as before.

**Documents are known, not read.** wa-gateway follows Meta's two-step media flow
for files: the webhook says a document exists and names it, and the bytes stay on
WhatsApp until someone asks for them. Nothing is downloaded on receipt.

So a `document` message carries no link — only `filename`, `mime_type`,
`file_size`, an optional caption, and a `mediaId`. It reaches the model as
`[a document nobody has read: "Q3-report.pdf"]` followed by the caption, and both
prompts forbid summarising or guessing at contents from the filename. The caption
feeds `isAwakeFor` like an image caption does, so tagging him alongside a file
works. Unlike the other media types this reads the same asleep or awake — there is
no download to skip.

`mediaId` is stored against the message for a future "read it" feature: exchange
it at `GET /<MEDIA_ID>` for a URL, then download that with the bearer token. Both
calls need auth (unlike image links, which are deliberately unauthenticated so
they can be handed to a model), and the pointer is TTL'd to **about seven days**.

`lastImage` is still recorded when asleep — it costs nothing and keeps
"edit that picture" working if the group tags him right afterwards.

**Group roster updates** arrive in the same webhook and trigger a participant list refresh. **Contact name changes** update stored names. **Poll vote updates** update vote tallies, on whapi only — wa-gateway never sends them (see the poll semantics under Scheduled Tasks). (On whapi these are `groups`, `contacts` and `messages_updates` — the last needs "Messages PATCH" mode enabled; on wa-gateway they are the `group_participants_update`, `contacts` and `message_polls` fields.)

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

**Fortnightly and every-N-weeks** is `days_of_week` plus `interval_weeks` (2 =
every other week) and an `anchor_date` saying which week is week zero. The anchor
is not optional in spirit — "every other Friday" is undefined without it — so a
task with `interval_weeks > 1` and no anchor never fires rather than guessing.

This is deliberately **not** cron. Standard cron cannot express a fortnight: the
day-of-week field repeats every week with no interval or phase. The usual
workaround (`Friday within days 1-7 or 15-21`) drifts at month boundaries, because
months hold four or five weeks. The model here is iCalendar's
`FREQ=WEEKLY;INTERVAL=2;BYDAY=FR` in miniature. Without it the model had no way to
say "every other Friday" and brute-forced **52 one-off tasks**, a year ahead.

Two guards came out of that incident: `MAX_TASKS_PER_GROUP` (20) refuses to let one
conversation carpet a group with schedules, and `listScheduledTasks` caps at 25
rows because its output goes straight into the model's context on any "what's
scheduled?".

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
| `poll` | `{question, options[], allow_multiple}` | Native WhatsApp poll. Registered in `Poll`; votes tally through the webhook on both providers. |
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

**wa-gateway poll semantics** (confirmed against a live send on 2026-08-05):
polls go to the ordinary send endpoint, `POST /<PHONE_NUMBER_ID>/messages`, with
`type: "poll"` and a nested body — there is no separate poll route the way whapi
has one:

```json
{ "messaging_product": "whatsapp", "recipient_type": "group", "to": "…@g.us",
  "type": "poll",
  "poll": { "name": "Birou?", "options": ["Da","Nu"], "selectable_count": 1 } }
```

`selectable_count` is how many answers **one person** may pick: `1` for single
answer, the option count for multi-select. Note this is the plain reading, *not*
whapi's inverted `count: 0` convention — the two gateways disagree, which is why
each provider builds its own body.

This exact body was refused at first with `(#100) "poll" is not a supported
message type here` — a gateway-side bug, fixed on the gateway; the same payload
then went straight through. The text-list fallback is what surfaced that error
verbatim instead of leaving a silently broken poll, which is why it stays.

**Votes are not observable on wa-gateway.** A poll sends and renders, but no
`message_polls` delivery ever arrives, so a tally can't be read back. That is a
capability flag on the provider (`observesPollVotes`), not a special case: when it
is false, `get_poll_results` is withheld from the model's tool list and the group
prompt is told plainly that it cannot see votes. Otherwise Gepetel would answer
"nobody has voted yet" about a poll people had already answered — confidently
wrong, which is worse than not knowing. whapi does report votes, so switching back
restores the tool with no other change.

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

## Group Membership Questions in a 1:1

`list_group_members` answers "who's in the group?" from a private chat. It returns
the members Gepetel actually knows by name, plus a count of how many haven't
spoken yet — so a partial list never reads as the full roster. **Names only; phone
numbers are never returned.**

Access is enforced **in code, not in the prompt**: it goes through the same
`assertGroupAccess` gate as the scheduling tools, which re-queries the database
and throws unless the caller is a stored participant of that exact group. A
non-member gets the same wording as a group that doesn't exist, so the refusal
doesn't confirm the group is real. Because the check is a database predicate
rather than an instruction, no amount of persuasion, injected text or invented
chat id gets a non-member an answer — and access disappears by itself when
someone leaves and the roster refreshes.

---

## What a 1:1 Is For, and the Abuse Gate

A private chat used to refuse everything outside a short list, so someone asking
for a translation got "I only handle group/creator stuff here" — twice — and
replied "slab răspuns". Fair.

Gepetel now helps with small, useful things in a 1:1: translate a phrase, look
something up (`web_search`), read a link (`read_url`), find a venue
(`get_place_info`), settle a quick fact. The same read-only tools the groups
already had.

**Abuse** is defined along four axes, and only the first needs code:

| | Where it's enforced |
|---|---|
| **Volume** — using it as an unlimited free assistant | `claimDmMessage`, in code |
| **Bulk work** — essays, homework, long documents, big code | prompt |
| **Harmful** — illegal, targeting a person, NSFW | prompt |
| **Other people's data** — groups they aren't in | `assertGroupAccess`, in code |

`claimDmMessage` gives each person **40 messages per UTC day** plus a rolling
**12 per 10 minutes**. The daily figure is the budget; the burst window is what
actually stops a script or a pasted wall of tasks, long before the daily cap
would. Counters advance in one atomic pipeline update, so concurrent messages
can't race past the cap, and the limits are deliberately generous — a real
conversation should never meet them.

When someone is over, they're told once an hour at most, with a different line
for "too fast" (back in minutes) than for "done for today". Past that Gepetel
stays silent rather than answering every message with the same refusal — which
would be the same flood, just from our side.

---

## Shared Expenses (the group tab)

A conversational Splitwise. People mention money in passing — *"am fost la cină,
124 lei, Dragoș a plătit și eu am lăsat 20 bacșiș"* — and that becomes a ledger
entry with no form to fill in.

`Expense` holds one entry: `payers[]` (several, because one meal often has more
than one), `shares[]` (who it's split between and by how much), and a `kind` of
`expense` or `settlement`. A repayment is modelled as an expense the payer covers
entirely on the other person's behalf, so one set of arithmetic settles both.

**All amounts are integers in minor units.** Money in floats produces 0.1 + 0.2
problems, and a ledger that doesn't balance to the penny is worse than none.
`splitEvenly` distributes the remainder one unit at a time, so 10.00 between three
is 3.34 / 3.33 / 3.33 and never 9.99.

`computeBalances` nets each person per currency; **currencies never mix** — a RON
tab and a EUR tab are different questions, and nothing converts between them.
`settleUp` then reduces the net positions to the fewest payments, which is what
people actually want ("who pays whom") rather than a matrix of every shared meal.
One consequence worth knowing: netting can send someone to a person they never
transacted with — if Carmen borrows from Bogdan while Bogdan owes Dragoș, Carmen
may be told to pay Dragoș. That is correct, and occasionally surprising.

**Cross-currency reconciliation.** Asked to put a mixed tab into one currency,
`convert_balances` does it immediately, at the current rate, without asking anyone
to confirm. Rates come from `fx.ts` (Frankfurter / ECB reference rates — free, no
key, and checkable by anyone), cached for an hour. ECB publishes on business days,
so a weekend returns Friday's rate; the date comes back with it and is repeated to
the group, because "at Friday's rate" is a materially different claim from "at
today's". If the rate can't be fetched the tool fails loudly rather than converting
at an invented number.

The conversion is **recorded, not merely displayed**: it writes a pair of entries
per currency — one that nets the old book to zero, one that recreates the same
positions in the target — so it becomes part of the history and "how did we get
here?" has an answer. `convertBook` guarantees the converted book still sums to
zero, absorbing the rounding residue into the largest position, since converting
each person separately otherwise leaves a stray unit.

`list_expenses` returns the whole history — expenses, repayments and conversions,
with per-person amounts — capped at 60 and explicit when it truncates, so a partial
list is never presented as complete.

The tool refuses anything that doesn't add up: payments that disagree with the
stated total, explicit shares that miss it, a settlement with the same person on
both sides. Better to ask than to record a number nobody can reconcile later.

---

## Growth Nudge

A DM asking a frequent group member to add Gepetel to their other groups.
Claimed atomically against a single mention in `recordUserMention`, so concurrent
messages can never produce two.

Gates: **3** mentions and **2** days since their first, then up to
**3 nudges per person for life**, each needing a **45-day** cooldown *and*
another 3 mentions since the last. Both conditions matter — the cooldown alone
would re-ask people who have gone quiet, and fresh mentions alone would let a
heavy user be nudged repeatedly in a week.

A follow-up is told it is one, so it reads differently rather than repeating the
first message word for word. Rows written under the older one-shot rule
(`nudgeSent` with no `nudgeCount`) count as having had one nudge, so they get at
most two more rather than starting over.

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
   `<PUBLIC_BASE_URL>/pay.html?groupId=<chatId>&userId=<userChatId>` — the host comes
   from `PUBLIC_BASE_URL` because the site moved with the deployment, and `.html` is
   spelled out because Vercel's `cleanUrls` made the bare `/pay` work and the Pi's
   static host has no equivalent rule.

**After payment — `POST /payment/callback`:**

The payment provider POSTs with `{ groupId, userId, limit, secret }`:

1. `secret` is verified against the `PAYMENT_SECRET` env var (403 on mismatch).
2. `dailyReplyLimit` is updated on the group document.
3. A short announcement is generated in the group's language and sent to the group: *"X extended the daily limit. Now I have Y messages I can send every day."*
4. A confirmation DM is sent to the user who paid.

---

## Admin UI

Protected by HTTP Basic Auth (`CRON_SECRET` as password):

- `GET /groups/` — all known groups, most recently active first: name, member
  count, and **when Gepetel last spoke there** (as an age, with the timestamp and
  his last line underneath), plus a flag when he's no longer a member. Send
  `Accept: application/json` for the same data as JSON. Note `lastMessageAt` is
  when *Gepetel* last spoke, not the group's last message — it's the field the
  reply gate measures silence from.
- `GET /groups/:id` — interaction history for one group. `?since=` narrows the
  window (`30m`, `6h`, `1d`, `2w`, or a bare number of days; `all` for everything),
  with one-click links in the page; `?limit=` raises the 300-row cap to at most
  2000. The `Interaction` TTL of 14 days is the hard ceiling — nothing older is
  kept, whatever window is asked for.
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
- **Effect**: sends the text via the configured gateway, then records it like a system announcement —
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
| `WA_PROVIDER` | Env var | Which gateway to send through: `whapi` (default) or `wa-gateway` |
| `WHAPI_TOKEN` | Secret Manager / `.env` | whapi.cloud channel token. Not set on the Pi — the provider is wa-gateway, and `whapi.ts` only reads this inside its request calls, never at import |
| `WA_GATEWAY_URL` | Env var | wa-gateway base URL (defaults to the coolify host + `/api`) |
| `WA_GATEWAY_TOKEN` | Secret Manager / `.env` | wa-gateway number token; also verifies inbound `X-Wa-Gateway-Token` |
| `WA_GATEWAY_PHONE_NUMBER_ID` | Env var | Path segment on sends; cosmetic (the token routes) |
| `OPENAI_API_KEY` | Secret Manager / `.env` | OpenAI API key |
| `GEPETEL_DATABASE_URL` | Secret Manager / `.env` | MongoDB Atlas connection string |
| `CRON_SECRET` | Secret Manager / `.env` | Auth token for cron endpoints and admin UI. Accepted either as the `X-Cron-Key` header (Cloud Scheduler) or as `key` in the JSON body (the Pi's cron dispatcher, which cannot send headers) |
| `PUBLIC_BASE_URL` | Env var | Where the marketing site and checkout live. Feeds the pay link and the `{{siteurl}}` the prompts hand out. Defaults to `https://gepetel.bogdanripa.com` |
| `PUBLIC_API_KEY` | Secret Manager / `.env` | Auth key for the public `POST /api/send` endpoint |
| `TELEGRAM_BOT_TOKEN` | Secret Manager / `.env` | Operator notifications (optional — skipped when unset) |
| `TELEGRAM_CHAT_ID` | Secret Manager / `.env` | Where those notifications go (optional) |
| `K_SERVICE` | Injected by Cloud Run | When present, skips local `app.listen` |
