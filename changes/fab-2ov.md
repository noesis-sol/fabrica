- The engine uploads a Base's git-lfs objects itself before pushing it, so a project under git-lfs pushes again on
  `after_run` and `after_merge`. It uploads where a commit the remote hasn't changes a pointer, wherever in the range.
- Such a Base isn't pushed, and the run says why, where the upload fails, where the host has no git-lfs, or where the
  repository's own configuration makes git-lfs run a command, which a worker could have written (§10.3, §20.2).
- A Base already at its upstream reports that it's up to date, rather than asking to be pushed by hand.
