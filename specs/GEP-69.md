# GEP-69 — Retry the first MongoDB connect, and stop pretending to be healthy without one

Parent: GEP-68 (daily review for 2026-11-03).

## What happened
Container `…-20261102T160955` booted while Atlas SRV DNS answered `ESERVFAIL`
(`querySrv ESERVFAIL _mongodb._tcp.cluster0.dcy2m98.mongodb.net`). `src/mongo.ts` calls
`mongoose.connect(...)` once and only logs the failure, and mongoose does not retry a failed
*initial* connect. So for ~11h every query buffered and timed out after 10s
(`processedmessages.insertOne() buffering timed out`), `GET /groups/` returned 500, incoming
messages were dropped, and reminders/unprompted crons failed — while `/api/health` kept
answering 200, so nothing restarted it. DNS resolved fine from the same container later:
the failure was transient and a retry would have recovered.

## Goal
A transient database failure at boot (or later) heals itself within minutes, without a
human, and the owner is told when it happens.

## Behaviour
1. **Initial connect retries.** If the first `mongoose.connect` fails, retry with backoff
   (2s, doubling, capped at 30s) until it succeeds. Each failure is logged with the error
   message only (never the connection string). Success after ≥1 failure logs
   `MongoDB connected after N attempts`.
2. **Self-restart while disconnected.** If `mongoose.connection.readyState !== 1`
   continuously for more than **120s** (from boot, or from a later disconnect), the process
   logs why and exits non-zero, so the container's restart policy starts a fresh one.
   (Docker/Coolify do not restart a container just for being `unhealthy`, so exiting is the
   mechanism; the health change below is the visible signal.)
3. **Health reflects it, without I/O.** `/api/health` stays dependency-free (no query, no
   network) — it only reads the in-process `readyState`. It answers 200 while connected or
   while disconnected for ≤ the grace period, and **503** with
   `{status:"db-disconnected", since}` once the grace period has passed. Keep the existing
   comment's intent: a deploy must not be rolled back because Atlas is slow for a few seconds.
4. **Telegram alert.** When the self-restart in (2) fires, send one Telegram message via
   `telegram.ts` (if configured) before exiting: what happened, for how long, the last error
   message. Sending must be time-boxed (≤5s) and a failed send must not prevent the exit.
5. Later disconnects after a successful connect keep mongoose's own reconnect; (2) only
   covers the case where it does not come back.

## Acceptance criteria
- With an unreachable/invalid database URL at boot, logs show repeated connect attempts with
  growing delays, `/api/health` is 200 for the first 120s and 503 after, and the process exits
  non-zero shortly after the 120s mark (Telegram attempted if configured).
- With the database becoming reachable during the retry window, the app connects without a
  restart and `/api/health` is 200; messages are processed normally afterwards.
- With a healthy database, boot, health and behaviour are unchanged (no extra latency on
  `/api/health`, deploy gate passes as before).
- Unit tests cover the backoff schedule and the health/exit decision (pure functions with an
  injected clock), and `node scripts/test-changed.mjs` passes.
- No secret (connection string, token) appears in any log line or alert.

## Out of scope
- Replaying messages lost during an outage.
- Changing the Atlas cluster or DNS setup.
- Restarting the currently affected container (asked of the owner separately in GEP-69's
  description; the release of this fix replaces that container anyway).
