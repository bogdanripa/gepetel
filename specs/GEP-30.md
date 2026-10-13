# GEP-30 — Home computer: let Gepetel use the owner's Mac (fetch, sandboxed shell, real Chrome) from a 1:1

> Written against `main` at 76057b2 (2026-10-11).

## Goal
A person pairs their own Mac with Gepetel from their 1:1 chat. From then on, in that 1:1
only, Gepetel can:

1. **Read a web page on the Mac** — compact, query-focused text instead of whole pages.
2. **Run shell commands in a sandbox on the Mac** — a Linux micro-VM that cannot see the
   Mac's files, except one workspace folder.
3. **Do things in the person's real, logged-in Chrome** — as background tasks that report
   back in WhatsApp, ask when they're stuck, and let the person take over from the phone.

Two equal aims: **capability** (home IP, logged-in sessions, a real shell) and **cost**
(luna only ever sees short results; the expensive work runs on the Mac, with no model when a
saved recipe exists and a cheap model loop when one doesn't).

It must ship later as a Mac installer that anyone can pair, so the transport and pairing are
built for that from day one (no tunnels, no port forwarding, no keys on the Mac).

## Background (verified in code)
- MCP tool calls are made by OpenAI's **hosted `mcp` tool**, not by Gepetel
  (`mcpHealth.ts` → `buildMcpContext` builds `{type:"mcp", server_url, headers|authorization,
  require_approval:"never"}`). OpenAI's servers call `server_url` directly, so it must be public
  HTTPS.
- 1:1 connectors already exist: a connector is scoped to a `chat_id`, and `generateReply`
  attaches `mcpContextForGroup(userId)` for the person's own 1:1 (`oai.ts` ~797).
  `assertConnectorChatAccess` keeps a 1:1's connectors usable only by its owner.
- Gepetel does **not** chain `previous_response_id` across turns (sliding 50-message window),
  so the hosted tool re-runs `tools/list` and re-bills the tool definitions **on every reply**
  in a chat with a connector. Tool count and description length are a per-message cost.
- `read_url` (`wa.ts`) fetches server-side with axios + `htmlToText`, with no length budget
  beyond the 500-char window cap for archived messages.
- `sayAndRemember(chatId, text)` sends and archives (so luna sees what was said);
  `wa.sendWhatsAppImage(to, base64|dataUrl|url, caption)` sends images.
- `claimDmMessage` caps a 1:1 at 40 msgs/day + 12 per 10 min. It is claimed on inbound
  messages only.
- Runtime: a single container on the Pi (Coolify, Traefik, cloudflared). One instance, so
  in-memory WebSocket state is fine.

## Architecture

```
You (1:1) ──► Gepetel / luna ──hosted mcp──► https://gepetel.com/device/<cid>/mcp   (Gepetel)
                                                       │  tools/list served by Gepetel, even offline
                                                       │  tools/call forwarded ▼
                                     wss://gepetel.com/device/ws  ◄══ outbound ══  Gepetel Agent (Mac)
                                                       │                              ├─ fetch_url (Readability, BM25)
   ◄── sayAndRemember / sendWhatsAppImage ◄── events ──┘                              ├─ shell → Apple `container` micro-VM
                                                                                      ├─ browse → local loop → Playwright MCP
                                                                                      │            --extension → real Chrome
                                                                                      └─ LLM calls → POST gepetel.com/device/llm
```

Components:

| Part | Where | What |
|---|---|---|
| **Device relay** | `src/device/*.ts` in this repo | Pairing, WebSocket hub, the per-device MCP endpoint, job/event delivery, LLM proxy, takeover pages |
| **Gepetel Agent** | `agent/` in this repo (own `package.json`, `tsconfig`; not in the Docker image) | Node 22 daemon on the Mac. CLI first (`gepetel-agent pair 123456`, `gepetel-agent run`); menu-bar app wraps it in Phase 8 |
| **Chrome bridge** | Phase 4: Microsoft's "Playwright MCP Bridge" extension. Phase 8: our fork in the Web Store | Gives the agent the person's real Chrome profile |
| **Sandbox** | Apple `container` (1.0, Apple silicon, macOS 26) | One Linux micro-VM per paired device; only `~/Gepetel/workspace` mounted |

## Pairing (1:1 only)
1. New DM function tool **`connect_computer`** (DM prompt only, never in groups). It creates
   a 6-digit code (10-minute TTL, single use, sealed like other secrets, max 5 attempts) tied
   to the requester's chat id, taken from the webhook sender as everywhere else. Reply: fixed
   text with the setup page, the code and the one command to run (later: "open the Gepetel app
   and type it").

   **The fixed text assumes nothing is installed, because the first time nothing is.** It
   leads with `{{siteurl}}/computer` — the install steps — and only then the code and the
   command, and it says what to do when the code expires mid-install: do step 1, come back,
   get a fresh one. The order is the whole point. A code lives ten minutes and installing Node
   takes longer than that, so handing over a code first produces a dead code and no next step.

   **And Gepetel offers it, rather than waiting to be asked.** When a request would need a
   computer and none is connected to that chat, the DM prompt has it say so in one line and
   call `connect_computer` — the same way it offers to connect a service. It never pushes, it
   drops the subject if the answer is no, and it never claims a computer is connected when
   none is. (`prompts/dm.txt` §10 and `prompts/dm-computer.txt`, the latter loaded only when a
   device is paired, so nobody pays tokens for rules about a computer they do not have.)
2. Agent: `POST /device/pair {code, device_name, os, arch, agent_version, capabilities[]}` →
   `{device_id, device_token}`. The token is stored in the macOS Keychain (Phase 0–7: a 0600
   file in `~/Library/Application Support/Gepetel/` is acceptable).
3. Gepetel creates a connector row for that 1:1: `auth_kind: "device"`, label "Computer",
   `server_url = https://gepetel.com/device/<connector_id>/mcp`, `headers = {Authorization:
   Bearer <random 32-byte secret>}` (sealed). It sends the fixed text "Your Mac is connected"
   plus one line on what to ask for.
4. Unpairing: the existing `remove_mcp_connector`, or `gepetel-agent unpair`. Either side
   revokes the device token and closes the socket.

Invariants (in code, not the prompt): a device connector can only be attached to the 1:1 of
the person who paired it; `add_mcp_connector` refuses `auth_kind:"device"`; one device per
person for now (pairing again replaces the old one).

## Transport

**WebSocket `wss://gepetel.com/device/ws`** — the agent dials out with `Authorization: Bearer
<device_token>` and reconnects with jittered backoff (1s → 60s). Messages are JSON:

```jsonc
// Gepetel → agent
{ "t": "call",   "id": "c_81", "tool": "fetch_url", "args": {...}, "chat_lang": "ro" }
{ "t": "cancel", "id": "c_81" }
// agent → Gepetel
{ "t": "hello",  "agent_version": "0.1.0", "capabilities": ["fetch","shell","browse"] }
{ "t": "result", "id": "c_81", "ok": true, "content": "..." }             // ≤ budget, see tools
{ "t": "event",  "job": "j_12", "kind": "progress|question|handoff|done|failed",
  "text": "...", "image_b64": "...", "takeover": true }
{ "t": "ping" }  // every 20s both ways; 2 missed = offline
```

**MCP endpoint `https://gepetel.com/device/<cid>/mcp`** (Streamable HTTP, JSON responses):
- Authenticated with the connector's bearer secret (constant-time compare).
- `initialize` / `tools/list` are answered **by Gepetel**, from a static list filtered by the
  device's last `hello` capabilities, so listing works and costs nothing while the Mac is
  asleep.
- `tools/call`: if the device is offline, return a tool error "The computer is offline (last
  seen …)" at once. Otherwise forward over the socket and wait **≤ 20 s**. If there's no
  result by then, **auto-promote to a job**: return `{"job":"j_12","status":"running","note":
  "Will message the result when done."}`. The agent keeps running, and the result arrives as
  a `done` event. One rule for every tool, so nothing has to guess durations, and luna's
  reply never blocks for minutes.

**Event delivery:** the agent writes user-facing text itself, in `chat_lang`. Gepetel sends it
**verbatim** through `sayAndRemember` (images via `sendWhatsAppImage`), prefixed with
`🖥️ ` so the window shows it came from the computer. No luna call happens on delivery, so
it costs zero tokens. These sends do not count against `claimDmMessage`. Events for a job
whose chat was unpaired are dropped.

## Tool surface luna sees (keep it at five)
Descriptions are one or two lines; every word is re-billed on every 1:1 reply. Budgets are
enforced by the agent and re-checked by the relay (hard truncate plus `…[truncated]`).

| Tool | Args | Returns (budget) |
|---|---|---|
| `computer_status` | — | online/offline, last seen, running jobs (≤ 300 chars) |
| `fetch_url` | `url`, `query?`, `max_chars?` (default 3000, max 12000), `render?` (bool: use real Chrome) | Title, then either the query-matched passages or the outline + lead (≤ max_chars) |
| `shell` | `command`, `timeout_s?` (default 60, max 1800) | exit code, stdout/stderr head 1500 + tail 1500 chars, files written to `/workspace` |
| `browse` | `goal`, `start_url?`, `may_submit?` (default false) | Always a job: `{job, status}`. Progress, questions and results come as events |
| `job` | `job_id`, `action` (`status`/`reply`/`cancel`), `text?` | Short status, or "sent" |

DM prompt additions (`prompts/dm.txt`, only when a device connector is attached):
- Prefer `fetch_url` with a `query` over `read_url` when the page is long or the person asks
  something specific about it. Use `render:true` for pages that need their login or JS.
- Use `shell` for computation, data wrangling and API calls (`curl | jq`), not for reading
  pages.
- Use `browse` for anything that needs clicking or a login. Never claim a browse task is done
  before its `done` event.
- When the window holds a 🖥️ question for a job, the person's next message is almost always
  the answer: call `job(reply)`.
- Never mention tool names, job ids or "MCP".

## Local tools on the Mac

### fetch_url
- Plain mode: undici GET (UA of the installed Chrome, 15s, 5 MB cap) → Mozilla Readability →
  markdown (turndown).
- `render:true`: open in a background tab of the agent's Chrome window, wait for network-idle
  (≤ 10s), take `document.documentElement.outerHTML`, then the same pipeline.
- `query` given: split into ~800-char chunks on headings/paragraphs, rank with BM25 (no model),
  return the top chunks in page order until `max_chars`, each with its heading path.
- No query: title, heading outline, then the lead text until `max_chars`.
- No model is involved, so the token saving comes entirely from returning less.

### shell — sandbox
- Backend: **Apple `container`**. Each container is its own lightweight VM (Apache-2.0, open
  source, 1.0 released 2026-06-09, Apple silicon only, best on macOS 26). One long-lived
  container per device: image `gepetel/sandbox` (Debian slim + curl, jq, python3, pip, node,
  git, ripgrep, pandoc). Started on first use, stopped after 15 idle minutes. Packages the
  person installs persist until `shell` is called with a reset (Phase 2 acceptance covers it).
- Mounts: **only** `~/Gepetel/workspace` → `/workspace` (rw). Nothing else from the Mac:
  no home directory, no Keychain, no SSH keys, no Chrome profile.
- Network: on (NAT) by default. That's the point of `curl`. Per-device setting `shell.network:
  on|off`, and the menu-bar app exposes it later. The sandbox has no route to the agent's own
  control port.
- Limits: 2 vCPU, 2 GB RAM, 10 GB disk, `timeout_s` hard-killed, one command at a time per
  device (queue the rest).
- Execution: `container exec <id> bash -lc '<command>'` with a fresh cwd `/workspace`. The
  command is passed as an argv element, never interpolated into a host shell.
- Fallback when `container` is unavailable (Intel Mac or older macOS): Anthropic's
  `@anthropic-ai/sandbox-runtime` (Seatbelt via `sandbox-exec`, Apache-2.0, beta). Use
  `denyRead: ["~"]`, `allowRead/allowWrite: ["~/Gepetel/workspace"]`, `allowedDomains` from
  settings, and never `allowAppleEvents`. It runs macOS binaries rather than Linux, so it's a
  second-class mode, reported by `computer_status`. Phase 2 implements the `Sandbox` interface
  with the `container` backend only; the `srt` backend is Phase 8.

### browse — local agent loop
- The agent spawns `npx @playwright/mcp@<pinned> --extension` as a **local stdio MCP child**
  with `PLAYWRIGHT_MCP_EXTENSION_TOKEN` set. That token skips the per-connection approval and
  the tab picker. The agent's own loop is the only client.
- All work happens in a dedicated Chrome window titled/grouped "Gepetel", which is never
  minimized. The person's other tabs are not touched.
- **Model:** called through `POST https://gepetel.com/device/llm` (device-token auth). Gepetel
  forwards to the OpenAI Responses API with its own key, a model allowlist (default
  `gpt-5.6-luna`, configurable per device), usage logged per device and per job, and a daily
  token cap per device. There's no OpenAI key on the Mac. This is also the future billing hook.
- **Loop (token discipline is the spec, not a nice-to-have):**
  - The context holds the goal, constraints, a short step log (≤ 1 line per step) and **only the
    latest** page state. Older snapshots are dropped, never accumulated.
  - The page state is the cheapest that works:
    (1) a `browser_evaluate` extraction the model asks for (small JSON);
    (2) an accessibility snapshot scoped to the main landmark/form, capped at 6k tokens;
    (3) the full snapshot, capped at 12k;
    (4) a JPEG screenshot only when the model says the snapshot isn't enough.
  - The tools exposed to the model are a subset of Playwright's (navigate, snapshot, click,
    type, select, press_key, wait_for, evaluate, screenshot, tabs) plus three of our own:
    `ask_user(question, options?)`, `handoff(reason)` and `finish(result)`.
  - Caps: 40 steps, 10 minutes, 150k input tokens per job. Hitting one sends a `question`
    event ("I'm stuck at X — continue, take over, or stop?").
