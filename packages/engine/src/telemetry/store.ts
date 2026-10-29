import {
  type Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Latch,
  Layer,
  Metric,
  Queue,
  Ref,
} from 'effect'
import { Reactivity } from 'effect/reactivity'
import { SqlClient } from 'effect/sql'

import { SqliteClient } from '@effect/sql-sqlite-node'

import { migrate } from '../workgraph/migrations'
import { batchesWritten, observe, prunesRun, rowsLost } from './metrics'
import { telemetryMigrations } from './migrations'
import { type RetentionSettings, prune } from './retention'
import { type Columns, type TelemetryRow, columnsOf, rowTables } from './rows'
import { Telemetry } from './service'

// The telemetry store (spec §21, H65): `<data>/telemetry.db`, one per engine, its own SQLite database,
// never the work graph's. Recorded rows go through a queue to one writer fiber, which writes what
// came in over `flushInterval` (or sooner, once `batchSize` rows wait) in transactions of at most
// `batchSize` rows, so a crash loses at most the open batch; the batch open when the store's scope
// closes is written before it closes. An idle writer waits on its queue, with no timer. Pruning goes through the same writer, once at start and every `pruneEvery` after.

export interface TelemetryOptions {
  /** The engine's `telemetry.retention`. */
  readonly retention: RetentionSettings
  /** The most rows a batch holds; 500 when left out. */
  readonly batchSize?: number
  /** The longest a recorded row waits for its batch to be written; 1 second when left out. */
  readonly flushInterval?: Duration.Input
  /** How often retention prunes; daily when left out. */
  readonly pruneEvery?: Duration.Input
  /** The most rows waiting to be written; rows past it are lost, and counted. 10,000 when left out. */
  readonly queueCapacity?: number
}

/** What the writer is given: a row, a request to tell when the rows before it are written, or a prune. */
type Entry = Data.TaggedEnum<{
  Row: { readonly row: TelemetryRow; readonly at: number }
  Flush: { readonly done: Deferred.Deferred<void> }
  Prune: {}
}>
const Entry = Data.taggedEnum<Entry>()

/** The store: the database at `filename` (`:memory:` for one in memory), migrated. */
export const storeLayer = (filename: string) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const sql = yield* SqliteClient.make({ filename })
      const context = Context.make(SqliteClient.SqliteClient, sql).pipe(
        Context.add(SqlClient.SqlClient, sql),
      )
      yield* migrate(telemetryMigrations).pipe(Effect.provide(context))
      return context
    }),
  ).pipe(Layer.provide(Reactivity.layer))

