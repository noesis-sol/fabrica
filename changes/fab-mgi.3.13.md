- `packages/engine/src/runlog` is the run's log (spec §7.5, §13.12, H84): the `RunLog` service writes each
  project's event stream, `.fabrica/run/events.jsonl`, and its human log, `.fabrica/fabrica.log`, through
  the safe writer's append stream, a record and its log line together or not at all (under one lock,
  uninterruptibly, the record first, so a lost record loses its line too). Every record is dated once,
  local with its UTC offset, and carries the run's ID; its line is dated with the same time, as orchestra
  dates its lines (`2026-10-29 10:15:00 +0200`), each control, separator and bidi mark in it written as an
  escape. orchestra's line formats (dispatching, footprint, settled, merged, hold and lifted lines,
  warnings, `SLEPT:`) are built here; durations become `seconds` to a tenth, never negative. The reader
  decodes the stream for the reviewer, follow and the `run events` stream, skipping kinds and versions it
  doesn't know and counting lines that aren't records; `recordSleeps` writes the `slept` record and its
  line from the wake service's notifications.