- **Guardrails** (enforced in the loop, not the prompt): without `may_submit:true`, any click
  on an element whose accessible name or nearby text matches pay/buy/order/confirm/submit/send/
  delete (multilingual list incl. RO) becomes an `ask_user` instead. Password fields are never
  typed into by the model; when it needs a login it calls `handoff`. Phase 9 replaces that
  with 1Password.
- Each job's final `done` text is ≤ 1500 chars and written for the person, in `chat_lang`.

### Handoff and takeover
- **Level 1 (Phase 5): numbered screenshot.** `handoff`/`ask_user` with no options draws
  numbered boxes over the interactive elements of the current snapshot (an injected overlay,
  removed after capture). It sends a JPEG (q=60, ≤ 1280 px wide) plus the question. The person
  replies `3` or `3 Bogdan`, luna passes it via `job(reply)` and the loop maps the number to
  the element ref. The person's turn costs no model tokens in the loop.
- **Level 2 (Phase 6): live takeover link.** The event carries `takeover:true`. Gepetel mints a
  one-time URL `https://gepetel.com/t/<token>` (TTL 15 min, bound to job and chat) and sends it
  with the question.
  - The page streams the tab via CDP `Page.startScreencast` (through the extension's debugger
    session; JPEG frames over the existing WebSocket, relayed by Gepetel).
  - Taps map to `Input.dispatchMouseEvent`, typing goes through a hidden input to
    `Input.insertText`, and scroll and back are supported. Pinch-zoom is allowed, with an
    optional "mobile layout" toggle via `Emulation.setDeviceMetricsOverride`.
  - A big **Done** button ends it. The token is burned, the loop resumes with a fresh snapshot
    and a step-log line "person took over for 2m".
  - While the link is open the loop is paused.

