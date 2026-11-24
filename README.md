# gepetel

A WhatsApp assistant bot. Express app (TypeScript) backed by MongoDB and OpenAI,
receiving messages via a WhatsApp gateway webhook — either
[whapi.cloud](https://whapi.cloud) or the self-hosted
[wa-gateway](https://wa-gateway-coolify.bogdanripa.com/docs.html).

## Hosting

Runs on the self-hosted Pironman box (a Raspberry Pi 5) as the app `gepetel`, at
**https://gepetel-coolify.bogdanripa.com** (custom domain `gepetel.com`). The
Express app listens on its port directly; the Functions Framework wrapper
(`http("app", app)` in `src/app.ts`) remains only for the Cloud Functions
rollback path (`.github/workflows/deploy-gcp.yml`, run by hand).

The whapi.cloud webhook points at `<base-url>/whapi`; wa-gateway's points at
`<base-url>/wa`. Both routes accept both payload shapes.

## Auto-deploy and environments

Every push to `main` builds the image and deploys it to the Pi
(`.github/workflows/deploy.yml`). `main` is both the development and the
production branch: there is **no staging**. A change is checked before merge by
the unit tests, the DB tests (`TEST_DATABASE_URL`) and, for prompt or model
changes, `node dist/replay.js`; after merge, on production (replays can run in
the deployed container: `docker exec <container> node dist/replay.js`).

## Configuration

Runtime config comes from environment variables (Secret Manager in GCP, `.env`
locally — see `.env.example`):

- `WA_PROVIDER` — which gateway to send through: `wa-gateway` (current) or `whapi`.
  With `wa-gateway` selected but no `WA_GATEWAY_TOKEN` set, sends keep going
  through whapi (and log why) — silence in every group is the worse failure.
- `WHAPI_TOKEN` — whapi.cloud channel token
- `WA_GATEWAY_URL` / `WA_GATEWAY_TOKEN` / `WA_GATEWAY_PHONE_NUMBER_ID` — wa-gateway
  base URL and the number's token from its console
- `OPENAI_API_KEY` — OpenAI API key
- `GEPETEL_DATABASE_URL` — MongoDB Atlas connection string
- `ASKED_ONLY_HOURS` — optional, default 24: how long "only when asked" mode lasts in a group
  after he commits to it (the `only_reply_when_asked` tool). While it is on, the reply
  gate lets through only @-mentions and replies to his messages (logged `silent:asked-only`).

### Switching gateways

`WA_PROVIDER` is already `wa-gateway`; the cutover completes itself as soon as the
number is credentialed:

1. Pair the number in the wa-gateway console and set its webhook to `<function-url>/wa`.
2. Put the number's token in `WA_GATEWAY_TOKEN` (Secret Manager in GCP) and redeploy.

To go back to whapi, set `WA_PROVIDER=whapi`.

Inbound events are parsed by payload shape, not by `WA_PROVIDER`, so both
webhooks can point at Gepetel while you switch. Rolling back is the same flip in
reverse.

## Local development

```sh
npm install
npm run dev      # tsc --watch + nodemon on dist/app.js
```

`npm run build` compiles TypeScript to `dist/`. `npm start` runs the built app.
