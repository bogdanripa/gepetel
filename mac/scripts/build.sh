#!/usr/bin/env bash
#
# Build Gepetel.app and Gepetel.dmg: the menu-bar app, with Node and the agent
# inside it, so the person installing it needs nothing else — no Node, no
# Homebrew, no Terminal.
#
#   mac/scripts/build.sh                 # unsigned-but-runnable (ad-hoc), local
#   SIGN_IDENTITY="Developer ID Application: … (TEAMID)" \
#   NOTARY_KEY=/path/AuthKey_XXXX.p8 NOTARY_KEY_ID=XXXX NOTARY_ISSUER=uuid \
#   mac/scripts/build.sh                 # signed and notarized, as CI does
#
# Output: mac/build/Gepetel.app and mac/build/Gepetel.dmg.
#
# Inputs (environment):
#   VERSION         CFBundleShortVersionString (default: the agent's version)
#   BUILD_NUMBER    CFBundleVersion (default 1)
#   SIGN_IDENTITY   a Developer ID Application identity in the keychain; empty
#                   means ad-hoc, which runs here and nowhere else
#   NOTARY_KEY, NOTARY_KEY_ID, NOTARY_ISSUER
#                   an App Store Connect API key; all three, or no notarizing
set -euo pipefail

# Node: the Active LTS line, pinned. Changing the version means changing both
# hashes, from https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt — a
# download that does not match is refused, not trusted.
NODE_VERSION=24.21.0
NODE_SHA_ARM64=6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe
NODE_SHA_X64=0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299

MAC=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(cd "$MAC/.." && pwd)
OUT=$MAC/build
WORK=$OUT/work
APP=$OUT/Gepetel.app
DMG=$OUT/Gepetel.dmg
BUNDLE_ID=com.gepetel.app

VERSION=${VERSION:-$(node -p "require('$REPO/agent/package.json').version")}
BUILD_NUMBER=${BUILD_NUMBER:-1}
SIGN_IDENTITY=${SIGN_IDENTITY:-}

say() { printf '\n== %s\n' "$*"; }

rm -rf "$APP" "$DMG" "$WORK"
mkdir -p "$WORK" "$OUT"

# --- the agent, production dependencies only --------------------------------
say "agent $VERSION"
( cd "$REPO/agent" && npm ci --no-audit --no-fund && npm run build )
AGENT=$WORK/agent
mkdir -p "$AGENT"
cp "$REPO/agent/package.json" "$REPO/agent/package-lock.json" "$AGENT/"
cp -R "$REPO/agent/dist" "$AGENT/dist"
( cd "$AGENT" && npm ci --omit=dev --no-audit --no-fund --ignore-scripts )

# --- Node, both architectures, made into one --------------------------------
say "node $NODE_VERSION (universal)"
fetch_node() {   # arch sha
    local tgz=$WORK/node-$1.tar.xz
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-$1.tar.xz" -o "$tgz"
    echo "$2  $tgz" | shasum -a 256 -c - >/dev/null || { echo "node-$1: checksum mismatch, refusing it" >&2; exit 1; }
    mkdir -p "$WORK/node-$1"
    tar -xJf "$tgz" -C "$WORK/node-$1" --strip-components 1
}
fetch_node arm64 "$NODE_SHA_ARM64"
fetch_node x64 "$NODE_SHA_X64"
NODE=$WORK/node
mkdir -p "$NODE/bin" "$NODE/lib/node_modules"
lipo -create "$WORK/node-arm64/bin/node" "$WORK/node-x64/bin/node" -output "$NODE/bin/node"
# npm comes along because commands in the sandbox install with it; corepack,
# headers, man pages and docs do not.
cp -R "$WORK/node-arm64/lib/node_modules/npm" "$NODE/lib/node_modules/npm"
ln -s ../lib/node_modules/npm/bin/npm-cli.js "$NODE/bin/npm"
ln -s ../lib/node_modules/npm/bin/npx-cli.js "$NODE/bin/npx"
cp "$WORK/node-arm64/LICENSE" "$NODE/LICENSE"

# --- the Swift app, both architectures --------------------------------------
say "app"
for arch in arm64 x86_64; do
    ( cd "$MAC" && swift build -c release --triple "$arch-apple-macosx13.0" --scratch-path "$OUT/swift-$arch" )
done
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create "$OUT/swift-arm64/release/Gepetel" "$OUT/swift-x86_64/release/Gepetel" \
     -output "$APP/Contents/MacOS/Gepetel"
cp -R "$NODE" "$APP/Contents/Resources/node"
cp -R "$AGENT" "$APP/Contents/Resources/agent"

sed -e "s/@VERSION@/$VERSION/g" -e "s/@BUILD@/$BUILD_NUMBER/g" -e "s/@BUNDLE_ID@/$BUNDLE_ID/g" \
    "$MAC/Resources/Info.plist" > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