## Security invariants (tests required)
- Device connectors exist only in their owner's 1:1. Every relay entry point re-checks
  `device.chat_id === connector.chat_id`.
- The device token, connector secret, pairing codes and takeover tokens are sealed at rest
  (`secrets.ts`), compared in constant time, and never logged. Logs carry ids and sizes only.
- The sandbox has no Mac paths but the workspace, and the browser loop cannot call `shell`
  (and vice versa). Web content can't jump between them.
- Everything a tool returns is untrusted text. Tool results are never interpolated into
  instructions; they stay tool outputs.
- `browse` never submits payments or irreversible forms without `may_submit:true`, and even
  then the first submit of each job asks. (Revisit once the person has used it.)

## Cost & telemetry (acceptance for the whole spec)
- Per 1:1 reply with the device connector attached, the extra input from tool definitions is
  **≤ 700 tokens** (measure: same message with and without the connector, `usage.input_tokens`).
- `fetch_url` with `query` returns ≤ 3,000 chars by default. On a 50 KB article, luna input is
  at least 5× smaller than via `read_url`. Log both for the first 50 calls.
- Each `browse` job logs model calls, input/output tokens, steps, and recipe hit/miss into a
  `device_jobs` collection. The admin UI (`/groups/:id` sibling, `/devices`) shows per-device
  daily totals.

## Phases
Every phase ends with an end-to-end test from a real WhatsApp 1:1 and is shippable on its own.

### Phase 0 — Pair and ping (thinnest possible slice)
- Relay: `connect_computer` tool, `/device/pair`, `/device/ws`, `/device/<cid>/mcp` with
  `computer_status` only, the auto-promote-to-job plumbing (stubbed), and the offline answer.
- Agent: `gepetel-agent pair <code>` and `gepetel-agent run` (foreground, logs to stdout),
  answering `computer_status` with hostname, uptime and agent version.
- **E2E:**
  1. "connect my computer" → code.
  2. Pair from the terminal → "connected" arrives.
  3. "is my computer on?" → online plus hostname.
  4. Stop the agent → "is my computer on?" → offline, last seen.
