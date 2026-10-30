- `pnpm check:own` keeps the worktree's index's times on its copy, as the engine's `Git.worktreeTree` does, so
  a same-size edit made in the second the index was written is still read as a change: the tree it keeps a
  pass by no longer names HEAD's content for it now and then.
- The ui project's tests install Electron once, in a global setup, before the look test and the Monaco diff
  test start their windows side by side: Electron's package installs its binary the first time it is
  loaded, and two files doing so at once in a freshly set-up worktree had one fail outside its tests. Their
  windows' quit has a minute, as their start has two.
