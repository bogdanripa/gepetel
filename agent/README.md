# Gepetel Agent

Runs on your own Mac and lets Gepetel use it — from your 1:1 chat with him, and
nowhere else.

It dials **out** to Gepetel and holds one WebSocket open. Nothing listens on your
machine, no port is forwarded, no tunnel is involved. The only credential stored
here is a device token this machine was handed when you typed a six-digit code
into your own chat.

## Phase 0

One tool: `computer_status` — whether the Mac is reachable, and what it can do.
The point of this phase is that pairing, reconnection and the call protocol are
right before anything more interesting is added.

## Use

```bash
cd agent && npm install && npm run build

# In WhatsApp: "connect my computer" → Gepetel sends a 6-digit code
node dist/index.js pair 123456

node dist/index.js run        # keep it running; reconnects on its own
node dist/index.js unpair     # forget the token locally
```

`GEPETEL_SERVER` overrides the server (default `https://gepetel.com`).

## Where the token lives

`~/Library/Application Support/Gepetel/agent.json`, created 0600. Phase 8 moves
it into the Keychain and wraps all of this in a menu-bar app.

Disconnecting the computer from the chat revokes the token at the server, so a
copy of this file is useless afterwards.