- **Accept:** pairing codes expire and are single-use; a wrong code fails 5 times then locks;
  the connector can't be added to a group; unit tests for token sealing, compare and pairing.

### Phase 1 — fetch_url  ✅ shipped 2026-10-12
- The plain mode plus `query` ranking. `render` is not in this phase.
- **E2E:** "what does <long article URL> say about X?" → answer grounded in returned passages;
  logs show the char counts vs `read_url`.
- **Accept:** cost criterion for `fetch_url` met; non-HTML (PDF) → "can't read this type yet"
  rather than garbage; 15s timeout respected.

**As built** (`agent/src/fetchUrl.ts`, `tests/fetchUrl.test.mjs` in the agent, the relay half
in `src/device/mcp.ts`):
- Node's own fetch (which *is* undici) rather than the package, so the agent keeps one
  dependency fewer; 15s deadline across all hops, 5 MB body cap, the installed Chrome's UA
  read from its `Info.plist`.
- **Redirects are followed by hand**, because `fetch` follows them itself and that would make
  the address guard decorative: a public URL that 302s to `192.168.1.1` would be fetched with
  nothing checking the second address. Each hop is guarded, five at most.
- **The destination guard is the security story of this phase.** The Mac sits inside someone's
  home network, and a page can ask the model to fetch another URL — so private ranges,
  loopback, link-local (including the cloud metadata address), `.local`/`.lan`, `file:` and
  credentials-in-URL are all refused, and a hostname is **resolved** before it is judged,
  since `router.example.com` can point at 192.168.1.1. Residual gap, written down rather than
  papered over: a name that changes its answer between the check and the connection still
  gets through; closing it needs a pinned-IP dispatcher, which belongs with Phase 4's browser.
- Readability + turndown, with **link targets dropped** (anchor text kept). Measured on the
  English Wikipedia article for Raspberry Pi, one linked phrase costs ~90 characters as
  markdown and two words of it are content — so roughly half the budget was going on URLs the
  model cannot use without another fetch. That one rule halved the extracted page (190 KB →
  93 KB) before ranking even started.
- BM25 over ~800-char chunks split on headings, each labelled with its heading path, hand-
  written (no dependency, no model). **Diacritics folded both ways**, so "manastirea" finds
  "mănăstirea" — which is how the question actually arrives in this chat.
- Nothing matched → the outline and the opening, saying so. Not an article at all (Hacker
  News, a dashboard) → the body's own text, which the ranking treats identically.
- **Measured:** 43× smaller than the page on the Raspberry Pi article (2,144 chars from
  92,785), and the passage returned answered the question asked. Both numbers are logged per
  call, on the agent and again on the relay.
- The budget is enforced **twice** — once by the agent, once by the relay (`capped`, hard
  12,000) — because the agent is software on someone else's machine that updates on its own
  schedule, and what it returns is billed to that chat on every reply for as long as it stays
  in the window.

**What the first real question taught us** (2026-10-12, "ce număr de telefon e listat pe
allweddings.ro/…/cofetaria-christine?"). Gepetel answered "no phone number is listed". The
page lists `0721 209 514` — five times. Three separate faults, all now fixed and tested:

1. **The model used `read_url`, not the computer.** Both were on the menu and it reached for
   the familiar one; the prompt's "prefer the computer" line did not win. Two readers for one
   job do not produce the better choice, so `read_url` is now **removed from the DM tool list
   while the Mac is online and reports `fetch`** (`dmHelperTools`). One tool, no preference to
   get wrong, one fewer definition billed per reply — and it comes straight back when the Mac
   sleeps or runs an agent too old to fetch.
2. **The number is not in the page's text at all.** It is in schema.org JSON-LD
   (`"telephone": ["0721 209 514"]`), in the JSON island the page hydrates from, and in a
   `wa.me` link behind an icon. `read_url`'s whole extraction came to 2,354 characters and
   contained none of it; Readability's came to 1,099 and contained none of it. So the agent now
   **harvests what a page states about itself** — phone, email, address, city, hours, price
   range — from every `ld+json` and `application/json` block plus `tel:`/`mailto:`/`wa.me`
   links, validates each value against its own shape (`"telephone": "n/a"` is not a number),
   de-duplicates on digits, and puts it in a ≤400-char block above the passages,
   unconditionally. These are the three things people ask a page for, and a modern page very
   often does not write them down. This is *not* deferred to Phase 4's browser: the data is in
   the HTML, in a standard format, and parsing it costs nothing.
3. **A question was only ranked over Readability's article.** Readability keeps prose and bins
   what it judges furniture — which on a listing page is the sidebar holding the address and
   the hours. A query is now ranked over the **whole body** (the no-query lead still comes from
   the article, which reads better). Two bugs came out of that change and both were caught by
   a test rather than by a user: Readability **mutates the document it is handed**, so reading
   the body afterwards returned the wreckage (93,000 chars → 4,244 on the Wikipedia article,
   and questions that had been answered stopped matching); and a `MIN_MAX_CHARS` floor inside
   `compose` silently overrode a smaller `max_chars` (600 requested, 722 returned).

Measured after the fix, same page: `Phone: 0721 209 514`, the email and the street address all
come back, inside the budget. Raspberry Pi is still 74× smaller than the page with the RAM
passage in it, and Snagov still answers "cât de adânc" with `adâncimea maximă de 9 m`.

### Phase 2 — Sandboxed shell  ✅ shipped 2026-10-12
- The `Sandbox` interface with the Apple `container` backend, image build script in
  `agent/sandbox/`, workspace mount, idle stop, queueing, output budget.
- **E2E:**
  1. "how many days until Christmas, use the computer" → runs `python3 -c ...`.
  2. "download the ECB EUR/RON rates for the last 30 days and give me min/max" → `curl | jq`.
  3. A 3-minute command → immediate "running", then a 🖥️ result message.
- **Accept:**
  - `ls /Users` inside the sandbox fails or shows nothing of the Mac's.
  - `cat ~/.ssh/id_*` is impossible.
  - A file written to `/workspace/x.txt` appears in `~/Gepetel/workspace`.
  - Timeout kills the process; the `container` CLI missing → clear `computer_status` message.

> **Backend changed the same day it shipped.** Phase 2 was built on Apple's `container` and
> then rebuilt on macOS's own Seatbelt sandbox (`@anthropic-ai/sandbox-runtime`), because the
> product decision landed that **the installer must have no dependencies**: `container` is a
> separate signed .pkg, needs an admin password, and only runs on Apple silicon with macOS 26.
> The `srt` backend was always in this spec as the fallback for exactly those Macs (see *shell
> — sandbox* above); it is now the only backend, and the `container` one is gone rather than
> kept as a second code path nobody exercises. What that costs: no VM boundary, no `apt`, and
> no persistent machine — what persists is the workspace, which is where everything installs.

**As built** (`agent/src/sandbox.ts`, `agent/tests/sandbox.test.mjs`,
relay half in `src/device/mcp.ts` and `src/device/hub.ts`):
- `container exec` is the **only** subcommand on the happy path. The bring-up ladder is
  exec → `start` → `run`, so nothing depends on `inspect` or `list`, whose names and output
  could not be verified from the Linux box this was written on. "No such container" is told
  apart from "the command exited 1" by stderr matching plus an empty stdout — checked, not
  assumed, because getting it wrong means every failing command silently runs twice.
- The command reaches bash as a **positional parameter** (`bash -lc 'timeout -s KILL N bash -c
  "$1"' gepetel-shell <command>`), so quoting in it is inert. One test exists purely to assert
  it arrives as exactly one argv element.
- `timeout` runs **inside** the container: killing the exec client on the Mac would leave the
  process running in the VM. The client keeps a 10s-longer deadline as a backstop.
- Stopped when idle, never removed — `--rm` would delete everything the person installed.
  `reset: true` on a `shell` call is the explicit clean slate.
- `shell` is advertised only when the agent reports the capability, re-probed **on every
  connect** (install the runtime, restart nothing, the next reconnect picks it up). A Mac
  without it reports why through `computer_status`, in words the person can act on.
- **Brought forward from Phase 3, deliberately:** `deliverEvent` in the hub puts a `done` /
  `failed` event into the chat verbatim behind a 🖥️, and the agent emits one for any call that
  outlived the relay's 20s promotion (it sends the result too; the relay ignores a result for a
  call it already promoted, and guessing which side of the line we landed on would lose the
  answer whenever the guess was wrong). Without this, the answer to anything slower than twenty
  seconds existed only in the agent's log. Still owed by Phase 3: `device_jobs`, the `job`
  tool, `progress`/`question` events, and an outbox that survives a reconnect.
