# Tests

Plain-JS tests using Node's built-in runner (`node:test`) — no extra dependencies.
They import the **compiled** code from `dist/`, so the build runs first.

There are three tiers; the integration and behavioral tiers **self-skip** unless
their environment variables are set, so `npm test` is always safe to run.

## Tiers

| Tier | File | Needs | Command |
|------|------|-------|---------|
| Unit (pure logic) | `util.test.mjs` | nothing | `npm run test:unit` |
| Integration (MongoDB) | `mongo.test.mjs` | `TEST_DATABASE_URL` | `npm run test:integration` |
| Behavioral (LLM) | `llm.test.mjs` | `RUN_LLM_TESTS=1`, `OPENAI_API_KEY` | `npm run test:llm` |

`npm test` runs all three (integration/LLM skip if their env isn't set).

## Notes

- **Integration**: point `TEST_DATABASE_URL` at a **dedicated / throwaway** database
  (e.g. `mongodb+srv://.../gepetel_test`). The tests create and delete documents and
  the unprompted-scheduling query touches all groups in that DB.
  ```sh
  TEST_DATABASE_URL="mongodb+srv://user:pass@cluster0.../gepetel_test" npm run test:integration
  ```
- **Behavioral**: these call the real OpenAI models, so they cost tokens and are
  non-deterministic. Assertions are kept robust (yes/no gate decisions, presence of
  `@gepetel`, absence of URLs in gossip) but may occasionally need a re-run.
  ```sh
  RUN_LLM_TESTS=1 OPENAI_API_KEY=sk-... npm run test:llm
  ```
