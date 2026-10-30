- Setup in worktrees (spec §13.8), in `packages/engine/src/run/setup.ts`: the project's `setup` runs in each
  new worktree before its worker's first prompt, and again in a reused one whose rebase brought a
  `setup_files` file or whose earlier setup failed or was cut short, within `check_timeout`, its output kept in
  `.fabrica/run/checks/<ticket>.setup.log` and its `check` record (suite `setup`) in the run's. The same setup
  serves the merge queue's `MergeSetup` port, which the run now provides itself; the run hostings no longer
  give `noSetup`.
- A failing setup puts its ticket back until a merge (`SETUP_FAILED`, a warning naming its log): one its
  worker's setup failed goes back in the queue, released, and one its merge's setup failed back in line to
  merge, each set up again as it comes round. The tickets still waiting are named at the run's end
  (`SETUP_WAITS`).
