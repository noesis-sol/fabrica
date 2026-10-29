#!/bin/sh
# scripts/check-fast.sh: tutti's merge check, run on every ticket before it merges.
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

# On Linux without a display, the suites run under Xvfb: the UI look test draws the console in an
# Electron window (spec §24).
if [ "$(uname -s)" = Linux ] && [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
  exec xvfb-run -a "$0" "$@"
fi

# The run's share of the cores bounds the type checks, builds and test workers.
if [ -z "${FABRICA_CORES:-}" ] && [ -n "${TUTTI_CORES:-}" ]; then
  export FABRICA_CORES="$TUTTI_CORES"
fi

status=0
(echo "SUITE: typecheck" && pnpm run typecheck) || status=1
(echo "SUITE: lint" && pnpm run lint) || status=1
(echo "SUITE: format" && pnpm run format:check) || status=1
(echo "SUITE: unit" && pnpm run test) || status=1
exit $status
