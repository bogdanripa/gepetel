#!/usr/bin/env bash
#
# Package website/ as the public static bundle — allowlist in, verified after.
#
# Everything in this zip is served on https://gepetel.com. There is no auth in
# front of it, nothing is indexed anywhere, and a file published by accident has
# no symptom at all: the site works, nothing 404s, and nobody notices. So what
# goes in is an **allowlist of site assets**, never a denylist of plumbing.
#
# The two are not equally wrong when one is incomplete. A gap in an allowlist
# 404s one asset, which whoever added it sees on the next deploy — and this
# script prints every file it left out, so the drop is visible rather than
# silent. A gap in a denylist publishes a file nobody meant to publish, for as
# long as it takes someone to go looking. That is exactly how
# `website/.env.example` came to answer 200 on gepetel.com (its PAYMENT_SECRET
# happened to be empty, so nothing leaked — the next one might not be).
#
# Two further rules, because "not published" is not the same as "safe":
#
#   - a file in website/ whose NAME reads like a credential fails the build
#     outright, even though the allowlist would never have published it. The
#     fix belongs at the source: such a file has no business in the directory
#     that gets zipped.
#   - every text file that WOULD be published is scanned for credential shapes,
#     including this project's own variable names with a value attached. A match
#     fails the build and prints the file and the rule — never the value, since
#     a CI log is a worse place for a secret than the bundle was.
#
# Run it locally exactly as CI does:  scripts/package-site.sh
set -euo pipefail

SRC=${1:-website}
OUT=${2:-site.zip}

[ -d "$SRC" ] || { echo "no such directory: $SRC" >&2; exit 2; }
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
OUT_ABS=$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")

# Site assets. Four kinds of file are deliberately absent, and each absence was
# earned:
#
#   - `.json` — package.json, lockfiles and app config all end in .json. A site
#     that needs a manifest uses .webmanifest.
#   - `.js` / `.mjs` — the site is HTML with inline <script>, and the only .js
#     this directory ever held was `api/extend.js`, a server-side handler from
#     the Vercel era. Publishing it would have served that source on
#     gepetel.com, which is exactly what happened to another app on the same
#     box (`ping-pong`'s server.js answered 200 for weeks). An allowlist with
#     `.js` in it cannot tell a page's script from a server's.
#   - `.map` — a source map IS the source.
#   - `.md` and anything else config- or source-shaped.
#
# So adding client-side JS to this site is a deliberate act: put the extension
# back, having looked at what else in the directory ends in `.js`. The run
# prints every file it left out, so a script added without that step shows up as
# a left-out line rather than as a silently broken page.
ALLOWED='\.(html|css|png|jpg|jpeg|gif|svg|webp|avif|ico|woff|woff2|ttf|otf|txt|xml|webmanifest|pdf|mp4|webm)$'

# By name, independent of the extension check: these must never sit in the
# directory that gets published, whatever the allowlist says today.
CREDENTIAL_NAME='(^|[./_-])(env|secret|secrets|credential|credentials|token|password|passwd|id_rsa|key|keys)([./_-]|$)|\.(env|pem|key|p12|pfx|crt|cer|jks|kdbx|sql|db|sqlite|sqlite3|bak)$'

included=(); excluded=(); refused=()
while IFS= read -r f; do
    f=${f#./}
    base=${f##*/}
    if grep -Eqi "$CREDENTIAL_NAME" <<<"$base" || [[ $base == .* ]]; then
        refused+=("$f")
    elif grep -Eqi "$ALLOWED" <<<"$f"; then
        included+=("$f")
    else
        excluded+=("$f")
    fi
done < <(cd "$SRC" && find . -type f | sort)

# The file list is handed to zip on stdin rather than as glob patterns. Patterns
# would have to be single-quoted every single time — an unquoted '*.css' is
# expanded by the SHELL before zip sees it and then matches only the top
# directory, dropping assets/*.css with no error — and an exact list is also
# what lets the two reports below be exact.
if [ ${#included[@]} -gt 0 ]; then
    ( cd "$SRC" && printf '%s\n' "${included[@]}" | zip -q "$OUT_ABS" -@ )
fi

echo "would publish (${#included[@]}):"
printf '  %s\n' "${included[@]:-(nothing)}"
if [ ${#excluded[@]} -gt 0 ]; then
    echo "left out — not a site asset (${#excluded[@]}):"
    printf '  %s\n' "${excluded[@]}"
fi

fail=0
for f in ${refused[@]+"${refused[@]}"}; do
    echo "REFUSED $SRC/$f — the name reads like a credential; it must not live in the published directory" >&2
    fail=1
done

[ ${#included[@]} -gt 0 ] || { echo "nothing matched the allowlist" >&2; fail=1; }
if [ ${#included[@]} -gt 0 ] && ! printf '%s\n' "${included[@]}" | grep -qx 'index.html'; then
    # Otherwise the platform unpacks a bundle whose homepage is one directory
    # down, and the site 404s from a deploy that looked fine.
    echo "index.html is not at the root of $SRC" >&2
    fail=1
fi

# Content scan of what would actually be published. Text only: a PNG that
# happens to contain the bytes `AKIA...` is noise, and a scan that cries wolf is
# a scan people learn to skip.
RULES=(
  "a private key block|-----BEGIN [A-Z ]*PRIVATE KEY-----"
  "an OpenAI key|sk-[A-Za-z0-9_-]{20,}"
  "a GitHub token|(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"
  "a Slack token|xox[baprs]-[A-Za-z0-9-]{10,}"
  "an AWS access key|AKIA[0-9A-Z]{16}"
  "a Google API key|AIza[0-9A-Za-z_-]{35}"
  "a JWT|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\."
  "a URI with a password in it|[a-z][a-z0-9+.-]*://[^/ \"'<>]*:[^/ \"'<>@]+@"
  "one of this project's own secrets, with a value|(PAYMENT_SECRET|OPENAI_API_KEY|WHAPI_TOKEN|WA_GATEWAY_TOKEN|GEPETEL_DATABASE_URL|MONGODB_URI|TELEGRAM_BOT_TOKEN|PUBLIC_API_KEY|CRON_SECRET|REVIEW_PASSWORD)[\"']?[[:space:]]*[:=][[:space:]]*[\"']?[^[:space:]\"',;)}]+"
)
for f in ${included[@]+"${included[@]}"}; do
    case ${f##*.} in
        html|css|txt|xml|svg|webmanifest) ;;
        *) continue ;;   # the rest are binary; see the note in RULES
    esac
    for rule in "${RULES[@]}"; do
        if grep -Eqi -- "${rule#*|}" "$SRC/$f"; then
            echo "REFUSED $SRC/$f — contains what looks like ${rule%%|*}" >&2
            fail=1
        fi
    done
done

if [ "$fail" -ne 0 ]; then
    rm -f "$OUT_ABS"
    echo >&2
    echo "NOT publishing, and the bundle has been deleted. Fix the files named" >&2
    echo "above — or, if one really is part of the site, widen the allowlist in" >&2
    echo "this script deliberately." >&2
    exit 1
fi
echo "ok — ${#included[@]} site asset(s), no credential names, no credential shapes"
echo "bundle: $OUT_ABS"
