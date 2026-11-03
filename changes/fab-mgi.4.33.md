- A run ends `PANIC`, with its stop and `end` records, on a defect outside its workers: in the merge queue's turn or
  hand-back, a merge's update whose record its schema refuses, a look, the run's end, or its start past its checks. It
  no longer waits for good with tickets merging, nor ends with `run --wait` saying `Unended` and `run status` naming
  the previous run.
- A work graph whose changes can't be watched stops the run `TRACKER_FAILED`, rather than leaving new tickets and
  answers unable to wake it.
