- The tracked files the merge queue's setups and checks change in a ticket's worktree (a formatter's rewrites,
  a lockfile) are recorded in its own git folder (`fabrica-changed`) however the setup or check ends, and put
  back as HEAD has them (`Git.restoreTracked`, never an untracked or ignored file): at `enter`, so a ticket that
  comes back, or a rider whose ride's check changed them, isn't refused as `CLOSED_UNCOMMITTED` for changes its
  worker never made, and as a ticket is set aside, a failed or timed-out check's (`CHECKS_FAILED`) and a
  `DIRTY_WORKTREE` one's alike, its note naming the files put back.
