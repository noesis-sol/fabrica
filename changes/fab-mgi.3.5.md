- `packages/engine` has the process runner, `src/process/` (spec §12.1, §20.2, §7.3): `ProcessRunner.run` runs a
  command to its end and `ProcessRunner.start` starts one alongside the engine (an agent's, its stdin a pipe).
  Each command is found on the PATH it will run with, gets an environment built from an allowlist (never git's
  local variables), stdin from `/dev/null`, a process group and session of its own and the worker's nice value
  (read back at once and 100 ms later, and set again where raised); its output is read until it exits and a 2 s
  grace after, and output past the size cap is `Cut`. Ending a command lists its tree, terminates every group in
  it and kills what is left after a grace; the processes still holding its pipes (found with lsof on macOS, /proc
  on Linux) and what it left in its group are ended with it, though it has exited. Time limits count on `Deadlines`, which the wake service will provide.
  Outcomes are `Exited`, `TimedOut`, `Cut` and `FailedToStart`. The engine's tests may now live in `test/`.
