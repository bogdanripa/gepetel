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