# Icon: Gepetel's portrait from the website, centre-cropped to a square.
ICONSET=$WORK/AppIcon.iconset
mkdir -p "$ICONSET"
sips -c 574 574 "$REPO/website/assets/gepetel.png" --out "$WORK/square.png" >/dev/null
for s in 16 32 128 256 512; do
    sips -z $s $s "$WORK/square.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$WORK/square.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# --- signing ---------------------------------------------------------------
# Inside out: every Mach-O first, the app last. Hardened runtime everywhere,
# because notarization requires it. Node is the one binary that needs
# entitlements — V8 compiles JavaScript to machine code at run time.
if [ -n "$SIGN_IDENTITY" ]; then
    say "signing as: $SIGN_IDENTITY"
    SIGN=(codesign --force --timestamp --options runtime --sign "$SIGN_IDENTITY")
else
    say "signing ad-hoc (runs on this Mac only)"
    SIGN=(codesign --force --options runtime --sign -)
fi
while IFS= read -r f; do
    if file -b "$f" | grep -q 'Mach-O'; then
        echo "  sign ${f#$APP/}"
        "${SIGN[@]}" "$f"
    fi
done < <(find "$APP/Contents/Resources" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' \))
"${SIGN[@]}" --entitlements "$MAC/Resources/node.entitlements" "$APP/Contents/Resources/node/bin/node"
"${SIGN[@]}" --entitlements "$MAC/Resources/app.entitlements" "$APP"
codesign --verify --deep --strict --verbose=1 "$APP"

# The bundled Node must run under the hardened runtime it was signed with —
# a missing JIT entitlement fails here, not on someone else's Mac.
"$APP/Contents/Resources/node/bin/node" -e 'console.log("bundled node", process.version, process.arch)'

notarize() {   # path
    [ -n "${NOTARY_KEY:-}" ] && [ -n "${NOTARY_KEY_ID:-}" ] && [ -n "${NOTARY_ISSUER:-}" ] || return 0
    xcrun notarytool submit "$1" --key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" \
        --wait --timeout 30m --output-format json | tee "$WORK/notary.json"
    python3 - "$WORK/notary.json" <<'PY' || { echo "notarization was not accepted" >&2; exit 1; }
import json, sys
s = json.load(open(sys.argv[1])).get("status")
print("notary status:", s)
sys.exit(0 if s == "Accepted" else 1)
PY
}

# Stapling fetches the ticket from Apple's CloudKit, and a dropped connection
# there failed the first mac-v0.4.0 release after both notarizations had been
# accepted. The ticket does not change between attempts, so retrying is safe.
staple() {   # path
    for i in 1 2 3 4 5; do
        xcrun stapler staple "$1" && return 0
        echo "staple attempt $i failed; retrying in $((i * 10))s" >&2
        sleep $((i * 10))
    done
    return 1
}

if [ -n "${NOTARY_KEY:-}" ]; then
    say "notarizing the app"
    ditto -c -k --keepParent "$APP" "$WORK/Gepetel.zip"
    notarize "$WORK/Gepetel.zip"
    staple "$APP"
fi

# --- disk image -------------------------------------------------------------
# The window someone sees when they open it: the website's paper, an arrow
# from the app to Applications, big icons, no toolbar. dmgbuild writes the
# Finder layout (.DS_Store) itself, so this works on a headless CI runner
# where scripting Finder does not. Pinned; it runs in its own venv.
say "dmg"
DMGBUILD_VERSION=1.6.7
python3 -m venv "$WORK/venv"
"$WORK/venv/bin/pip" install --quiet --disable-pip-version-check "dmgbuild==$DMGBUILD_VERSION"
swift "$MAC/scripts/dmg-background.swift" "$WORK" 2>&1 | grep -v 'ld: warning' || true
tiffutil -cathidpicheck "$WORK/background.png" "$WORK/background@2x.png" -out "$WORK/background.tiff" >/dev/null
# Icon centres, in step with mac/scripts/dmg-background.swift.
"$WORK/venv/bin/python" - "$APP" "$DMG" "$WORK/background.tiff" <<'PY'
import sys, dmgbuild
app, dmg, bg = sys.argv[1:4]
dmgbuild.build_dmg(dmg, "Gepetel", settings={
    "format": "ULMO",
    "files": [app],
    "symlinks": {"Applications": "/Applications"},
    "icon": app + "/Contents/Resources/AppIcon.icns",
    "background": bg,
    "window_rect": ((200, 160), (660, 420)),
    "default_view": "icon-view",
    "show_toolbar": False, "show_status_bar": False, "show_pathbar": False,
    "show_sidebar": False, "show_tab_view": False,
    "icon_size": 112, "text_size": 14,
    "icon_locations": {"Gepetel.app": (180, 220), "Applications": (480, 220)},
})
PY
if [ -n "$SIGN_IDENTITY" ]; then
    codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG"
fi
if [ -n "${NOTARY_KEY:-}" ]; then
    say "notarizing the dmg"
    notarize "$DMG"
    staple "$DMG"
    # What Gatekeeper will say on a stranger's Mac.
    spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"
    spctl --assess --type execute --verbose=2 "$APP"
fi

du -sh "$APP" "$DMG"
echo "built $DMG"
