# Replays

Moments that went wrong in a real chat (or that must keep going right), with
every name, number and detail changed, and what should happen in each. They
are run against the live model — see `src/replay.ts`:

    node dist/replay.js                       # every case, on the models in use
    node dist/replay.js --model gpt-5.6-luna  # replies on another model, to compare
    node dist/replay.js --only "family" --runs 3

Nothing is sent and nothing is stored. Run them before changing a prompt or a
model. When something goes wrong in a chat, the fix comes with a case here.

Never paste a real conversation: change the names, the numbers and anything
that could point at a person, and keep only the shape of what happened.
