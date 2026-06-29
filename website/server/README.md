# Gepetel website — server

A small Node.js (Express) backend that:

- serves the static marketing site in `../client` (landing, FAQ, privacy), and
- hosts a **mock payment flow** for extending a group's daily message limit.

## Payment flow (mock)

When a group hits its daily limit, Gepetel DMs the user a link like:

```
https://gepetel.bogdanripa.com/pay?groupId=<chatId>&userId=<userChatId>
```

- `GET /pay?groupId=&userId=` → a fake checkout page (pick a new daily limit).
- `POST /pay/complete` → forwards to the bot's `POST /payment/callback` with the
  `X-Payment-Secret` header and `{ groupId, userId, limit }`. The bot applies the
  new `dailyReplyLimit`, announces it in the group, and DMs the payer.

It's a **mock** — no real charge. To make it a real provider later, replace
`/pay` + `/pay/complete` with the provider's checkout + webhook, keeping the same
call to the bot callback.

## Config (env)

| Variable | Purpose |
|----------|---------|
| `PAYMENT_SECRET` | Must equal the bot's `PAYMENT_SECRET` (in Secret Manager) so the callback accepts us. |
| `BOT_CALLBACK_URL` | The bot's payment callback. Defaults to the prod Cloud Function URL. |
| `PORT` | Listen port (default 8080). |

See `.env.example`.

## Run

```sh
npm install
PAYMENT_SECRET=... npm start        # http://localhost:8080
# or
npm run dev      # restarts on file changes
```

## Deploy

Intended for `gepetel.bogdanripa.com`. Set the env vars above on your host.
