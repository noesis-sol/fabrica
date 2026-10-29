- The telemetry query layer (spec §21, H65): DuckDB (`@duckdb/node-api` 1.5.6-r.2, pinned to 1.5.x so
  x64 hosts without AVX2 and macOS x64 keep it, fab-mgi.15) at `<data>/telemetry.duckdb`, its storage
  version pinned to `v1.5.0`, no extension installed or loaded at run time (`json` and `parquet` are
  linked in). DuckDB never opens a SQLite file (fab-mgi.14): the recorded rows and the projects'
  tickets (ID, type, priority, status; never their text) are copied in with the Appender, each refresh
  appending the rows written since and dropping those retention dropped. The event streams and Pi's
  session files are read where they lie, a link planted in a checkout's `.fabrica/` passed over.
- The Insights group is served: `insights.summary` and `insights.query`, the named queries where a
  ticket's time goes, the waits of questions and permission requests, check durations, flaky tests,
  cost per merged ticket by run, tokens by model, hand-back rates and models compared. DuckDB is
  loaded on the first request, so an engine whose host can't load it still runs, each Insights request
  answering why. The engine bundle leaves `@duckdb/node-api` outside it.
- `fabrica insights [<query>]` prints the summary, or a named query's table, with `--project`,
  `--since`, `--ticket`, `--run`, `--suite` and `--by`.
- A Parquet export of the recorded rows, metadata only, is in the engine (`TelemetryDb.exportParquet`);
  asking for it, and OTLP, are follow-ups.
