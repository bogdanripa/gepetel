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
- **Gepetel's own window and tab group, kept between jobs.** A job's tab goes
  into Gepetel's window (remembered; created at 500 px, the narrowest Chrome
  allows) before anything attaches to it. When the job ends its tabs stay — at
  most 10, least recently used closed first — and the next job adopts them.
  Other clients keep upstream's behaviour (ungroup on close).
- **A tab Chrome takes is left alone.** Chrome lets no extension debug a page
  another extension is active on (a password manager's menu on a sign-in
  page). Such a tab isn't attached again until it goes to another page —
  fighting for it went round in a loop and the page flickered.
- **A direct line to the app** (`src/bridge.ts`), local only, both sides
  proving the approved key: the takeover for pages the debugger can't hold
  (Chrome's own capture, taps from the extension's world, typing from the
  page's), Gepetel's tabs with Chrome's ids, the window's size (phone or
  maximized), and the extension's log into the app's log.
- **A guard** (`guard/guard.js`, a content script that does nothing outside
  Gepetel's tabs) takes other extensions' frames out of the tabs Gepetel drives.
- Name, description, icons; the version-mismatch message points to
  gepetel.com/computer.
- Its own `key` in `manifest.json` — the development key, id
  `djcknkphaapdnflmmomgfcleihhckgdf`. Its private half is kept outside the repo.
  The Chrome Web Store assigns the published key and id (`store/listing.md`,
  "After publishing").

Playwright opens its connect page at Microsoft's extension id, hard-coded. The
agent points it at this one without patching Playwright: `agent/bin/open-chrome`
stands in for Chrome and rewrites that one address.

## Build, test

```bash
npm ci && npm run build        # → dist/, loadable unpacked
npm run zip                    # → store/gepetel-chrome-<version>.zip, for the Web Store (no key)
node store/graphics.mjs        # → the store's screenshots and promo tile
```

End to end, in Playwright's test Chromium (never a person's Chrome):
`node ../agent/tests/extension.e2e.mjs` after `npx playwright-core install chromium`.
