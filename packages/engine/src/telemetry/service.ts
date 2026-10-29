import { Context, type Effect } from 'effect'

import type { TelemetryRow } from './rows'

// The Telemetry service (spec §21): what the engine's other services call to record a row. Recording
// never fails and never waits on the store: rows are queued for the writer, which writes them in
// batches from one fiber.

export interface TelemetryShape {
  /** Queues `row`, stamped with the time now, and counts it in the engine's metrics. */
  readonly record: (row: TelemetryRow) => Effect.Effect<void>
  /** Waits until every row recorded before it is written: at the end of its batch. */
  readonly flush: Effect.Effect<void>
}

export class Telemetry extends Context.Service<Telemetry, TelemetryShape>()(
  '@fabrica/engine/Telemetry',
) {}
