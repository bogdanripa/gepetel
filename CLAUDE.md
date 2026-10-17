# Workflow

- Always work directly on `main`: commit and push changes straight to `main`. Do not create feature branches or pull requests unless explicitly asked.

# Tests

- While developing, run only the tests that cover what changed: `node scripts/test-changed.mjs` (uncommitted changes, or the last commit), `--since <ref>` for a range, `--dry` to see the plan. The map from paths to suites is in the script.
- Only for a major release (a version ending in .0, or a release to the Chrome Web Store), run the full suite: `node scripts/test-changed.mjs --all`. Patch releases ship on the tests that cover what changed; CI runs the whole agent suite only on x.y.0 tags.
