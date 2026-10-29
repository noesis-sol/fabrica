- `packages/engine` has the Checks service, `src/checks/` (spec §13.6–§13.9, §20.2): `Checks.run` runs a
  project's check or setup command in a worktree, in `sh` through the process runner, with the allowlisted
  environment, its core share (`FABRICA_CORES`, `GOFLAGS=-p=<n>`) and, where given, the tree of the last
  passing `check_own` (`FABRICA_CHECK_OWN_PASSED_AT`). Its output, stderr in its stdout, is kept in
  `.fabrica/run/checks/<ticket>.<suite>.log` (`<suite>.log` for the run's own) below the checkout, opened as
  every engine file is. It comes to `Passed`, `Failed`, `TimedOut` or `CouldNotRun` (a refused command, one
  that didn't start, output past the cap, a log that couldn't be kept), each with its `check` record, and,
  from git's status before and after, the tracked files it changed (`DIRTY_WORKTREE`) and the untracked files
  it wrote, or `CantTell`. `suiteSetting` names the setting each suite runs.
- `Process.layerAwake` counts the process runner's time limits in time awake, through the wake service.
- `CommandLine` (contracts) refuses a command whose one non-blank character is a control character: its
  pattern let a single one through.
