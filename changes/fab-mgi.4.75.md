- The gate asks before any `git config` write without `--worktree`: a plain write (`git config core.hooksPath x`,
  `set`, `--unset`, `--edit`, …) lands in the config every worktree shares, where `core.fsmonitor` or
  `core.hooksPath` would run in the engine's own git, as `--global` and `--system` land outside the worktree. A
  write to a file (`-f`) is placed as other paths are; a form the gate can't read is taken as a write (§12.6, §20.2).
