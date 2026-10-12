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
    # The steps, not a link. "It is not installed" with a repository URL leaves
    # somebody to work out that the repository has no install instructions on
    # its front page, that the artefact is a signed .pkg on the releases page,
    # and that there is a service to start afterwards.
    cat >&2 <<'EOT'
`container` is not installed. It is Apple's own container runtime, and it is
not part of macOS — you install it once:

  1. Open  https://github.com/apple/container/releases
  2. Download the latest signed installer (the .pkg) and double-click it.
     It asks for your admin password; it installs under /usr/local.
  3. Start the service:   container system start
  4. Run this script again.

It needs an Apple-silicon Mac and macOS 26. Check with:

  uname -m                  # must say arm64, not x86_64
  sw_vers -productVersion   # must be 26 or later

If either of those says otherwise, this Mac cannot run the sandbox. Everything
else — "is my computer on?" and reading pages on it — keeps working, and
Gepetel will tell you it cannot run commands rather than failing quietly.
EOT
    exit 1
fi

# Installed, but the service may not be running — that is a separate step after
# the installer, and the error from a build without it is not obvious.
if ! "$BIN" system status >/dev/null 2>&1; then
    echo "\`$BIN\` is installed but its service does not look started." >&2
    echo "Run this, then try again:   $BIN system start" >&2
    echo >&2
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
