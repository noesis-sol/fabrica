- A ticket whose worktree is on another branch or a detached HEAD as its merge enters the queue, or as its
  turn goes round to rebase again, is set aside `OFF_BRANCH`, naming what is checked out, rather than the
  queue rebasing and merging that branch or commit and deleting the ticket's branch with its newer commits.
