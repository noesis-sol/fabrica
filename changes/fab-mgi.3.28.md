- `packages/engine` has the merge queue, `src/merge/` (spec §13.7, H59, H62, H71): `MergeQueue`, an Effect
  `Queue` with one consumer, takes each finished ticket's worktree through a machine of named steps (enter,
  locate, rebase, check, confirm, fast-forward), one handler each, and publishes a stream of tagged updates
  (`Step`, `Check`, and the outcomes `Merged`, `NoChange`, `SetAside`, `NoMergeCheck`, `SetupFailed`,
  `Interrupted`, `Stopped`). A branch whose commits change nothing closes as `no_change`; the branch is rebased
  onto the commit read as Base when Base moved (a conflict sets the ticket aside, `MERGE_CONFLICT`, its rebase
  aborted); the setup runs, through the `MergeSetup` port (`noSetup` until the run's setup fills it), when the
  rebase brought in a `setup_files` file; `check_fast` runs on every merge (a failure sets aside
  `CHECKS_FAILED`); Base is read again and fast-forwarded to the checked hash, so a commit made after the check
  is checked first; the ticket's `merged_commit` is recorded, it is closed, and its worktree and branch
  removed. A project without `check_fast` doesn't merge (`NoMergeCheck`); `none` merges unchecked and says so.
  Only the fast-forward to the end of its notes is uninterruptible; an interrupted rebase is aborted; a git
  read that can't tell sets the ticket aside as `GIT_FAILED`. A set-aside ticket is deferred with a note.
  `handbacks.ts`, `train.ts` and `hygiene.ts` are the stubs M2 fills.
