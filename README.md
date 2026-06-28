# gepetel

A WhatsApp assistant bot. Express app (TypeScript) backed by MongoDB and OpenAI,
receiving messages via a [whapi.cloud](https://whapi.cloud) webhook.

## Hosting

Deployed as a **Google Cloud Function (gen2)** in the `gepetel` GCP project,
region `europe-west3`. The Express app is wrapped with the Functions Framework
(`http("app", app)` in `src/app.ts`); when run outside Cloud Run it falls back to
a local `app.listen`.

The whapi.cloud webhook points at `<function-url>/whapi`.

## Auto-deploy

Every push to `main` deploys via GitHub Actions (`.github/workflows/deploy.yml`)
using Workload Identity Federation — no service-account keys are stored.

## Configuration

Runtime config comes from environment variables (Secret Manager in GCP, `.env`
locally — see `.env.example`):

- `WHAPI_TOKEN` — whapi.cloud channel token
- `OPENAI_API_KEY` — OpenAI API key
- `GEPETEL_DATABASE_URL` — MongoDB Atlas connection string

## Local development

```sh
npm install
npm run dev      # tsc --watch + nodemon on dist/app.js
```

`npm run build` compiles TypeScript to `dist/`. `npm start` runs the built app.
