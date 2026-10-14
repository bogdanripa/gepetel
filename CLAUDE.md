# Workflow

- Always work directly on `main`: commit and push changes straight to `main`. Do not create feature branches or pull requests unless explicitly asked.

# Tests

- While developing, run only the tests that cover what changed: `node scripts/test-changed.mjs` (uncommitted changes, or the last commit), `--since <ref>` for a range, `--dry` to see the plan. The map from paths to suites is in the script.
- Before a release to the stores (Chrome Web Store, a public Mac release), run the full suite: `node scripts/test-changed.mjs --all`.