/** The Telemetry service on the store in context, its writer and pruning running in the current scope. */
export const makeTelemetry = Effect.fn('Telemetry.make')(function* (
  options: TelemetryOptions,
) {
  const sql = yield* SqlClient.SqlClient
  const queue = yield* Queue.dropping<Entry, Cause.Done>(
    options.queueCapacity ?? 10_000,
  )
  const batchSize = Math.max(1, options.batchSize ?? 500)
  const flushInterval = Duration.fromInputUnsafe(
    options.flushInterval ?? '1 second',
  )
  const lose = (count: number) => Metric.update(rowsLost, count)

  const writeRows = Effect.fn('Telemetry.writeBatch')(function* (
    rows: ReadonlyArray<{ readonly row: TelemetryRow; readonly at: number }>,
  ) {
    const byTable = new Map<string, Array<Columns>>()
    for (const { row, at } of rows) {
      const table = rowTables[row._tag]
      const columns = columnsOf(row, at)
      const same = byTable.get(table)
      if (same === undefined) byTable.set(table, [columns])
      else same.push(columns)
    }
    yield* sql
      .withTransaction(
        Effect.forEach(
          byTable,
          ([table, values]) =>
            sql`INSERT INTO ${sql(table)} ${sql.insert(values)}`,
          { discard: true },
        ),
      )
      .pipe(
        Effect.andThen(Metric.update(batchesWritten, 1)),
        Effect.catch(error =>
          Effect.logWarning(
            `telemetry: ${rows.length} rows lost, their batch failed: ${error.message}`,
          ).pipe(Effect.andThen(lose(rows.length))),
        ),
      )
  })

  const pruneNow = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    yield* prune(options.retention, now).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.andThen(Metric.update(prunesRun, 1)),
      Effect.catch(error =>
        Effect.logWarning(`telemetry: pruning failed: ${error.message}`),
      ),
    )
  })

  const handle = (entries: ReadonlyArray<Entry>) =>
    Effect.gen(function* () {
      const rows: Array<{ readonly row: TelemetryRow; readonly at: number }> =
        []
      const flushes: Array<Deferred.Deferred<void>> = []
      let pruneDue = false
      for (const entry of entries) {
        Entry.$match(entry, {
          Row: ({ row, at }) => {
            rows.push({ row, at })
          },
          Flush: ({ done }) => {
            flushes.push(done)
          },
          Prune: () => {
            pruneDue = true
          },
        })
      }
      for (let start = 0; start < rows.length; start += batchSize) {
        yield* writeRows(rows.slice(start, start + batchSize))
      }
      if (pruneDue) yield* pruneNow
      for (const done of flushes) yield* Deferred.succeed(done, undefined)
    })

  /** Open when the writer shouldn't wait out the interval: a batch is full, or something waits on it. */
  const urgent = yield* Latch.make()
  /** Entries queued since the writer last took them. */
  const pending = yield* Ref.make(0)

  // Waits for an entry, then for the interval or an urgent one, then takes all there are. The loop
  // ends once the queue has ended and nothing is left in it.
  const writer = yield* Effect.gen(function* () {
    const first = yield* Queue.take(queue)
    yield* Effect.raceFirst(Effect.sleep(flushInterval), urgent.await)
    yield* urgent.close
    yield* Ref.set(pending, 0)
    const rest = yield* Queue.clear(queue)
    yield* handle([first, ...rest])
  }).pipe(
    Effect.forever,
    Effect.catch(() => Effect.void),
    Effect.forkScoped,
  )
  /** Queues `entry` for the writer, waking it when `now`; whether the queue took it. */
  const offer = (entry: Entry, now: boolean) =>
    Effect.gen(function* () {
      const queued = yield* Queue.offer(queue, entry)
      const waiting = yield* Ref.updateAndGet(pending, count => count + 1)
      if (now || waiting >= batchSize) yield* urgent.open
      return queued
    })
  const prunes = offer(Entry.Prune(), true)
  yield* prunes
  yield* Effect.sleep(
    Duration.fromInputUnsafe(options.pruneEvery ?? '1 day'),
  ).pipe(Effect.andThen(prunes), Effect.forever, Effect.forkScoped)
  // Runs before the fibers above are interrupted: no row is taken after this, and the writer writes
  // the batch it has before it ends.
  yield* Effect.addFinalizer(() =>
    Queue.end(queue).pipe(
      Effect.andThen(urgent.open),
      Effect.andThen(Fiber.join(writer)),
      Effect.ignore,
    ),
  )

  const record = (row: TelemetryRow) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      yield* observe(row)
      const queued = yield* offer(Entry.Row({ row, at }), false)
      if (!queued) yield* lose(1)
    })

  const flush = Effect.gen(function* () {
    const done = yield* Deferred.make<void>()
    const queued = yield* offer(Entry.Flush({ done }), true)
    if (queued) yield* Deferred.await(done)
  }).pipe(Effect.withSpan('Telemetry.flush'))

  return Telemetry.of({ record, flush })
})

/** Telemetry on the engine's store at `filename`, migrated on opening. */
export const layer = (
  options: TelemetryOptions & { readonly filename: string },
) =>
  Layer.effect(Telemetry, makeTelemetry(options)).pipe(
    Layer.provide(storeLayer(options.filename)),
  )
