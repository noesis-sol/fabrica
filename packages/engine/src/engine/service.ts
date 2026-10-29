import {
  Clock,
  Context,
  Data,
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

// The Engine service (spec §7.1, §8.1, §9.2): the engine's identity, version, status and settings, and
// its stop. Stopping asks the engine's root scope to end, which winds the runs down, then the agents,
// then the servers (`EngineScopes`); from the moment it is asked, the engine's status says so. A
// restart into an update stops it the same way, and says which launcher starts the engine after it.

/** What the engine does once its root scope has ended: stop, or start the updated engine's launcher. */
export type EngineEnd = Data.TaggedEnum<{
  Stop: {}
  Restart: { readonly launcher: string }
}>
export const EngineEnd = Data.taggedEnum<EngineEnd>()

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
  /**
   * Asks the engine to stop, as `stop` does, and then to start `launcher serve` in its place (§9.2).
   * Where it was asked to stop already, it stops.
   */
  readonly restart: (launcher: string) => Effect.Effect<void>
  /** Whether the engine has been asked to stop, or its scope is ending. */
  readonly stopping: Effect.Effect<boolean>
  /** Waits until the engine is asked to stop; what it does once it has stopped. */
  readonly stopRequested: Effect.Effect<EngineEnd>
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
      const asked = yield* Deferred.make<EngineEnd>()
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
      // RPC handler's fiber writes its answer before it does, so `engine.stop` is answered first. The
      // first ask holds: a restart asked after a stop stops.
      const end = (then: EngineEnd) =>
        Ref.set(stopping, true).pipe(
          Effect.andThen(Effect.forkDetach(Deferred.succeed(asked, then))),
          Effect.asVoid,
        )
      const stop = end(EngineEnd.Stop()).pipe(Effect.withSpan('Engine.stop'))
      const restart = (launcher: string) =>
        end(EngineEnd.Restart({ launcher })).pipe(
          Effect.withSpan('Engine.restart'),
        )

      return Engine.of({
        id,
        version,
        status,
        settings,
        stop,
        restart,
        stopping: Ref.get(stopping),
        stopRequested: Deferred.await(asked),
      })
    }),
  )
