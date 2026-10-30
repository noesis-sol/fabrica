- The merge train reads a rider's branch from `refs/heads/<branch>`, not its worktree's HEAD, and takes no
  rider whose worktree is in the middle of a rebase or off its branch, so a rider's turn no longer merges a
  partly rebased commit with its branch's later commits cut off. Putting a rider back resets only the ride's
  rebased head; a branch moved elsewhere during the ride is left as it is and its turn set aside.
