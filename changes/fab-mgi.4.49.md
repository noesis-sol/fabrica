- Insights opens its DuckDB database again after an open that failed, rather than keeping the failure until
  the engine restarts: a first request cut short no longer interrupts the open, and a briefly locked
  `telemetry.duckdb` holds only the requests that met it.
