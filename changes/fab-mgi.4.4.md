- Hand-backs (spec §13.7), in `packages/engine/src/merge/handbacks.ts`: a rebase conflict goes back to the
  ticket's own worker (`RESOLVING`, up to `hand_backs.resolve`), the setup first where the rebase brings a
  setup file, and a merge check failing in the ticket's own code too (`FIXING`, up to `hand_backs.fix`), each
  within `resolve_timeout`. The merge turn ends as it hands back (`MergeUpdate.HandedBack`), and the queue goes
  on with the tickets behind it. What the worker did is read from git: a finished rebase, or commits on top of
  the head the check failed on, put the ticket back in line (`Requeued`), where its next turn rebases it onto
  the current Base and runs one check (suite `fix`); a worker that commits nothing gets that one check more and
  no further hand-back. A resolution or fix leaving uncommitted or untracked files is rejected, naming them.
- The prompts ask for what failed (the check's failing lines and its log) and the change's tests, not the
  whole check; a conflict in documents alone asks for the resolution and the rebase only.
- A hand-back's clock stops while the run holds (`HandBackClock`); at the deadline, or a turn ending on the
  usage limit, a finished rebase or a fix commit is taken from git, and otherwise the worker is told the
  hand-back is over before its branch is put back, its attempt kept under `refs/fabrica/attempts/`.
- A merge check failing outside the ticket's code (its failing lines name only tracked files in folders its
  commits don't change), or timing out, sets the ticket aside `CHECKS_FAILED`, to be checked once more
  (`RECHECK`, suite `recheck`) once Base moves on, once a run.
- The workers hand-backs reach are `HandBackWorker`; until the run resumes its workers' sessions for them,
  none can take one, and a hand-back sets its ticket aside as before, saying so.
- `Git.isRebasing` and `Git.keepCommit`.
