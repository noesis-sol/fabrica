- `pnpm check:own` keeps the worktree's index's times on its copy, as the engine's `Git.worktreeTree` does, so
  a same-size edit made in the second the index was written is still read as a change: the tree it keeps a
  pass by no longer names HEAD's content for it now and then.
- The ui project's tests install Electron once, in a global setup, before the look test and the Monaco diff
  test start their windows side by side: Electron's package installs its binary the first time it is
  loaded, and two files doing so at once in a freshly set-up worktree had one fail outside its tests. Their
  windows' quit has a minute, as their start has two.
- The look test's and the Monaco diff test's Electron runs on a profile folder of its own in the temp folder,
  removed at its quit, rather than Electron's default in the home folder that every test's Electron shared.
- The window tests end their Electron by its process rather than Playwright's close, which waits on Electron's
  quit with no limit, and the merge queue's tests of the files a merge wrote have 30 s each, as the WSL install
  tests have.
