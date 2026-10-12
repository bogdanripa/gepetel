#!/usr/bin/env bash
# A stand-in for Apple's `container`, for the sandbox tests.
#
# It is a real program, spawned the real way, so the tests exercise argv
# handling, streaming, the in-sandbox `timeout`, the queue and the bring-up
# ladder end to end. What it deliberately does NOT simulate is isolation: there
# is no VM here, so `exec` runs the command on this machine. The claims that
# depend on isolation — `ls /Users` showing nothing, SSH keys being out of reach
# — can only be proven on a Mac, which is what `gepetel-agent selftest` is for.
#
# State and an argv log live in $GEPETEL_FAKE_DIR so the tests can assert both.
set -uo pipefail

dir=${GEPETEL_FAKE_DIR:?GEPETEL_FAKE_DIR must be set}
ws=${GEPETEL_FAKE_WS:?GEPETEL_FAKE_WS must be set}
# Two files, not one: a container can EXIST and not be RUNNING, which is exactly
# what an idle sandbox becomes, and conflating the two made the bring-up ladder
# untestable — `exec` succeeded on a container that was only supposed to exist.
state="$dir/state"       # the container exists
running="$dir/running"   # ...and is running
log="$dir/argv.log"

# Every argument, NUL-separated, one record per invocation. NUL because an
# argument may contain spaces, quotes or newlines, and the tests assert that the
# command arrives as exactly ONE argument.
{ printf '%s\0' "$@"; printf '\036'; } >> "$log"

case "${1:-}" in
  --version)
    [ -f "$dir/broken" ] && { echo "container: cannot connect to the runtime" >&2; exit 1; }
    echo "container CLI version 1.0.0 (fake)"
    exit 0
    ;;
  run)
    # ... --name X image sleep infinity
    echo created > "$state"
    touch "$running"
    echo "fake-container-id"
    exit 0
    ;;
  start)
    [ -f "$state" ] || { echo "Error: no such container" >&2; exit 1; }
    touch "$running"
    exit 0
    ;;
  stop)
    [ -f "$state" ] || { echo "Error: no such container" >&2; exit 1; }
    rm -f "$running"
    touch "$dir/stopped"
    exit 0
    ;;
  rm)
    rm -f "$state" "$running"
    touch "$dir/removed"
    exit 0
    ;;
  exec)
    [ -f "$running" ] || { echo "Error: no such container: not running" >&2; exit 1; }
    # Skip our flags to find `bash -lc <script> <argv0> <command>`.
    shift                      # exec
    while [ $# -gt 0 ] && [ "$1" != "bash" ]; do shift; done
    [ "$1" = "bash" ] || { echo "fake: no bash in argv" >&2; exit 2; }
    shift; shift               # bash -lc
    script=$1; argv0=$2; command=$3
    # The container's /workspace is the host's workspace directory here. Rewritten
    # rather than mounted, since there is nothing to mount into.
    command=${command//\/workspace/$ws}
    script=${script//\/workspace/$ws}
    cd "$ws" || exit 1
    # $0 and $1 exactly as the real exec passes them, so the tests see the same
    # positional-parameter handling the Mac would.
    bash -lc "$script" "$argv0" "$command"
    exit $?
    ;;
esac
echo "fake: unsupported subcommand ${1:-}" >&2
exit 2
