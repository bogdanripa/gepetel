# gepetel

A WhatsApp assistant bot. Express app (TypeScript) backed by MongoDB and OpenAI,
receiving messages via a WhatsApp gateway webhook — either
[whapi.cloud](https://whapi.cloud) or the self-hosted
[wa-gateway](https://wa-gateway-coolify.bogdanripa.com/docs.html).

## Hosting

Deployed as a **Google Cloud Function (gen2)** in the `gepetel` GCP project,
region `europe-west3`. The Express app is wrapped with the Functions Framework
(`http("app", app)` in `src/app.ts`); when run outside Cloud Run it falls back to
a local `app.listen`.

The whapi.cloud webhook points at `<function-url>/whapi`; wa-gateway's points at
`<function-url>/wa`. Both routes accept both payload shapes.

## Auto-deploy

Every push to `main` deploys via GitHub Actions (`.github/workflows/deploy.yml`)
using Workload Identity Federation — no service-account keys are stored.

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
