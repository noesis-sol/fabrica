- `packages/engine/src/telemetry` records telemetry's typed rows (spec §21, H65) in the engine's own
  SQLite store, `<data>/telemetry.db`, never the work graph's: model calls, tool calls, checks, merges,
  hand-backs, holds, worker sessions, organ calls, and the host's and process trees' load samples, one
  table each, tied to project, run and ticket. The `Telemetry` service's `record` queues a row stamped
  with the time and never waits on the store; one writer fiber writes what came in over a second, or
  sooner once 500 rows wait, in transactions of at most 500 rows, and writes the open batch as its
  scope closes; `flush` waits for the rows before it. Retention (`telemetry.retention`, engine
  settings) prunes at start and daily through the same writer: raw rows past 90 days are rolled up
  into `daily` aggregates by UTC day, project, kind, key and outcome in the transaction that drops
  them, and the aggregates are kept for ever by default. Counters and histograms for each kind of row,
  and the writer's own (batches, rows lost, prunes), live in Effect's metric registry; nothing is
  exported.
