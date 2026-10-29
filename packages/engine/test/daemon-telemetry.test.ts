import { Effect, Exit, Layer, Option, Scope } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { NodeSocket } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import {
  EngineHost,
  FabricaRpcs,
  ProjectId,
  Retention as RetentionSetting,
  TicketId,
} from '@fabrica/contracts'

import {
  type EnginePaths,
  engineDatabaseLayer,
  pathsIn,
  startEngine,
} from '../src/engine'
import {
  Telemetry,
  TelemetryRow,
  telemetryLayer,
  telemetryStoreLayer,
} from '../src/telemetry'

// The daemon's telemetry store (spec §21): `<data>/telemetry.db`, opened as the engine starts, kept as
// the engine's `telemetry.retention` says, closed as it stops, and the store the Insights group reads.

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'test-host',
  cores: 8,
})
const release = '1.2.3'

// 2026-10-29T12:00:00.000Z.
const now = Date.UTC(2026, 9, 29, 12, 0, 0)

const project = ProjectId.make('project-1')
const ticket = TicketId.make('fa-a1b2')

/** A temporary data folder for one test, removed when the test ends; short, as a socket's path must be. */
const scratchPaths = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(NodePath.join(tmpdir(), 'fab-t-'))),
  folder => Effect.promise(() => rm(folder, { recursive: true, force: true })),
).pipe(
  Effect.map(root => {
    const data = NodePath.join(root, 'data')
    return pathsIn({ data, socketFolder: data })
  }),
  Effect.tap(paths =>
    Effect.promise(() => mkdir(paths.data, { recursive: true, mode: 0o700 })),
  ),
)

/** Stores the engine's settings `document` in engine.db, as before the engine starts. */
const storeSettings = (paths: EnginePaths, document: unknown) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(engineDatabaseLayer(paths.database))
      const sql = yield* Effect.provide(SqlClient.SqlClient, context)
      yield* sql`INSERT INTO settings (singleton, document) VALUES (1, ${JSON.stringify(document)})`
    }),
  )

/** Records `rows` in the engine's telemetry store, now, kept for ever. */
const recordRows = (paths: EnginePaths, rows: ReadonlyArray<TelemetryRow>) =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry
    for (const row of rows) yield* telemetry.record(row)
    yield* telemetry.flush
  }).pipe(
    Effect.provide(
      telemetryLayer({
        filename: paths.telemetry,
        retention: {
          raw: RetentionSetting.cases.Forever.make({}),
          daily: RetentionSetting.cases.Forever.make({}),
        },
      }),
    ),
  )

/** How many rows each table of the engine's telemetry store holds, read once the engine has stopped. */
const countsIn = (paths: EnginePaths) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(telemetryStoreLayer(paths.telemetry))
      const sql = yield* Effect.provide(SqlClient.SqlClient, context)
      const count = (table: string) =>
        sql<{
          readonly count: number
        }>`SELECT count(*) AS count FROM ${sql(table)}`.pipe(
          Effect.map(rows => rows[0]?.count ?? 0),
        )
      return {
        hand_backs: yield* count('hand_backs'),
        daily: yield* count('daily'),
      }
    }),
  )

const fix = TelemetryRow.HandBack({ project, ticket, kind: 'fix' })

describe('the daemon’s telemetry store', () => {
  it.effect('keeps rows as the engine’s retention says, and closes', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const paths = yield* scratchPaths
      yield* recordRows(paths, [fix, fix])
      yield* storeSettings(paths, { telemetry: { retention: { raw: '1d' } } })
      yield* TestClock.adjust('3 days')

      const scope = yield* Scope.make()
      yield* startEngine({ paths, host, release }).pipe(Scope.provide(scope))
      yield* Scope.close(scope, Exit.void)

      // The prune at its start rolled the rows past a day up, and was written before the store closed.
      expect(yield* countsIn(paths)).toEqual({ hand_backs: 0, daily: 1 })
    }),
  )

  it.effect('keeps rows 90 days where the engine’s settings say nothing', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const paths = yield* scratchPaths
      yield* recordRows(paths, [fix])
      yield* TestClock.adjust('3 days')

      const scope = yield* Scope.make()
      yield* startEngine({ paths, host, release }).pipe(Scope.provide(scope))
      yield* Scope.close(scope, Exit.void)

      expect(yield* countsIn(paths)).toEqual({ hand_backs: 1, daily: 0 })
    }),
  )

  it.effect('is the store the Insights group reads', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now)
      const paths = yield* scratchPaths
      yield* recordRows(paths, [fix])
      yield* startEngine({ paths, host, release })

      const protocol = yield* Layer.build(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide([
            NodeSocket.layerNet({ path: paths.socket }),
            RpcSerialization.layerNdjson,
          ]),
        ),
      )
      const client = yield* RpcClient.make(FabricaRpcs).pipe(
        Effect.provide(protocol),
      )
      const summary = yield* client['insights.summary']({
        project: Option.none(),
        since: Option.none(),
      })
      expect(summary.handBacks).toEqual({ resolve: 0, fix: 1 })
    }),
  )
})
