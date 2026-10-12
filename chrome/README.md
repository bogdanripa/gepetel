# Gepetel for Chrome

A fork of Microsoft's **Playwright Extension** (Apache-2.0, see `LICENSE`), from
`microsoft/playwright` `packages/extension` at commit `e8149b8257d32dcf8f72573ecc43e72439da7080` — the
same snapshot as the `@playwright/mcp` 0.0.83 the agent pins, so both speak
extension protocol 2.

It lets the Gepetel app on the person's Mac use their Chrome, in its own tab
group, through Playwright MCP's `--extension` mode.

## What is changed, and nothing else

- **No token to copy.** Upstream refuses a client whose token doesn't match the
  one it generated, so the person had to copy that token into the client. Here
  the app makes its own key (kept in the Keychain) and offers it; the first
  time, the connect page asks **"Allow "Gepetel" to use this browser?"** and
  remembers the key on Allow (`gepetel-approved-token`). That key then connects
  without asking; any other key is asked about again, never accepted silently.
  Upstream's own token still works for clients set up the paste way.
- Name, description, icons; the version-mismatch message points to
  gepetel.com/computer.
- Its own `key` in `manifest.json` — the development key, id
  `djcknkphaapdnflmmomgfcleihhckgdf`. Its private half is kept outside the repo.
  The Chrome Web Store assigns the published key and id; when it does, the
  store's public key goes into `manifest.json` and the id into
  `agent/src/extension.ts`.

Playwright opens its connect page at Microsoft's extension id, hard-coded. The
agent points it at this one without patching Playwright: `agent/bin/open-chrome`
stands in for Chrome and rewrites that one address.

## Build, test

```bash
npm ci && npm run build        # → dist/, loadable unpacked
npm run zip                    # → gepetel-chrome.zip, for the Web Store
```

End to end, in Playwright's test Chromium (never a person's Chrome):
`node ../agent/tests/extension.e2e.mjs` after `npx playwright-core install chromium`.
