import { Duration, Effect, Exit, Layer, Metric, Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'

import { describe, expect, it } from '@effect/vitest'
import {
  ModelName,
  ProjectId,
  ProviderName,
  Retention as RetentionSetting,
  RunId,
  TicketId,
} from '@fabrica/contracts'

import {
  Telemetry,
  type TelemetryOptions,
  TelemetryRow,
  batchesWritten,
  makeTelemetry,
  prunesRun,
  rowsLost,
  telemetryLayer,
  telemetryStoreLayer,
} from '../src/telemetry'
import { storeLayer as workGraphStoreLayer } from '../src/workgraph'

// Telemetry's rows in the engine's SQLite store (spec §21, H65): written in batches from one fiber,
// the open batch written as its scope closes, and raw rows rolled up into daily aggregates as
// retention drops them, under `TestClock`, against an in-memory store.

// 2026-10-29T12:00:00.000Z.
const start = Date.UTC(2026, 9, 29, 12, 0, 0)

const project = ProjectId.make('project-1')
const run = RunId.make('run-1')
const ticket = TicketId.make('fa-a1b2')

const kept: TelemetryOptions['retention'] = {
  raw: RetentionSetting.cases.For.make({ duration: Duration.days(90) }),
  daily: RetentionSetting.cases.Forever.make({}),
}

const check = (seconds: number) =>
  TelemetryRow.Check({
    project,
    run,
    ticket,
    suite: 'merge',
    duration: Duration.seconds(seconds),
    result: 'passed',
  })

const modelCall = TelemetryRow.ModelCall({
  project,
  run,
  ticket,
  provider: ProviderName.make('anthropic'),
  model: ModelName.make('claude-opus-5-5'),
  tokens: { input: 100, output: 50, cache_write: 10, cache_read: 1000 },
  costUsd: 0.25,
  latency: Duration.seconds(4),
  firstToken: Duration.millis(800),
  outcome: 'answered',
})

const hostSample = TelemetryRow.HostSample({ load: 6, cores: 12 })

/** Telemetry with `options` on a fresh in-memory store, the store's client beside it. */
const telemetryOn = (options: Partial<TelemetryOptions> = {}) =>
  Layer.effect(Telemetry, makeTelemetry({ retention: kept, ...options })).pipe(
    Layer.provideMerge(telemetryStoreLayer(':memory:')),
  )

/** How many rows `table` holds. */
const countOf = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      readonly count: number
    }>`SELECT count(*) AS count FROM ${sql(table)}`
    return rows[0]?.count ?? 0
  })

const batches = Effect.map(Metric.value(batchesWritten), state => state.count)
const lost = Effect.map(Metric.value(rowsLost), state => state.count)

const prunes = Effect.map(Metric.value(prunesRun), state => state.count)

/** Yields until `condition` holds, letting the writer fiber run; no clock moves. */
const until = (
  condition: Effect.Effect<boolean, unknown, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    while (!(yield* condition)) yield* Effect.yieldNow
  })

