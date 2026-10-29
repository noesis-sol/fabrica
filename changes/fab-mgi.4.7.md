- Merge hygiene (spec §13.7, H71, H72), `packages/engine/src/merge/hygiene.ts`: a refused fast-forward is
  diagnosed. Base is read again: moved on, the ticket is rebased and checked again; still where it was checked
  (another process's `index.lock`), the fast-forward is tried again 3 s later, up to 3 times, then the ticket is
  set aside `GIT_FAILED`; only a branch that doesn't fast-forward Base where it was checked stops merging
  (`MERGE_FAILED`). A merge turn's branch or Base moving on sends it back at most 3 times over the whole turn,
  then sets it aside (`BASE_KEPT_MOVING`). A setup or merge check that leaves tracked files changed sets the
  ticket aside (`DIRTY_WORKTREE`); the untracked files they wrote are published (`Wrote`). A merged worktree is
  moved aside into `<worktrees>/.deleting`, its branch deleted and its files deleted in the background;
  `clearAside` deletes what an earlier run left there. Uncommitted changes to tracked files in Base's checkout
  make the fast-forward wait (`MergesWait`, `MERGES_WAIT: <checkout> has uncommitted changes to …`), watched
  with a poll beside a file watch, and it goes on once the checkout is clean. `MergeWaits` holds the waits.
