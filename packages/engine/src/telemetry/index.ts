// Telemetry (spec §21, H65): typed rows recorded in the engine's own SQLite store, and its metrics.
export { batchesWritten, observe, prunesRun, rowsLost } from './metrics'
export { telemetryMigrations } from './migrations'
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
  layer as telemetryLayer,
  makeTelemetry,
  storeLayer as telemetryStoreLayer,
} from './store'
