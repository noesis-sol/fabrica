- The run loop holds tickets apart by their footprints (spec §13.4, H70, H81), in
  `packages/engine/src/run/footprints-gate.ts`: a ready ticket overlapping a ticket in progress (running,
  merging or waiting to merge) or one dispatched before it in the same look is held back, its reason kept on
  its `held_back` phase and said in the log in words (`touches src/x.ts, like running fa-7`, `like fa-7
  waiting to merge`, `touches the area area:ui, …`); every ready ticket waits while a `solo` ticket runs or
  waits first in line (`waits for the solo ticket fa-9`), and a solo ticket starts only with nothing else in
  progress (`waits to run alone, after fa-1`). A ticket past its work holds on the files its branch changed,
  and on no slot; while `concurrent` such tickets wait to merge, nothing more is dispatched. Base's files, the
  files merged by union, the check commands' files and `shared_files` are read once per Base commit.
- A dispatch says `dispatching solo` for a solo ticket, carries `held`, `held_by` and `solo`, and is followed by
  the ticket's footprint line and a `LIKELY_CONFLICT` warning for each ticket in progress it shares only files
  that hold no tickets apart with.
- `packages/engine/test/run-harness.ts` gives test files whole runs over the stubbed Pi (`setUpRuns`, `project`,
  `file`, `runOf`); the stub's `finish` takes files to append a line to.
