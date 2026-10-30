import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Stream,
} from 'effect'
import { RpcTest } from 'effect/rpc'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import {
  InsightsRpcs,
  ProjectNotFound,
  Retention as RetentionSetting,
} from '@fabrica/contracts'

import { EngineFiles, type EnginePaths, pathsIn } from '../src/engine/paths'
import { Projects } from '../src/projects/service'
import { engineQueryLayer, insightsHandlersOn } from '../src/rpc/insights'
import { type TelemetryStore, telemetryLayer } from '../src/telemetry'
import { QueryLayerFailed, TelemetryDb } from '../src/telemetry/duckdb'

// The Insights group opens its database again after an open that failed (spec §21, §7.1): only a
// database that opened is kept, so a first request cut short, or a telemetry.duckdb briefly locked,
// doesn't leave Insights broken until the engine restarts.

const retention = {
  raw: RetentionSetting.cases.For.make({ duration: Duration.days(90) }),
  daily: RetentionSetting.cases.Forever.make({}),
}

/** A folder of the test's own, removed as its scope closes. */
const scratch = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(NodePath.join(tmpdir(), 'fabrica-reopen-'))),
  folder => Effect.promise(() => rm(folder, { recursive: true, force: true })),
)

/** An engine with no project: every request reads only the recorded rows. */
const noProjects = () => {
  const unused = () => Effect.die('not used by the Insights group')
  return Projects.of({
    add: unused,
    list: Effect.succeed([]),
    remove: unused,
    find: id => Effect.fail(new ProjectNotFound({ project: id })),
    setTrusted: unused,
    setRun: unused,
    worktreeHome: unused,
    settings: unused,
    setSettings: unused,
    workGraph: unused,
    onBase: unused,
    watchStatus: () => Stream.die('not used by the Insights group'),
  })
}

/** A client of the handlers, their database the one `database` gives, the engine's files in a scratch folder. */
const clientOf = (
  database: (
    files: EnginePaths,
  ) => Layer.Layer<TelemetryDb, unknown, TelemetryStore>,
) =>
  Effect.gen(function* () {
    const data = yield* scratch
    const paths = pathsIn({ data, socketFolder: data })
    const services = yield* Layer.build(
      insightsHandlersOn(database).pipe(
        Layer.provide(Layer.succeed(Projects)(noProjects())),
        Layer.provide(Layer.succeed(EngineFiles)(paths)),
        Layer.provide(telemetryLayer({ filename: paths.telemetry, retention })),
      ),
    )
    return yield* RpcTest.makeClient(InsightsRpcs).pipe(
      Effect.provide(services),
    )
  })

const everything = { project: Option.none(), since: Option.none() }

describe('the Insights group’s database', () => {
  it.effect(
    'is opened again after an open that failed, what that open held released',
    () =>
      Effect.gen(function* () {
        const opens = yield* Ref.make(0)
        const released = yield* Ref.make(false)
        const client = yield* clientOf(files =>
          Layer.unwrap(
            Effect.map(
              Ref.getAndUpdate(opens, n => n + 1),
              n =>
                n === 0
                  ? Layer.effect(
                      TelemetryDb,
                      Effect.acquireRelease(Effect.void, () =>
                        Ref.set(released, true),
                      ).pipe(
                        Effect.andThen(
                          Effect.fail(
                            new QueryLayerFailed({
                              reason: 'telemetry.duckdb is locked',
                            }),
                          ),
                        ),
                      ),
                    )
                  : engineQueryLayer(files),
            ),
          ),
        )
        const failed = yield* Effect.exit(
          client['insights.summary'](everything),
        )
        expect(
          Exit.isFailure(failed) &&
            Cause.pretty(failed.cause).includes('telemetry.duckdb is locked'),
        ).toBe(true)
        expect(yield* Ref.get(released)).toBe(true)
        const summary = yield* client['insights.summary'](everything)
        expect(summary.merged).toBe(0)
        yield* client['insights.summary'](everything)
        // The database that opened is kept: the third request opens nothing.
        expect(yield* Ref.get(opens)).toBe(2)
      }),
  )

  it.effect(
    'finishes opening for a request interrupted meanwhile, and keeps it',
    () =>
      Effect.gen(function* () {
        const opens = yield* Ref.make(0)
        const started = yield* Deferred.make<void>()
        const go = yield* Deferred.make<void>()
        const client = yield* clientOf(files =>
          Layer.unwrap(
            Ref.update(opens, n => n + 1).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(go)),
              Effect.as(engineQueryLayer(files)),
            ),
          ),
        )
        const first = yield* Effect.forkChild(
          client['insights.summary'](everything),
        )
        yield* Deferred.await(started)
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(first))
        yield* Deferred.succeed(go, undefined)
        yield* Fiber.join(interrupting)
        const summary = yield* client['insights.summary'](everything)
        expect(summary.merged).toBe(0)
        expect(yield* Ref.get(opens)).toBe(1)
      }),
  )

  it.effect('is opened once for requests that come together', () =>
    Effect.gen(function* () {
      const opens = yield* Ref.make(0)
      const client = yield* clientOf(files =>
        Layer.unwrap(
          Effect.as(
            Ref.update(opens, n => n + 1),
            engineQueryLayer(files),
          ),
        ),
      )
      yield* Effect.all(
        [
          client['insights.summary'](everything),
          client['insights.summary'](everything),
          client['insights.summary'](everything),
        ],
        { concurrency: 'unbounded' },
      )
      expect(yield* Ref.get(opens)).toBe(1)
    }),
  )
})
