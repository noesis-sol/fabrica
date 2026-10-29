import {
  Clock,
  Context,
  DateTime,
  Deferred,
  Effect,
  Layer,
  Option,
  Ref,
} from 'effect'
import { SqlClient, type SqlError } from 'effect/sql'

import {
  type EngineHost,
  type EngineId,
  type EngineSettings,
  EngineStatus,
  EngineVersion,
  type ReleaseVersion,
  defaultMachineWorkers,
  protocolVersion,
  supportedVersions,
} from '@fabrica/contracts'

import type { StoredSettingsInvalid } from './database'
import { engineIdentity, projectCount, storedEngineSettings } from './database'

// The Engine service (spec §7.1, §8.1): the engine's identity, version, status and settings, and its
// stop. Stopping asks the engine's root scope to end, which winds the runs down, then the agents,
// then the servers (`EngineScopes`); from the moment it is asked, the engine's status says so.

export interface EngineShape {
  readonly id: EngineId
  readonly version: EngineVersion
  /** The engine's status; `clients` is how many the RPC server has connected. */
  readonly status: (options: {
    readonly clients: number
  }) => Effect.Effect<EngineStatus, StoredSettingsInvalid | SqlError.SqlError>
  readonly settings: Effect.Effect<
    EngineSettings,
    StoredSettingsInvalid | SqlError.SqlError
  >
  /** Asks the engine to stop; the engine's root scope ends once its caller has answered. */
  readonly stop: Effect.Effect<void>
  /** Waits until the engine is asked to stop. */
  readonly stopRequested: Effect.Effect<void>
}

export class Engine extends Context.Service<Engine, EngineShape>()(
  '@fabrica/engine/Engine',
) {}

/** What the engine is told of itself as it starts. */
export interface EngineFacts {
  readonly release: ReleaseVersion
  readonly host: EngineHost
}

/** The Engine service on the engine's database; it says it is stopping from when its scope starts to end. */
export const engineLayer = (facts: EngineFacts) =>
  Layer.effect(
    Engine,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const withSql = Effect.provideService(SqlClient.SqlClient, sql)
      const id = yield* engineIdentity()
      const startedAt = DateTime.makeUnsafe(yield* Clock.currentTimeMillis)
      const stopping = yield* Ref.make(false)
      const asked = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Ref.set(stopping, true))

      const version = new EngineVersion({
        release: facts.release,
        protocol: protocolVersion,
        // One version, or two from version 2 on: `NonEmptyArray`, as the schema wants it.
        supported: [
          protocolVersion,
          ...supportedVersions(protocolVersion).slice(1),
        ],
      })
      const settings = withSql(storedEngineSettings())

      const status = Effect.fn('Engine.status')(function* (options: {
        readonly clients: number
      }) {
        const [current, projects, isStopping] = yield* Effect.all(
          [settings, withSql(projectCount()), Ref.get(stopping)],
          { concurrency: 'unbounded' },
        )
        return new EngineStatus({
          id,
          release: facts.release,
          startedAt,
          host: facts.host,
          projects,
          // No run or worker is kept by the engine yet: the run loop's tickets count them here.
          runs: 0,
          liveWorkers: 0,
          machineWorkers: Option.getOrElse(current.machine_workers, () =>
            defaultMachineWorkers(facts.host.cores),
          ),
          clients: options.clients,
          stopping: isStopping,
        })
      })

      // The root scope is told from a fiber of its own, which runs once the caller's fiber yields: an
      // RPC handler's fiber writes its answer before it does, so `engine.stop` is answered first.
      const stop = Ref.set(stopping, true).pipe(
        Effect.andThen(Effect.forkDetach(Deferred.succeed(asked, undefined))),
        Effect.asVoid,
        Effect.withSpan('Engine.stop'),
      )

      return Engine.of({
        id,
        version,
        status,
        settings,
        stop,
        stopRequested: Deferred.await(asked),
      })
    }),
  )
