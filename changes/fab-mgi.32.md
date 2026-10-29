- A worktree records the setup it waits for (spec §13.8, §13.10), in its own git folder (`Git.ownPath`,
  `fabrica-setup`): the merge's rebase step, the train's ride and its put-back record their setup files before
  the setup runs and drop them once it passes, and a stop that puts a ride back records the files the ride set
  the worktree up for without waiting on a setup. The ticket's next merge reads the record and runs the setup
  at its rebase step, with the files that rebase brings, its branch on top of Base or not, so a carried-over
  ticket isn't checked with the dependencies of the ticket it rode behind, and a setup that failed or was cut
  short runs again.
