- The packaged app's smoke test runs on a developer's Mac, an unsigned build too. On macOS the app's data
  folder is the user's whatever HOME says, so the app under test shared the single-instance lock with any
  other Fabrica open, the user's own or another run's, and quit at launch or waited on it; the app now keeps
  a data folder `--user-data-dir` names, and the smoke test gives it one of its own. The smoke and update
  tests poll on the live clock: under `it.effect`'s TestClock a check that didn't hold at once was never
  checked again, and the test waited out its timeout.
