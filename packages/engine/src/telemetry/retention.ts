import { DateTime, Duration, Effect, Option, Record } from 'effect'
import { SqlClient } from 'effect/sql'

import { Retention } from '@fabrica/contracts'

import { type RowKind, rowTables } from './rows'

// Retention (spec §21): raw rows are kept for `telemetry.retention.raw` (90 days by default), and are
// rolled up into daily aggregates as they are dropped, in the same transaction, so each row counts
// once in the aggregates; the aggregates are kept for `telemetry.retention.daily` (for ever by
// default). Days are UTC days, and a prune drops whole days only.

/** How long raw rows and their daily aggregates are kept: the engine's `telemetry.retention`. */
export interface RetentionSettings {
  readonly raw: Retention
  readonly daily: Retention
}

/** How a kind of row adds up into `daily`: SQL expressions over its table's columns, NULL where it has none. */
interface Rollup {
  readonly key: string
  readonly outcome: string
  readonly duration: string
  readonly tokens: boolean
  readonly cost: string
  /** A subscription's API-price equivalent (§14.4). */
  readonly equivalent: string
  /** A measure summed and maxed: a sample's value. */
  readonly value: string
}

const rollup = (fields: Partial<Rollup>): Rollup => ({
  key: 'NULL',
  outcome: 'NULL',
  duration: 'NULL',
  tokens: false,
  cost: 'NULL',
  equivalent: 'NULL',
  value: 'NULL',
  ...fields,
})

const rollups: { readonly [K in RowKind]: Rollup } = {
  ModelCall: rollup({
    key: `provider || '/' || model`,
    outcome: 'outcome',
    duration: 'latency_ms',
    tokens: true,
    cost: 'cost_usd',
    equivalent: 'equivalent_usd',
  }),
  ToolCall: rollup({
    key: 'tool',
    outcome: `CASE WHEN allowed = 1 THEN 'allowed' ELSE 'refused' END`,
    duration: 'duration_ms',
  }),
  Check: rollup({ key: 'suite', outcome: 'result', duration: 'duration_ms' }),
  Merge: rollup({ outcome: 'outcome', duration: 'duration_ms' }),
  HandBack: rollup({ key: 'kind' }),
  Hold: rollup({ key: 'hold', duration: 'duration_ms' }),
  WorkerSession: rollup({
    key: 'model',
    outcome: 'outcome',
    duration: 'duration_ms',
  }),
  OrganCall: rollup({
    key: 'organ',
    outcome: 'outcome',
    duration: 'duration_ms',
    cost: 'cost_usd',
  }),
  HostSample: rollup({ value: 'load / cores' }),
  ProcessSample: rollup({ key: 'process', value: 'rss_bytes' }),
}

const dayMillis = Duration.toMillis(Duration.days(1))

/** The UTC day of `millis`, as `daily.day` holds it: `2026-10-29`. */
export const dayOf = (millis: number): string =>
  DateTime.formatIsoDateUtc(DateTime.makeUnsafe(millis))

/** The start of the UTC day `keep` before `now`: rows before it go; none where they are kept for ever. */
export const cutoffOf = (
  retention: Retention,
  now: number,
): Option.Option<number> =>
  Retention.match(retention, {
    Forever: () => Option.none(),
    For: ({ duration }) => {
      const before = now - Duration.toMillis(duration)
      return Option.some(
        before - (((before % dayMillis) + dayMillis) % dayMillis),
      )
    },
  })

const rollupStatement = (kind: RowKind): string => {
  const table = rowTables[kind]
  const { key, outcome, duration, tokens, cost, equivalent, value } =
    rollups[kind]
  const project = kind === 'HostSample' ? 'NULL' : 'project'
  const day = `strftime('%Y-%m-%d', at / 1000, 'unixepoch')`
  const sum = (column: string) =>
    column === 'NULL' ? 'NULL' : `sum(${column})`
  const tokenSums = tokens
    ? 'sum(input), sum(output), sum(cache_write), sum(cache_read)'
    : 'NULL, NULL, NULL, NULL'
  return `INSERT INTO daily (day, kind, project, key, outcome, count, duration_ms,
      input, output, cache_write, cache_read, cost_usd, equivalent_usd, value_sum, value_max)
    SELECT ${day}, '${kind}', ${project}, ${key}, ${outcome}, count(*), ${sum(duration)},
      ${tokenSums}, ${sum(cost)}, ${sum(equivalent)}, ${sum(value)}, ${value === 'NULL' ? 'NULL' : `max(${value})`}
    FROM ${table} WHERE at < ?
    GROUP BY 1, 3, 4, 5`
}

const kinds = Record.keys(rowTables)

/**
 * Rolls the raw rows past their retention up into `daily` and drops them, then drops the aggregates
 * past theirs, in one transaction, as of `now` (epoch milliseconds). Returns the raw rows dropped.
 */
export const prune = Effect.fn('Telemetry.prune')(function* (
  retention: RetentionSettings,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      let dropped = 0
      yield* Option.match(cutoffOf(retention.raw, now), {
        onNone: () => Effect.void,
        onSome: cutoff =>
          Effect.forEach(
            kinds,
            kind =>
              Effect.gen(function* () {
                const table = rowTables[kind]
                const counted = yield* sql.unsafe<{
                  readonly count: number
                }>(`SELECT count(*) AS count FROM ${table} WHERE at < ?`, [
                  cutoff,
                ])
                const count = counted[0]?.count ?? 0
                if (count === 0) return
                yield* sql.unsafe(rollupStatement(kind), [cutoff])
                yield* sql.unsafe(`DELETE FROM ${table} WHERE at < ?`, [cutoff])
                dropped += count
              }),
            { discard: true },
          ),
      })
      yield* Option.match(cutoffOf(retention.daily, now), {
        onNone: () => Effect.void,
        onSome: cutoff =>
          sql`DELETE FROM daily WHERE day < ${dayOf(cutoff)}`.pipe(
            Effect.asVoid,
          ),
      })
      return dropped
    }),
  )
})
