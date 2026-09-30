# GEP-3 — `/groups/:id` returns 500 (raw CastError) on a non-ObjectId id

## Goal
The admin route `GET /groups/:id` (and `POST /groups/:id`) must answer a malformed id with a clean 404, not an unhandled Mongoose `CastError` with a stack trace in the logs.

## Background (verified in code)
- `app.get('/groups/:id')` (src/app.ts ~736) passes `req.params.id` straight to `m.getGroupById`, which queries by `_id`. A value that is not a valid ObjectId (e.g. a raw WhatsApp JID like `1203…@g.us`) makes Mongoose throw `CastError`.
- `app.post('/groups/:id')` (~791) has the same call, before its `try`.

## Behaviour
- If `:id` is not a valid ObjectId, respond `404 Group not found` (same body as the existing not-found case) without querying Mongo.
- Valid ids behave exactly as today. Apply the guard in both GET and POST (ideally inside `getGroupById`, so any caller is safe).
- No CastError stack trace is logged for a bad id.

## Acceptance criteria
- `GET /groups/<valid id of existing group>` → 200 as before.
- `GET /groups/<valid ObjectId, no such group>` → 404.
- `GET /groups/1203630…@g.us` and `GET /groups/abc` → 404 "Group not found", no error logged.
- Same for `POST /groups/:id`.
- Unit test covers `getGroupById` with a non-ObjectId string returning null.

## Out of scope
Auth changes, other routes, accepting JIDs as an alternative lookup key.

## Design
- **Change (single place):** in `src/mongo.ts`, `getGroupById(_id)` returns `null` when `!mongoose.Types.ObjectId.isValid(_id)`, before touching Mongo. `isValid` also accepts any 12-char string, so use the stricter check `/^[0-9a-fA-F]{24}$/.test(_id)` (or `isValid(_id) && String(new ObjectId(_id)) === _id`).
- **Routes:** `GET /groups/:id` (app.ts ~736) and `POST /groups/:id` (~791) already handle a null group with 404 "Group not found"; verify POST's null check happens before any use of `g`, no route change otherwise expected.
- **Tests:** add to `tests/mongo.test.mjs` a case: `getGroupById('abc')` and `getGroupById('1203630...@g.us')` resolve to null without querying/throwing (follow existing test conventions for stubbing Group).
- **Environments:** production only. Deploy is automated: push to `main` triggers `.github/workflows/deploy.yml`, which builds `ghcr.io/bogdanripa/gepetel:latest` and the box redeploys it (Pironman app `gepetel`). No staging.
