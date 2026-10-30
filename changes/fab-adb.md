- `pnpm check:own` keeps the worktree's index's times on its copy, as the engine's `Git.worktreeTree` does, so
  a same-size edit made in the second the index was written is still read as a change: the tree it keeps a
  pass by no longer names HEAD's content for it now and then.
