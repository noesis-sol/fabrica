import { Context, type Effect } from 'effect'

import type { ProjectId } from '@fabrica/contracts'

import type { TelemetryRow } from './rows'

// The Telemetry service (spec §21): what the engine's other services call to record a row. Recording
// never fails and never waits on the store: rows are queued for the writer, which writes them in
// batches from one fiber. What a project has spent is read back from them, for its budget (§14.4).

/** What model calls spent, as a budget measures it: every token, and money. */
export interface Measured {
  /** Tokens, the cache's included. */
  readonly tokens: number
  /** Money in US dollars: a subscription's API-price equivalent isn't. */
  readonly usd: number
}

/** Nothing spent. */
export const nothingMeasured: Measured = { tokens: 0, usd: 0 }

export interface TelemetryShape {
  /** Queues `row`, stamped with the time now, and counts it in the engine's metrics. */
  readonly record: (row: TelemetryRow) => Effect.Effect<void>
  /** Waits until every row recorded before it is written: at the end of its batch. */
  readonly flush: Effect.Effect<void>
  /**
   * What `project`'s model calls spent, every row recorded before it and those retention has rolled
   * up; nothing where the store can't say, logged.
   */
  readonly projectSpent: (project: ProjectId) => Effect.Effect<Measured>
}

export class Telemetry extends Context.Service<Telemetry, TelemetryShape>()(
  '@fabrica/engine/Telemetry',
) {}
