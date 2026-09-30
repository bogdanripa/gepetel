# GEP-2 — Reconnect MCP connectors automatically; offer the login link first time

## Goal
A connector whose OAuth login has lapsed should heal itself when it can (refresh token), and when it can't, the user must be handed the reconnect link on the *first* failure, not after asking for it.

## Background (verified in code)
- Refresh already exists: `mcpToolsForGroup` (src/oai.ts) calls `mcp.refreshTokens` only when `expires_at` is within 60s, and stores the result.
- Gaps: (a) a refresh that fails (e.g. `invalid_grant`, revoked) just logs and **drops the connector from that reply** — the model never learns why, so it says "can't reach calendar" and waits (the GEP-2 live example). (b) A token revoked *before* `expires_at` is attached as-is, the provider rejects it at call time, and there is no refresh-and-retry. (c) `prompts/dm.txt` tells the model to reconnect on a 401, but in groups (`group-reply.txt`) and when the connector is silently dropped, it never sees a 401.

## Behaviour
1. **Refresh on auth failure, not only on expiry.** When a connector's tool call fails with an auth error (401/403, "invalid_token", "unauthorized") and a refresh token exists, refresh once and retry the reply/call transparently. Store rotated tokens as today.
2. **Classify refresh failures.** Definitive (`invalid_grant`, `invalid_client`, 400/401 from the token endpoint, no refresh token and token expired) vs transient (network, timeout, 5xx, 429). Transient: skip this reply as today, log, retry next time; never trigger a reconnect.
3. **Definitive failure → tell the model and offer the link at once.** Instead of silently dropping the connector, mark it `needs_reconnect` (stored on the connector doc, cleared on successful reconnect) and include in the model's context/tool result that this service's login is revoked/expired. The model must, in its first reply on the topic, say so in one line and produce a fresh reconnect link (the existing remove + add_mcp_connector flow, in the 1:1 where the requester can complete OAuth; in a group, point the person to their private chat as `group-reply.txt` already describes). No "want me to reconnect?" question, no waiting for the user to ask.
4. Update `prompts/dm.txt` and `prompts/group-reply.txt` accordingly (keep existing wording constraints: no "settings page").
5. Logs (existing `console.error` lines) stay, metadata only, never tokens.

## Acceptance criteria
- Token near expiry + valid refresh token → refreshed silently, request succeeds, new tokens stored (unchanged).
- Token rejected mid-life + valid refresh token → one refresh + retry, user sees no error.
- Refresh fails with `invalid_grant` → connector flagged, model told, reconnect link offered in the same reply as the failure notice.
- Refresh fails with a network error/5xx → no flag, no link, retried next request.
- Successful reconnect clears the flag.
- Unit tests cover: definitive vs transient classification, flag set/clear, tool-list output for a flagged connector, and refresh-and-retry on auth failure.

## Out of scope
Non-OAuth (header/token) connectors; proactive background refresh cron; UI for connector health; changing the OAuth flow itself.
