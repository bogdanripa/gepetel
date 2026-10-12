# Gepetel Agent

Runs on your own Mac and lets Gepetel use it — from your 1:1 chat with him, and
nowhere else.

It dials **out** to Gepetel and holds one WebSocket open. Nothing listens on your
machine, no port is forwarded, no tunnel is involved. The only credential stored
here is a device token this machine was handed when you typed a six-digit code
into your own chat.

## What it answers

| Tool | What it does |
|---|---|
| `computer_status` | Whether the Mac is reachable, and what it can currently do. |
| `fetch_url` | Reads a page **here** and sends back only the passages matching the question — the title plus ~3,000 characters, not the page. |
| `shell` | Runs a command in a Linux sandbox on this Mac. It can see **one** path of yours: `~/Gepetel/workspace`. |

`fetch_url` is where the Mac earns its place. Gepetel's server can already fetch
a URL (`read_url`), and it sends the whole page's text into the model, so a 50 KB
article is a 50 KB prompt. Here the page is fetched on your connection, parsed
(Readability → markdown, link targets dropped), split into ~800-character
passages labelled with their heading path, and ranked against the question with
BM25 — no model involved in the choosing, so the saving is real rather than
moved. Measured on the English Wikipedia article for the Raspberry Pi: 2,144
characters returned from a 93,000-character page, and the passage returned
answered the question asked.

Two limits are deliberate and tested. It will not open an address inside your
network — private ranges, loopback, link-local, `.local`, `file:` — and it
re-checks **every redirect hop**, since a public URL that bounces to
`192.168.1.1` is otherwise a way into your router. And it gives up after 15
seconds, so a slow site never holds a WhatsApp reply open.

`shell` is the one with teeth. The thing asking for commands is a language
model reading text off the public internet, so "run this" must never mean "run
this on your Mac". It runs in Apple's **`container`** — each container its own
lightweight VM, not a namespace — with exactly one path mounted in:
`~/Gepetel/workspace`. No home directory, no Keychain, no SSH keys, no browser
profile. 2 vCPU, 2 GB RAM, one command at a time, killed at `timeout_s`
(default 60s) **from inside the sandbox**, because killing the client on the Mac
would leave the process running in the VM. The command is handed to bash as a
positional parameter, so no amount of quoting in it can reach the host.

It needs setting up once, and the agent reports it as unavailable with the
reason until you do:

```bash
agent/sandbox/build.sh        # needs Apple's `container` (apple-silicon Mac)
gepetel-agent selftest        # proves the sandbox is a sandbox, on YOUR machine
```

`selftest` is not decoration. A test suite on Linux can prove the argv, the
queue, the timeout and the output budget; only your Mac can prove that
`ls /Users` shows nothing of yours and that your SSH keys are out of reach.
Those are the spec's acceptance criteria and that command runs them.

Next, per `specs/GEP-30.md`: your own logged-in Chrome (Phases 4–6).

## Use

```bash
cd agent && npm install && npm run build && npm link   # gives you `gepetel-agent`

# In WhatsApp: "connect my computer" → Gepetel sends a 6-digit code
gepetel-agent pair 123456

gepetel-agent run          # keep it running; reconnects on its own
gepetel-agent selftest     # check the sandbox really is one
gepetel-agent unpair       # forget the token locally
```

Without `npm link`, use `node dist/index.js <command>` instead.

`gepetel-agent run` lives as long as its terminal. To have it start at login and
restart itself, there is a copy-paste LaunchAgent at
[gepetel.com/computer](https://gepetel.com/computer).

`GEPETEL_SERVER` overrides the server (default `https://gepetel.com`).

## Tests

```bash
npm test    # builds, then runs tests/ against a real HTTP server on loopback
```

They are worth running before you trust a change: the redirect guard, the byte
cap, the timeout and the "that's a PDF" path are each a case that looked fine by
reading and was not.

The sandbox tests run against a fake `container` CLI that is a **real program**,
spawned the real way, so the argv, the in-sandbox `timeout`, the queue and the
bring-up ladder are all exercised for real. What they cannot test is isolation —
there is no VM on a Linux box — which is why `selftest` exists and why its
checks are the ones from the spec's acceptance list.

`GEPETEL_WORKSPACE` and `GEPETEL_CONTAINER_BIN` override the workspace path and
the runtime binary; `shell_network: false` in `agent.json` takes the sandbox off
the network entirely.

## Where the token lives

`~/Library/Application Support/Gepetel/agent.json`, created 0600. Phase 8 moves
it into the Keychain and wraps all of this in a menu-bar app.

Disconnecting the computer from the chat revokes the token at the server, so a
copy of this file is useless afterwards.