- **`gepetel-agent selftest`** runs this phase's acceptance list on the Mac, because that is
  the only machine that can answer it: `ls /Users`, `cat ~/.ssh/id_*`, the workspace round
  trip, the kill, the output clip, package persistence, the network setting, and a reset. The
  unit tests cover argv, queue, timeout, budget, ladder and idle stop against a fake
  `container` CLI that is a real program, spawned the real way — 53 agent tests in all.
- One real bug the tests caught: `Number(x) || DEFAULT` is not a clamp. A negative `timeout_s`
  is truthy, so `-5` became one second and every command came back "killed after 1s", which
  reads as a broken sandbox rather than as a bad argument.
- Open question 1 answered for now: network **on** by default (the point of having curl), with
  `shell_network: false` in `agent.json` as the per-device off switch until the menu-bar app
  exposes it.

### Phase 3 — Jobs, events, reply routing (generic)  ✅ built 2026-10-12
- `job` tool (status/reply/cancel), `device_jobs` collection, event delivery via
  `sayAndRemember`/`sendWhatsAppImage`, the 🖥️ prefix, DM-limit exemption for deliveries, and
  the DM prompt rules for answering questions.
- Exercised with a test-only agent tool `ask_demo` that asks a question and echoes the answer.
- **E2E:** start `ask_demo` → 🖥️ question → reply in plain words → the job receives it and
  finishes. "cancel that" cancels a long shell job.
- **Accept:** the agent reconnecting mid-job doesn't lose events (agent-side outbox with ack);
  events for unpaired chats are dropped; no luna call on delivery (verify in logs).

**As built** (`src/device/jobs.ts`, `src/device/hub.ts`, `agent/src/outbox.ts`, `tests/device-jobs.e2e.mjs`):
- `device_jobs` rows are written when a call is promoted (20s) or the moment the agent asks
  a question — the question ends the wait so the model's turn can finish and the question
  can be asked. Ids are random (they were a process counter, which restarts).
- `job` (status/reply/cancel); status answers from the row, so it works while the Mac sleeps.
  Cancel reaches the sandbox, which kills the command's process group. Events for a
  cancelled job are recorded, not delivered.
- The outbox: events are written to disk before sending, acked by the relay after the row is
  written, resent on every connect; the relay remembers event ids per job, so a resend is
  delivered once. The relay also tells the agent when it promotes a call (`{t:"promoted"}`),
  so a job that finishes inside 20s still answers as an event.
- Beyond the spec, from "a research job that takes two hours": `timeout_s` up to 4h; commands
  over 5 minutes run in their own lane so quick ones never queue behind them; a command
  prints `::progress:: …` and `job status` shows the latest (at most one event a minute,
  never sent to the chat).
- The e2e drives the REAL agent process against the real relay (Mongo and WhatsApp stubbed):
  question → reply → result, cancel killing a real command, a result surviving a forced
  disconnect delivered exactly once with the outbox empty after, progress. Not yet exercised:
  the Mongo-side dedupe for real, and any of it through WhatsApp.

