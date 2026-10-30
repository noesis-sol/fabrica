- Runs over RPC (spec §8.1, §13.1, §13.10, §13.12): `run.start` starts a run of a project in the mode and
  with the flags it is given (the current tickets, or one ticket and its descendants; `--limit`, and the
  settings flags resolved with the project's and the engine's settings) and answers once its start checks
  have, with the run's ID or with every problem together (`RunRefused`, `SETUP`); one run per project
  (`RunGoing`). `run.stop` ends it `INTERRUPTED` (exit code 130), `run.drain` dispatches nothing more and it
  ends `DRAINED` once the running tickets have merged, `run.undrain` takes the drain back, each written as
  its record; `run.status` gives the run going and its state, or how the last one ended; `run.watchEvents`
  streams the run's records so far, then each as it is written, ending with the run, or an earlier run's by
  its ID. A run's ID is its start time. The project's row says whether a run goes. As the engine stops, its
  runs are stopped and each ends `INTERRUPTED`. Spec, feature and overnight runs are refused until they are
  built; `run.preflight` and the run view's stream answer `NotImplemented`.
- The daemon runs projects on what it is given to run them on (its agents, the model proxy, the checks:
  `ServeOptions.runs`); `fabrica serve` gives it nothing yet, so it refuses every run, saying why.
- `fabrica run [--tickets|--ticket <id>|--spec …|--feature …|--overnight] [--limit N] [--concurrent N]
  [--model …] [--auto-answer[=<duration>]] [--offline] [--wait]` starts a run of the project (`--project`,
  or the one whose checkout holds the folder) and returns once it starts; with `--wait` it prints the run's
  lines and exits with its end's code (§13.11); a refused start prints its problems and exits 2.
  `fabrica run status|drain|undrain|stop` act on the project's run. `fabrica follow` prints the going run's
  lines (each record the log has a line for, with its time of day; every record with `--json`) until it
  ends.
