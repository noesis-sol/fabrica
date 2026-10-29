#!/bin/sh
# scripts/check-full.sh: every check, scripts/check-fast.sh then the slower suites. tutti runs it once at
# the end of a run.
# tutti init wrote it; it is the project's to edit. Each suite is one command, run from the
# repository's root, and finds its own test files: a new test in an existing suite needs no edit here.
# Each runs in a subshell, ( ), so that a command failing anywhere in it (cd web && npm test) fails
# the script, and its cd leaves the next suite at the root.
# Each suite prints SUITE: <name> as it starts. A suite that reruns a failed test, and passes when
# the rerun does, prints FLAKY: <test> for it: the ticket merges, and tutti warns of it.
# Every suite runs, and the script fails when any of them does.

# Run with the Node and pnpm that mise.toml pins, where mise is installed.
if [ -z "${FABRICA_TOOLCHAIN:-}" ] && command -v mise >/dev/null 2>&1; then
  FABRICA_TOOLCHAIN=mise exec mise exec -- "$0" "$@"
fi

if [ -z "${FABRICA_CORES:-}" ] && [ -n "${TUTTI_CORES:-}" ]; then
  export FABRICA_CORES="$TUTTI_CORES"
fi

status=0
scripts/check-fast.sh || status=1
# Every package's build, the electron-vite build of the app included.
(echo "SUITE: build" && pnpm run build) || status=1
exit $status
