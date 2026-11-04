- The scout: at `init`, a short read-only session on the repository answers the project's check suites, setup,
  stack and requirements as proposals. No test runs twice: a full-tier suite that already runs everything the
  fast tier does is `check_full` alone, a project's own full runner is kept as it is, and build and packaging
  steps found only in CI are offered unticked with what they cost. A proposed command holding a newline or a
  control character is left out, saying why, and what the scout cost is reported.
