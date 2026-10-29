- `packages/testkit`, the shared test kit (spec §24, H55, H88): temp folders and git repositories with a
  bare remote, an airtight PATH holding only the tools a test names and its stub scripts (made once per
  file), an environment built from nothing (no inherited terminal variables), and an injected `Host`
  layer for cores, memory, load and home. `HostFacts` and the `Host` service are in
  `packages/contracts`.
- Test workers follow `FABRICA_CORES`, use every core on CI and half the machine's elsewhere; the
  default per-test limit stays 15 s.
- `pnpm test` runs `scripts/test-rerun.ts`: after `vitest run`, each file's failed tests are rerun together
  in one process, the files side by side; a test that passes on its rerun prints `FLAKY: <file> > <test>`
  and the suite passes. An error between tests goes with the rerun of the file its stack is in; one no
  test file can be blamed for fails the suite.
