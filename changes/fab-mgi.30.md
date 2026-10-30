- The run's side of the merge hygiene (spec §13.7, H72), `packages/engine/src/run/loop.ts`: the run's start
  deletes what an earlier run moved aside into `<worktrees>/.deleting` (`clearAside`, forked, so the start
  doesn't wait on it). What a merge's setup or check wrote is an `info` record and log line
  (`  fa-a1b2: the merge check wrote untracked …, recorded; removed with its worktree`), and a fast-forward
  waiting on Base's dirty checkout a `warn` record
  (`  MERGES_WAIT: <checkout> has uncommitted changes to …; fa-a1b2 merges once it is clean`) and a warning
  banner on the run's view, cleared when the turn's outcome comes.
