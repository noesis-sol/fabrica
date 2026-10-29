- `scripts/check-own.ts` (`pnpm check:own`) is the repository's own `check_own` (spec §13.6, §23): it
  type-checks the packages a change touches and those depending on them, lints and format-checks the
  changed files, and runs the test files the change reaches through the TypeScript import graph
  (workspace packages included, type-only imports left out). A change to the setup runs
  `scripts/check-fast.sh` whole. Each pass is kept by its tree (HEAD with the uncommitted and untracked
  files) under the worktree's git dir: a run on a tree that passed runs nothing, and a later run looks
  only at what changed since the pass it stands on, `FABRICA_CHECK_OWN_PASSED_AT`'s where the engine
  gives one. `scripts/` is now type-checked and is a Vitest project.
