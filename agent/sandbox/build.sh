#!/usr/bin/env bash
# Build the sandbox image for the `shell` tool. Run it on the Mac, once:
#
#   agent/sandbox/build.sh
#
# It needs Apple's `container` (apple-silicon Mac, github.com/apple/container).
# The agent reports a missing image or a missing CLI through `computer_status`,
# so if you skip this, asking Gepetel "can you run commands?" tells you so.
set -euo pipefail

IMAGE=${GEPETEL_SANDBOX_IMAGE:-gepetel/sandbox}
BIN=${GEPETEL_CONTAINER_BIN:-container}
here=$(cd "$(dirname "$0")" && pwd)

if ! command -v "$BIN" >/dev/null 2>&1; then
    echo "\`$BIN\` is not installed." >&2
    echo "Apple's container runtime needs an Apple-silicon Mac:" >&2
    echo "  https://github.com/apple/container" >&2
    exit 1
fi

echo "Building $IMAGE (a few minutes the first time, it downloads Debian)…"
"$BIN" build --tag "$IMAGE" "$here"

echo
echo "Checking it can actually run something…"
# --rm here, unlike the long-lived sandbox: this one is a test and should leave
# nothing behind.
"$BIN" run --rm "$IMAGE" bash -lc \
    'for t in curl jq python3 node git rg pandoc; do command -v $t >/dev/null || { echo "MISSING: $t"; exit 1; }; done; echo "tools ok: $(python3 -V), node $(node -v)"'

echo
echo "Done. $IMAGE is ready — Gepetel can run commands in it now."