describe('telemetry writes', () => {
  it.effect('writes a batch once its interval passes, in one transaction', () =>
    Effect.gen(function* () {
      const telemetry = yield* Telemetry
      // The prune at start wakes the writer; once it is done, the writer waits for rows.
      yield* telemetry.flush
      const before = yield* batches
      yield* telemetry.record(check(30))
      yield* telemetry.record(modelCall)
      for (let i = 0; i < 10; i += 1) yield* Effect.yieldNow
      expect(yield* countOf('checks')).toBe(0)

      yield* TestClock.adjust('1 second')
      yield* telemetry.flush
      expect(yield* countOf('checks')).toBe(1)
      expect(yield* countOf('model_calls')).toBe(1)
      expect((yield* batches) - before).toBe(1)
    }).pipe(Effect.provide(telemetryOn({ batchSize: 10 }))),
  )

  it.effect('writes a full batch without waiting for its interval', () =>
    Effect.gen(function* () {
      const telemetry = yield* Telemetry
      const before = yield* batches
      yield* telemetry.record(check(1))
      yield* telemetry.record(check(2))
      yield* telemetry.record(check(3))
      yield* until(Effect.map(countOf('checks'), count => count === 3))
      expect((yield* batches) - before).toBe(1)
    }).pipe(
      Effect.provide(telemetryOn({ batchSize: 3, flushInterval: '1 hour' })),
    ),
  )

  it.effect('splits what waited into batches of at most its size', () =>
    Effect.gen(function* () {
      const telemetry = yield* Telemetry
      const before = yield* batches
      for (let i = 0; i < 7; i += 1) yield* telemetry.record(check(i))
      yield* telemetry.flush
      expect(yield* countOf('checks')).toBe(7)
      expect((yield* batches) - before).toBe(3)
    }).pipe(Effect.provide(telemetryOn({ batchSize: 3 }))),
  )

  it.effect("writes the rows' columns, tied to project, run and ticket", () =>
    Effect.gen(function* () {
      const telemetry = yield* Telemetry
      yield* telemetry.record(modelCall)
      yield* telemetry.record(hostSample)
      yield* telemetry.flush
      const sql = yield* SqlClient.SqlClient
      const calls = yield* sql`SELECT * FROM model_calls`
      expect(calls).toEqual([
        {
          at: start,
          project: 'project-1',
          run: 'run-1',
          ticket: 'fa-a1b2',
          provider: 'anthropic',
          model: 'claude-opus-5-5',
          input: 100,
          output: 50,
          cache_write: 10,
          cache_read: 1000,
          cost_usd: 0.25,
          equivalent_usd: null,
          latency_ms: 4000,
          first_token_ms: 800,
          outcome: 'answered',
          error: null,
        },
      ])
      const samples = yield* sql`SELECT * FROM host_samples`
      expect(samples).toEqual([
        {
          at: start,
          load: 6,
          cores: 12,
          memory_pressure: null,
          swap_used_bytes: null,
        },
      ])
    }).pipe(
      Effect.provide(
        Layer.unwrap(Effect.as(TestClock.setTime(start), telemetryOn())),
      ),
    ),
  )

  it.effect('writes the open batch as its scope closes', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const telemetry = yield* makeTelemetry({
        retention: kept,
        flushInterval: '1 hour',
      }).pipe(Scope.provide(scope))
      for (let i = 0; i < 5; i += 1) yield* telemetry.record(check(i))
      expect(yield* countOf('checks')).toBe(0)

      yield* Scope.close(scope, Exit.void)
      expect(yield* countOf('checks')).toBe(5)

      const lostBefore = yield* lost
      yield* telemetry.record(check(9))
      yield* telemetry.flush
      expect((yield* lost) - lostBefore).toBe(1)
      expect(yield* countOf('checks')).toBe(5)
    }).pipe(Effect.provide(telemetryStoreLayer(':memory:'))),
  )

  it.effect("never writes the work graph's database", () =>
    Effect.gen(function* () {
      const telemetry = yield* Telemetry
      yield* telemetry.record(check(1))
      yield* telemetry.flush
      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql<{
        readonly name: string
      }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'checks'`
      expect(tables).toEqual([])
    }).pipe(
      Effect.provide(
        telemetryLayer({ filename: ':memory:', retention: kept }).pipe(
          Layer.provideMerge(workGraphStoreLayer(':memory:')),
        ),
      ),
    ),
  )
})

/**
 * Moves the clock `days` days, a day at a time, waiting for each day's prune. `TestClock` wakes the
 * daily pruning fiber as it passes its time, but the fiber runs, and asks for the next day, when it
 * is scheduled; a day at a time, each day's prune runs on its day.
 */
const passDays = (days: number) =>
  Effect.gen(function* () {
    for (let day = 0; day < days; day += 1) {
      const before = yield* prunes
      yield* TestClock.adjust('1 day')
      yield* until(Effect.map(prunes, count => count > before))
    }
  })

describe('telemetry retention', () => {
  it.effect(
    'rolls raw rows past their 90 days up into daily aggregates, and keeps those',
    () =>
      Effect.gen(function* () {
        const telemetry = yield* Telemetry
        const sql = yield* SqlClient.SqlClient
        yield* telemetry.record(check(30))
        yield* telemetry.record(check(90))
        yield* telemetry.record(modelCall)
        yield* telemetry.record(hostSample)
        yield* telemetry.flush

        yield* passDays(89)
        expect(yield* countOf('checks')).toBe(2)
        expect(yield* countOf('daily')).toBe(0)

        yield* passDays(2)
        expect(yield* countOf('model_calls')).toBe(0)
        expect(yield* countOf('host_samples')).toBe(0)
        const daily = yield* sql`SELECT * FROM daily ORDER BY kind`
        expect(daily).toEqual([
          {
            day: '2026-10-29',
            kind: 'Check',
            project: 'project-1',
            key: 'merge',
            outcome: 'passed',
            count: 2,
            duration_ms: 120_000,
            input: null,
            output: null,
            cache_write: null,
            cache_read: null,
            cost_usd: null,
            equivalent_usd: null,
            value_sum: null,
            value_max: null,
          },
          {
            day: '2026-10-29',
            kind: 'HostSample',
            project: null,
            key: null,
            outcome: null,
            count: 1,
            duration_ms: null,
            input: null,
            output: null,
            cache_write: null,
            cache_read: null,
            cost_usd: null,
            equivalent_usd: null,
            value_sum: 0.5,
            value_max: 0.5,
          },
          {
            day: '2026-10-29',
            kind: 'ModelCall',
            project: 'project-1',
            key: 'anthropic/claude-opus-5-5',
            outcome: 'answered',
            count: 1,
            duration_ms: 4000,
            input: 100,
            output: 50,
            cache_write: 10,
            cache_read: 1000,
            cost_usd: 0.25,
            equivalent_usd: null,
            value_sum: null,
            value_max: null,
          },
        ])

        yield* passDays(100)
        expect(yield* countOf('daily')).toBe(3)
      }).pipe(
        Effect.provide(
          Layer.unwrap(Effect.as(TestClock.setTime(start), telemetryOn())),
        ),
      ),
  )

  it.effect('drops daily aggregates past their own retention', () =>
    Effect.gen(function* () {
      const telemetry = yield* Telemetry
      yield* telemetry.record(check(30))
      yield* telemetry.flush

      yield* passDays(1)
      expect(yield* countOf('checks')).toBe(1)
      yield* passDays(1)
      expect(yield* countOf('checks')).toBe(0)
      expect(yield* countOf('daily')).toBe(1)

      yield* passDays(28)
      expect(yield* countOf('daily')).toBe(1)
      yield* passDays(1)
      expect(yield* countOf('daily')).toBe(0)
    }).pipe(
      Effect.provide(
        Layer.unwrap(
          Effect.as(
            TestClock.setTime(start),
            telemetryOn({
              retention: {
                raw: RetentionSetting.cases.For.make({
                  duration: Duration.days(1),
                }),
                daily: RetentionSetting.cases.For.make({
                  duration: Duration.days(30),
                }),
              },
            }),
          ),
        ),
      ),
    ),
  )

  it.effect('keeps raw rows for ever when told to', () =>
    Effect.gen(function* () {
      const telemetry = yield* Telemetry
      yield* telemetry.record(check(30))
      yield* telemetry.flush
      yield* passDays(200)
      expect(yield* countOf('checks')).toBe(1)
      expect(yield* countOf('daily')).toBe(0)
    }).pipe(
      Effect.provide(
        telemetryOn({
          retention: {
            raw: RetentionSetting.cases.Forever.make({}),
            daily: RetentionSetting.cases.Forever.make({}),
          },
        }),
      ),
    ),
  )
})
