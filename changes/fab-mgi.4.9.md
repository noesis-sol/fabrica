- Stops, drains and the carry-over (spec §13.10, §13.2, §13.5, H75, H76), in
  `packages/engine/src/run/carryover.ts`: a worker's session is saved in `.fabrica/run/state.json`, written
  whole, once its agent has started, with the Base commit its worktree was prepared from and what it began
  with (the templates' versions, the project's worker rules, the requires list); it is dropped as its ticket
  merges or closes, or waits for another to merge.
- A run's start reads the file before anything writes it, and takes up every ticket still in progress under
  this engine's claim, whatever run left it (a stop, a crash): a rebase left in progress in its worktree is
  aborted, its branch put back; one already on Base is closed and merged, its worktree and branch removed; one
  that had finished goes back in line to merge; the rest go back in the queue. A stop during it cuts it short,
  the rest kept for the next start. The start's line says what it carried.
- Every resume (carried over, answered, undeferred) is a dispatch: through the ready rule, the footprints
  and a free slot, its ticket claimed again, its worktree as it was and its saved session resumed with Pi's
  `switch_session`, told why and what changed since the session began; its worktree gone, it starts afresh.
  A ticket whose worker asked a question goes back in the queue, so the answer readies it; a ticket set aside
  and undeferred during the run comes back in that run.
- A ticket merged by hand is noticed as Base moves: closed with its merged commit, its claim dropped and what
  it blocks freed, its worktree and branch removed, a `closed` record saying so.
