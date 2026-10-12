# Gepetel website

Marketing/onboarding site **and** the (mock) "extend daily limit" flow for
[Gepetel](https://github.com/bogdanripa/gepetel).

These files ARE the site — no build step. `.github/workflows/deploy.yml` packages
this directory on every push to `main` and uploads it as the static bundle for the
`gepetel` app, so it is served from **the same hostname as the bot**:
`https://gepetel.com`.

**Everything in the bundle is public, so what goes in is an allowlist.**
`scripts/package-site.sh` takes the site-asset extensions and nothing else, then
refuses to publish if any file's name reads like a credential or any published
text file contains a credential shape. Run it the way CI does, any time:

```sh
scripts/package-site.sh          # prints what would be published, and what it left out
node --test tests/packageSite.test.mjs
```

It is an allowlist because this directory published `.env.example` for months
under the old `zip -x` denylist: it answered 200 on gepetel.com and nothing
anywhere said so. A gap in an allowlist 404s one asset and whoever added it
notices; a gap in a denylist publishes a file silently. **No secret belongs in
this directory at any time, even an empty-valued example** — the script fails the
build on the name alone.

Adding a `.js`, a `.map` or a `.json` to the site is a deliberate act: those
extensions are off the allowlist (a server-side handler, a source map and a
package manifest all look exactly like site files), so put the extension back in
the script yourself, having looked at what else in the directory shares it.

One rule decides what answers a request: a path the bundle has a file for is served
from the bundle, and everything else — plus every write, whatever the path — goes to
the Express backend. That is why `/api/extend` reaches the bot even though `/api`
looks like it could be a directory here.

```
website/                 ← packaged to the bundle root (index.html must be at the top)
├── index.html           # landing page
├── faq.html
├── privacy.html
├── tos.html
├── pay.html             # the pay flow
├── assets/              # logo + QR
└── README.md            # this file — left out of the bundle, like anything that is not an asset
```

The Vercel-era files (`api/extend.js`, `vercel.json`, `package.json`,
`.env.example`) are **gone**, not excluded. They were kept so a rollback to
Vercel would be a redeploy rather than a rewrite; that stopped being worth a
dead serverless handler and an env-var example sitting in the one directory on
this box that is published verbatim. `/api/extend` is an Express route now
(`src/app.ts`), and `cleanUrls` is moot because Express serves `/privacy` and
`/tos` from the same HTML the bundle ships.

## The pay flow

Gepetel DMs users a link like `…/pay.html?groupId=<chatId>&userId=<userChatId>`.
The `.html` is spelled out: Vercel's `cleanUrls` made a bare `/pay` work, and the
static host here has no such rule. The bot builds that link from `PUBLIC_BASE_URL`.

1. Pick how many **extra** messages/day: **100 / 200 / 500**.
2. Enter an email.
3. "Payment information" → on submit it's *"oops… this one's on us"* — `pay.html`
   calls `POST /api/extend`, now an Express route on the same origin. It applies the
   extension directly, announces it in the group, and DMs the user.

A group can be extended **only once** (the free one). After that the page shows
"already extended" and the bot returns `409` — no more freebies.

`POST /payment/callback` does the same work but demands the `X-Payment-Secret`
header. It exists for a cross-origin caller — which is what the Vercel function was —
so rolling back needs no code change.

It's a mock (no real charge). To go live later, swap the pay page and `/api/extend`
for a real provider's checkout + webhook, keeping the same call into the bot.

## Add-to-group

The "Add to a group" CTA opens a `wa.me` chat with Gepetel (`+40 750 271 099`)
pre-filled with a friendly first message; the landing page also shows a QR.