### Phase 4 — browse, read-only  ✅ built 2026-10-12
- LLM proxy (`/device/llm`) with allowlist, usage logging and daily cap.
- Playwright MCP child in extension mode; the dedicated window; the loop with token discipline
  and caps; `finish`. No `ask_user` or handoff yet. `may_submit` is forced false and clicks are
  allowed only for navigation (links, tabs, pagination).
- Add `render:true` to `fetch_url` (same Chrome plumbing).
- **E2E:** "check how much my last Enel/Digi bill is" (a site where he's logged in) → job →
  🖥️ amount and due date. "what's on my GitHub notifications page?" via `fetch_url render:true`.
- **Accept:** median job ≤ 25k input tokens on those two tasks; never more than one snapshot in
  context (unit test on the context builder); caps produce a 🖥️ message, not silence.

**As built** (`agent/src/browse.ts`, `agent/src/mcpClient.ts`, `src/device/llm.ts`,
`mac/Sources/Gepetel/ChromeSetup.swift`) — checked against the real `@playwright/mcp` 0.0.83
and the extension's source, which differ from this spec in useful ways:
- The extension ("Playwright Extension", id `mmlmfjhmonkocbjadbfplnigmagldckm`) gives each
  client its own named tab group: the dedicated "Gepetel" window is built in. Its token is on
  its status page behind a Copy button; the app's **Connect Chrome…** checks Chrome, opens the
  Web Store and notices the install itself, opens the status page, takes one paste, and picks
  the Chrome profile that has the extension.
- **Not given to the model:** `browser_evaluate` (JavaScript in a logged-in page can send
  requests with its cookies — read-only would be a fiction) and `browser_run_code_unsafe`.
  The cheap extraction the spec planned with evaluate is `browser_find` + the snapshot's main
  region instead.
- Read-only in code: links, tabs and pagination buttons only; action words refused even on
  links (EN/RO); `javascript:` links refused; navigation through fetch_url's address guard.
- `/device/llm`: model allowlist, function tools only (no hosted tools), named fields only,
  input/output caps, a daily per-device token budget, usage per device and per job.
- Six tools, not five — agreed: the token budget, not the count, is what each reply pays.
- Tests: a real headless throwaway Chrome against fixture pages ("Pay now" refused, the next
  page followed, answered, one page in context), and the full system with the real agent and
  the real `/device/llm` route. Not yet run: the person's own Chrome via the extension, real
  luna, and the spec's two E2E tasks (Enel/Digi bill, GitHub notifications) — those need the
  0.6.0 app on a Mac with the extension.

### Phase 5 — browse, interactive + Level 1 handoff  ✅ built 2026-10-12
- Typing, selecting, `ask_user`, `handoff` with the numbered screenshot, the submit guardrail,
  and `may_submit`.
- **E2E:**
  1. "book the 19:00 slot at <restaurant site>" → asks which of 3 slots via numbers → stops
     before confirm and asks → "yes" → done.
  2. A login wall → handoff screenshot → he logs in on the Mac → "done" → continues.
- **Accept:** a guardrail test page with "Pay now" is never clicked without a yes; numbers map
  to the right elements on 3 fixture pages.

**As built** (`agent/src/browse.ts`; tests in `agent/tests/browse.test.mjs`):
- Typing, dropdowns, keys (Enter/Escape/Tab/arrows/page), `ask_user` (with options → the
  reply number maps to the option; without → a numbered screenshot), `handoff`.
- **Actions ask first, in code:** a click whose name reads as pay/buy/order/book/confirm/
  submit/send/delete/save/post… (EN and RO), `type` with submit, and Enter outside a search
  box all become a 🖥️ "I'm about to press X on site — go ahead?". Without `may_submit` every
  such action asks; with it the first does and its yes covers the job. No yes → not done, and
  the model is told not to try another way.
- **Never typed:** password fields by their real type (read by an agent-written check through
  `browser_evaluate` — the model never gets evaluate), autocomplete `cc-*`/passwords/one-time
  codes, and names like password/PIN/CVV/IBAN. A login is a handoff.
- **Numbered screenshot:** the boxed snapshot (`boxes:true`) gives each element's viewport
  box; one agent-written overlay script — numbers and coordinates only, nothing from the page —
  draws labels and returns which it drew; screenshot; overlay removed. "3" or "3 Bogdan" is
  mapped back to the element by the loop, with no model call. The picture goes to WhatsApp
  first, then the question as a normal archived message.
- Caps end in a question ("carry on, or stop?"), at most twice (+20 steps, +10 min, +75k
  tokens each); time spent waiting for the person doesn't count against the clock.
- **A bug found here that Phase 4 shipped with:** element refs are frame-prefixed after a
  navigation (`f1e3`), and the parser only read `e\d+` — so nothing on a second page could
  be clicked. Fixed in 0.7.0; 0.6.0 has it.
- Accept, run against real headless Chrome: the numbers sit on the elements they map to on 3
  fixture pages (checked by the page's own hit test under each label); a booking's "Confirm
  booking" is never sent on "no" and is on "yes"; a password field labelled "Code" is refused
  and the job hands over with a picture. The spec's real-site E2Es (a restaurant, a real
  login wall) need a person and are still to run.

**Decision, 2026-10-12 — the browser is fully open to the model (the owner's call).** On top
of the above, the loop's model can run JavaScript in the page (`run_js`, Playwright's
`browser_evaluate`), read the network log including request/response headers and bodies, and
read cookies, localStorage and sessionStorage **with their values**. Offered first was a
guarded version (scripts confined to the hosts the page already used, credential headers
blanked, cookie and storage values kept from the model); the owner chose open, for speed and
for learning sites' APIs. What that accepts, written down so it stays a decision and not a
surprise: a page the model reads can try to steer it into sending the person's session cookies
or data elsewhere, or into acting through a script where the click guard can't see; cookie and
storage values travel to the model provider and can end up in a chat reply. Still not offered,
as accident protection rather than security: clearing all cookies/storage, and rewriting or
cutting the page's traffic (`browser_route`, `browser_network_state_set`). The click guard and
"never type a password" stay. A job that ran a script is not saved as a recipe.

### Phase 6 — Live takeover link  ✅ built 2026-10-12
- `/t/<token>` page, screencast relay, input mapping, the Done flow, token burn/TTL.
- **E2E:** from the phone on 4G, solve a captcha / complete a 2FA prompt in the real Chrome via
  the link, tap Done, and the job completes.
- **Accept:** the link is single-use and works only for that job; ~5 fps at ≤ 150 KB/s; taps
  land within ±4 CSS px on a fixture page at 3 zoom levels; closing the page without Done
  times out to a 🖥️ question.

**As built** (`src/device/takeover.ts`, `agent/src/takeover.ts`) — measured before it was
designed, on this Mac with `@playwright/mcp` 0.0.83:
- **Not a CDP screencast.** Playwright MCP holds the debugger session; `browser_run_code_unsafe`
  costs ~500 ms per call and keeps nothing between calls, so a screencast can't be kept alive.
  `browser_take_screenshot` answers in ~30 ms but returns ~290 KB. So: a screenshot every
  250 ms, sent only when it changed, shrunk by macOS's own `sips` (720 px, quality 35 — ~64 KB
  for a page of dense text, ~15 ms), under a 150 KB/s byte budget. Typically 2–4 fps while the
  screen moves, nothing while it doesn't.
