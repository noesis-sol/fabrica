- `packages/engine` has the Git and Worktrees services, `src/git/` (spec §13.7, §10.2, §11.7, §20.2, H59, H85),
  on the process runner. Every git command runs with `GIT_TERMINAL_PROMPT=0`, no pager or editor, `LC_ALL=C`
  and the allowlisted environment (never git's local variables); revisions go after `--end-of-options`,
  pathspecs after `--`, and a rebase passes `--no-update-refs`. `Git.version` says whether git is 2.38 or later
  (`Supported`, `TooOld`, `Missing`, `Unreadable`). One reader each for a worktree's status (uncommitted and
  untracked files), whether a branch is on Base, the merge base, a commit's hash, the current branch, the files a
  branch changed, the files tracked at a revision and the worktree list; each is retried on a short schedule,
  and one that still fails is `CantTell`, never an answer. `Git.rebase` onto a commit (`Rebased`, `Conflict`,
  `AlreadyRebasing`, `Refused`), `Git.abortRebase`, and `Git.fastForward` of Base to a hash (`FastForwarded`,
  `NotFastForward`, `OffBranch`, `Refused`). `Worktrees.prepare` makes a ticket's worktree from a Base commit at
  `<checkout>-worktrees/<ticket>` (or a cloned project's folder) on `fabrica/<ticket>`, or reuses and rebases
  it; `Worktrees.remove` removes it with its branch; `Worktrees.list` lists tickets' worktrees.
