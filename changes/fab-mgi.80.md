- Telemetry exports on demand and over OTLP (spec §21). `fabrica insights export <folder>` (the request
  `insights.export`) has the engine write the recorded rows, metadata only, as one Parquet file per table in
  a folder on its host. The engine setting `telemetry.otlp_endpoint`, off by default, sends Effect's spans
  and metrics and the recorded rows (one log record each) to an OTLP/HTTP endpoint through
  `effect/observability`. One module (`packages/engine/src/telemetry/metadata.ts`) decides what both may
  carry: numbers and flags, and short text whose name isn't content's and that names no path or URL. A
  Parquet export now keeps a model call's tokens out (`output`), which was dropped as if it were content.
