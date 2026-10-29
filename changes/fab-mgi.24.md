- Workers check their change through the `check_own` tool: the engine runs the project's `check_own` in the
  worktree through the Checks service, records a pass with the tree it ran on (HEAD's, with the uncommitted
  and untracked files, read through a git folder of the engine's own so the worktree's index is untouched),
  passes the ticket's last pass's tree as `FABRICA_CHECK_OWN_PASSED_AT`, and publishes the check's record for
  the event stream. `finish` stands on that pass once what was checked is committed.
