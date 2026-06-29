# Gepetel website

Marketing/onboarding site **and** the (mock) "extend daily limit" flow for
[Gepetel](https://github.com/bogdanripa/gepetel). Deploys to
**gepetel.bogdanripa.com** on **Vercel**: static HTML served from the CDN, plus one
serverless function for the extend backend.

```
website/                 ← Vercel project root
├── index.html           # landing page
├── faq.html
├── privacy.html
├── pay.html             # the /pay flow (served at /pay via cleanUrls)
├── assets/              # logo + QR
├── api/extend.js        # serverless function (forwards to the bot callback)
├── vercel.json          # cleanUrls
└── package.json         # ESM, no deps
```

## The `/pay` flow

Gepetel DMs users a link like `…/pay?groupId=<chatId>&userId=<userChatId>`:

1. Pick how many **extra** messages/day: **100 / 200 / 500**.
2. Enter an email.
3. "Payment information" → on submit it's *"oops… this one's on us"* — `pay.html`
   calls `POST /api/extend`, which forwards to the bot's `POST /payment/callback`.
   The bot **adds** the messages to the group's limit, announces it in the group,
   and DMs the user.

A group can be extended **only once** (the free one). After that the page shows
"already extended" and the bot returns `409` — no more freebies.

It's a mock (no real charge). To go live later, swap the `/pay` page + `/api/extend`
for a real provider's checkout + webhook, keeping the same call to the bot callback.

## Add-to-group

The "Add to a group" CTA opens a `wa.me` chat with Gepetel (`+40 750 271 099`)
pre-filled with a friendly first message; the landing page also shows a QR.

## Deploy (Vercel)

- Point a Vercel project at this `website/` directory (set it as the root).
- Set env vars (Settings → Environment Variables): `PAYMENT_SECRET` (same value as the
  bot's, from Secret Manager) and optionally `BOT_CALLBACK_URL` (defaults to the prod
  Cloud Function). See `.env.example`.
- Map the domain `gepetel.bogdanripa.com`.
