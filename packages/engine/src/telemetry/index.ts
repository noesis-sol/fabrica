// Telemetry (spec §21, H65): typed rows recorded in the engine's own SQLite store, and its metrics;
// DuckDB the query layer over them, with the named queries; their export, metadata only.
export { batchesWritten, observe, prunesRun, rowsLost } from './metrics'
export {
  QueryLayerFailed,
  TelemetryDb,
  type TelemetryDbShape,
  makeTelemetryDb,
  telemetryDbLayer,
} from './duckdb'
export { metadataSerialization } from './metadata'
export { telemetryMigrations } from './migrations'
export { type OtlpExportOptions, otlpExportLayer } from './otlp'
export {
  type Sources,
  findEventStream,
  findSessionFiles,
  readSummary,
  runNamedQuery,
} from './queries'
export { type RetentionSettings, cutoffOf, dayOf, prune } from './retention'
export {
  type HandBackKind,
  type MergeOutcome,
  type ModelCallOutcome,
  type RowKind,
  type SampledProcess,
  TelemetryRow,
  type Tie,
  rowTables,
} from './rows'
export * from './service'
export {
  type TelemetryOptions,
  TelemetryStore,
  layer as telemetryLayer,
  makeTelemetry,
  storeLayer as telemetryStoreLayer,
} from './store'
