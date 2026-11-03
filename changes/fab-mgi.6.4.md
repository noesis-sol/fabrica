- Base is fetched and fast-forwarded before a run (§10.3, H10): where Base has an upstream that moved and Base
  has no commits of its own, the run's start fast-forwards it and starts there; where they diverged, the run
  starts on Base as it is and says `BASE_DIVERGED`, and a fetch or fast-forward that couldn't be made says
  `BASE_NOT_SYNCED`. Base is pushed to its upstream as the project's `push` says: `after_merge` after each merge,
  `after_run` once the run's full check passes (the end's `afterFullCheck` port), never by default for a
  registered checkout; a push that isn't a fast-forward is not made and says `PUSH_REFUSED`, and none is forced.
