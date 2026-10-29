- `packages/contracts` has the settings schemas: the project's `.fabrica/settings.json` (every row of spec
  §13.13 with its default, durations such as `"30m"` in whole milliseconds, `check_fast: "none"` told from a
  check not set) and the engine's own (`machine_workers`, `keep_awake`, `worker_nice`, `auto_answer`,
  `credentials_wait`, `view_interval`, `stream_flush`, telemetry retention). Every problem in a file is reported
  together; an engine or app setting in the project's file is refused, as is a requirement's install that runs
  `sudo`.
