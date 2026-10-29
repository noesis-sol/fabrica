- The engine daemon opens its telemetry store, `<data>/telemetry.db`, as it starts, kept as the
  engine's `telemetry.retention` says, and closes it after the projects' work graphs, its open batch
  written, before engine.db. `Telemetry` and the store (`TelemetryStore`) are among the daemon's
  services for the groups' handlers; the Insights group reads that store rather than opening its own.
  An engine whose stored settings don't decode starts on its defaults, saying so.