- **Input:** taps with `browser_mouse_click_xy` (MCP started with `--caps=vision`; the model is
  never given those tools) — exact, ~1 s; text through one fixed script with the text as JSON
  data; keys from a fixed list; wheel; back. The relay checks every input's shape first.
- **The link:** 32 random bytes, stored hashed, one job on one device, 15 minutes; dies on
  Done, on the job ending or being cancelled, on expiry, or when a newer link replaces it. One
  viewer at a time. The page is fully inline under `default-src 'none'`, no referrer, no cache.
  Done answers the handoff as "done" in the chat would; an expiry without Done asks in the chat.
- Accept, run end to end (real agent, headless Chrome, relay): the link arrives with the
  handoff; frames flow; a second viewer is refused; taps land within ±4 CSS px with the frame
  shown at 360, 720 and 1280 px wide (0 px off); frames under 150 KB/s; Done resumes the job
  and the step log says "took over for Nm"; afterwards the page is 410 and the socket refused.
  Not run: from a real phone on 4G, on a real captcha.

### Phase 7 — Recipes (zero-token replays)  ✅ built 2026-10-12
- On a successful job, the loop can save a **recipe**: a parameterized step list
  (`goto`, `click by role+name`, `fill {param}`, `extract js`) stored in
  `~/Gepetel/recipes/*.json` and indexed in Mongo by intent and site.
- `browse` first asks the cheap gatekeeper model (`gpt-5-nano`, ~200 tokens) whether a recipe
  matches the goal. A match replays it with no model in the loop. A failing step falls back
  to the model loop from that point, which then repairs and re-saves the recipe.
- **E2E:** run "check my Enel bill" twice; the second run makes ≤ 1 nano call and 0 luna calls.
- **Accept:** recipes never store secrets or typed passwords; a broken selector falls back
  cleanly.

**As built** (`agent/src/recipes.ts`, wired into `agent/src/browse.ts`):
- Steps are recorded by role and name (never refs, which change per page); typed text that
  appears in the goal becomes a parameter. At `finish` the model gives `intent` and `facts`
  (each value as the page writes it); the loop pins each fact to the nearest label before it
  on the final page and turns the answer into a template. A fact it can't pin → no recipe.
- Next time one `gpt-5-nano` call picks a recipe and fills its parameters (a pick missing a
  parameter is no pick). The steps replay with no model — still through the same guards (action
  clicks ask, addresses guarded) — and the answer is the template with today's values.
- A step that can't find its element, or facts not where they were, hands over to the model
  loop from that point with a note; a success re-saves the recipe (same id, `repaired+1`).
- **Not saved:** jobs that asked the person anything, handed over, took a "no", or went back.
  Credential-like query parameters are cut from every address. Nothing typed into a secret
  field exists to record.
- **Deviation:** stored on the Mac only, in the agent's own folder (Application Support) — not
  in the workspace (the sandboxed shell can write that), and not indexed in Mongo: a recipe
  names the person's bank and utilities, and matching runs on the Mac anyway.
- Accept, real headless Chrome, a fixture "Enel" site whose numbers change between runs: 1st
  run luna 2 / nano 0, saved; 2nd luna 0 / nano 1 with today's values; the link renamed →
  replay stops at that step, luna finishes, recipe repaired; next run luna 0 / nano 1; no
  token from the start address in any recipe file; a job that asked the person, not saved.
  Not run: a real site, real luna/nano.

### Phase 8 — Installer and other people
- Swift menu-bar app wrapping the agent:
  - Bundles Node and the agent; launch at login (`SMAppService`); status menu (online/busy/
    waiting); pairing-code entry box; workspace and network settings; "keep awake while a job
    runs" (IOPM assertion).
  - Developer ID signed and notarized `.dmg`, Sparkle auto-updates.
- Our fork of the Chrome extension in the Web Store. The token is handed over via Chrome
  native messaging, so nobody copies it.
- The `srt` sandbox backend for non-`container` Macs.
- **Keychain (done 2026-10-12, app 0.10.0):** the device and Chrome tokens are Keychain items
  created by the signed app, so macOS gives them only to it — another process (the sandbox
  included) gets a prompt, not the token. The agent never reads the Keychain: the app passes the
  tokens as the first line on the agent's stdin (`GEPETEL_SECRETS=stdin`; never argv or env),
  and pairing hands the new token back up as one `@secret` line the app stores and strips.
  Tokens still in `agent.json` move at first launch, each read back before it leaves the file.
  Development builds use their own service and never migrate (they share `agent.json`). The
  command-line agent without the app keeps the 0600 file.
- The website page `/computer` — a first version shipped with Phase 1, because the setup
  message has to link somewhere; Phase 8 replaces its contents with the app's download.
