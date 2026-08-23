# Gepetel website

Marketing/onboarding site **and** the (mock) "extend daily limit" flow for
[Gepetel](https://github.com/bogdanripa/gepetel).

These files ARE the site — no build step. `.github/workflows/deploy.yml` zips this
directory on every push to `main` and uploads it as the static bundle for the
`gepetel` app, so it is served from **the same hostname as the bot**:
`https://gepetel-coolify.bogdanripa.com`.

One rule decides what answers a request: a path the bundle has a file for is served
from the bundle, and everything else — plus every write, whatever the path — goes to
the Express backend. That is why `/api/extend` reaches the bot even though `/api`
looks like it could be a directory here.

```
website/                 ← zipped to the bundle root (index.html must be at the top)
├── index.html           # landing page
├── faq.html
├── privacy.html
├── pay.html             # the pay flow
├── assets/              # logo + QR
├── api/extend.js        # DEAD — the old Vercel function, excluded from the zip
├── vercel.json          # DEAD — cleanUrls, excluded from the zip
└── package.json         # DEAD — Vercel project marker, excluded from the zip
```

The last three are kept only so a rollback to Vercel is a redeploy rather than a
rewrite; the workflow's `zip -x` list keeps them out of the bundle.

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
