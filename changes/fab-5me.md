- The engine's own git runs with `-c core.fsmonitor=false -c core.hooksPath=/dev/null`, every command: a
  `core.fsmonitor` or `core.hooksPath` a worker writes into its worktree's configuration, or a hook in the
  repository, no longer runs inside the engine's status, rebase or merge, outside the gate. A project's own hooks
  don't run on the engine's merges, worktrees and pushes either; a remote's still do (§12.6, §20.2).