- **Accept:** a fresh Mac with no developer tools goes from download to "is my computer on?"
  in under 5 minutes, with the only clicks being install, Add to Chrome and typing the code.

**Brought forward, 2026-10-12 — the app, before the browser.** Two decisions: end users never
open a terminal, and the installer has no dependencies. So the app ships ahead of Phases 3–7.
As built (`mac/`, `.github/workflows/mac.yml`):
- SwiftPM, not an Xcode project. It builds with Command Line Tools alone, locally or on a
  GitHub macOS runner. The app is a supervisor and a menu for the unchanged agent. Universal
  Node 24 LTS (checksums pinned in `mac/scripts/build.sh`) and the agent's production
  dependencies ship inside it. The .dmg is about 100 MB with LZMA compression; the universal Node
  binary accounts for 235 MB of the 307 MB app.
- **Auto-update without asking**, in place of Sparkle. Sparkle is built around consent, and
  its silent mode installs on quit, which a menu-bar app rarely does. The app checks the
  highest `mac-v*` GitHub release every six hours. It installs only a build signed by the
  **same Team ID** as itself that passes Gatekeeper (notarized), waits until no job is
  running, then swaps and relaunches. A tag push is a release to every Mac.
- The token stays in the 0600 `agent.json` and has not moved to the Keychain yet. Still owed
  from this phase: Keychain, the Chrome-extension fork, the "five minutes on a fresh Mac"
  acceptance run.
- Found by running it on the Mac, and fixed: Node's `fetch` in the sandbox had no network
  (`NODE_USE_ENV_PROXY`); `gepetel-agent unpair` never revoked anything (now `POST
  /device/unpair`); a Mac without developer tools would have had Apple's "install the
  developer tools?" dialog triggered by the tool probe (stand-ins now shadow the stubs).

### Phase 9 — Passwords and two-factor sign-in (to discuss with the owner first)
Today every sign-in is the person's: the job hands it over (on the Mac, or from the phone
through the takeover link) and never types a password or a code. Asked for on 2026-10-12:
discuss how far that should go before building anything.
- **Found 2026-10-12, in the owner's own Chrome:** on any page with a password field, Chrome
  took the tab from our extension (a local test page with a password field lost it within
  4 s; a plain page kept it). Chrome lets no extension debug a page another extension is
  active on, and the owner's password manager is active on sign-in pages. So a sign-in page
  can't be seen or streamed to the phone at all; the job asks the person to do that step on
  the Mac (0.11.6). That shapes every option below.
  The manager was **iCloud Passwords** (its suggestion menu is a frame; the extension's own
  log read "Cannot access a chrome-extension:// URL of different extension"). Since 0.11.8
  our extension takes other extensions' frames out of the tabs Gepetel is driving, so
  sign-in pages stay visible and the phone takeover works on them; the person's own tabs
  keep their password manager. The flip side: inside Gepetel's tabs, while a job runs, the
  person's password manager can't offer its menu. Autofill by their manager *and* Gepetel
  seeing the page don't go together today; any password option below has to live with that.
- **To decide:** whether the job may use the person's password manager (e.g. 1Password's
  agentic autofill, where the password goes from the vault to the page without the model
  ever seeing it), or only ever ask; how two-factor codes are done (the person types them;
  a code read from the Mac's Messages or the chat; a passkey on the Mac, which needs the
  person anyway); whether staying signed in, so the job rarely meets a sign-in page, is the
  better answer; what a job may do once signed in without asking again.
- **Never, whatever is decided:** a password, card number or one-time code in the model's
  context, the chat history, the logs or a recipe.

### Phase 10 — Captchas solved by a service (to discuss with the owner first)
Today a captcha is the person's: the job hands it over, and since 0.12.0 they can tap, type and
drag (a slider check, as OLX showed before its Google sign-in) from the phone, replayed on the
Mac as a real mouse. Asked for on 2026-10-13: look at extensions that solve captchas.
- **Researched 2026-10-13 (read only):**
  - **NopeCHA:** most capable as an "install and forget" extension; probably the one the owner
    heard of. reCAPTCHA, hCaptcha, Turnstile, FunCaptcha, AWS WAF and more. It solves on its
    servers, and its current builds are closed source. Free tier 100 solves a day, plans
    $5–100 a month.
  - **CapSolver and 2Captcha:** pay per solve, an API key, through an extension or an API.
    2Captcha also uses paid human workers; it is open source (MIT).
  - **Buster:** reCAPTCHA audio only, free, meant for a person to click.
  - **Sliders:** none of them reliably does slider checks like OLX's (likely DataDome, which
    also scores behaviour and the device).
- **Against installing one in the owner's Chrome:**
  - Each sends the page address and the challenge (sometimes cookies) to a third party.
  - Each needs every page of the profile Gepetel's sign-ins live in.
  - Automated solving usually breaks the sites' terms: the owner's real accounts risk being
    flagged or banned.
  - Not yet checked: whether one would take the tab from Gepetel the way password managers do
    (the reports say they inject buttons and scripts, not frames).
- **If we do it:**
  - Opt-in, per site, from an allowlist.
  - Called from our own agent through a solver's API (the token put into the page), not a
    third-party extension with access to every page.
  - The phone hand-off stays the default and the fallback.

### Phase 11 — Later (separate specs)
1Password agentic autofill for logins (replacing handoff-for-login), virtual-card payments
with per-job limits, macOS app control beyond Chrome, multiple devices per person, group use
of a device (explicitly not allowed until then).

## Out of scope
Windows/Linux agents; using a device from a group; giving the browser loop the person's
passwords or cards (Phase 9); running models locally on the Mac.

## Open questions (decide before the phase that needs them)
1. Phase 2: default `shell.network` on or off for other people's installs (on for Bogdan)?
2. Phase 4: is luna the right loop model, or is a cheaper one good enough on real sites?
   Measure both on the Phase 4 tasks.
3. Phase 8: free for everyone, or behind the paid extended-limits add-on (the LLM proxy already
   meters per device)?
