- `Git.worktreeTree` keeps the worktree's index's times on its copy, so a same-size edit made in the second
  the index was written is still read as a change, not taken as HEAD's.
