import { Effect, Option, Semaphore } from 'effect'
import { RpcServer } from 'effect/rpc'

import {
  EngineHello,
  EngineRpcs,
  type ReleaseVersion,
  UpdateStarted,
  negotiate,
  protocolVersion,
} from '@fabrica/contracts'

import { Engine } from '../engine/service'
import { UpdateFailure, updateFailed } from '../update/failure'
import { Updater } from '../update/service'
import { notImplemented } from './not-implemented'

// The Engine group's handlers (spec §8.1, §8.4, §7.1, §9.2): the handshake, the engine's version,
// status and settings, its stop, and its update, on the daemon's Engine service, its Updater and the
// server's connections. An update installs the release (verified, unpacked, linked) and answers once it
// has, then restarts the engine as a stop would, its runs wound down first; one update at a time, and
// none once the engine is stopping. The status and load streams are their own tickets'.

/** The Engine group's handlers. */
export const engineHandlers = EngineRpcs.toLayer(
  Effect.gen(function* () {
    const engine = yield* Engine
    const updater = yield* Updater
    const protocol = yield* RpcServer.Protocol
    const updates = yield* Semaphore.make(1)
    const from = engine.version.release

    const install = Effect.fn('Engine.update')(function* (
      release: Option.Option<ReleaseVersion>,
    ) {
      if (yield* engine.stopping)
        return yield* Effect.fail(
          UpdateFailure.Refused({ why: 'the engine is stopping' }),
        )
      const installed = yield* updater.install({ current: from, release })
      yield* engine.restart(installed.launcher)
      return new UpdateStarted({ from, to: installed.version })
    })

    const update = (release: Option.Option<ReleaseVersion>) =>
      updates
        .withPermitsIfAvailable(1)(install(release))
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  UpdateFailure.Refused({
                    why: 'an update is under way already',
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
          Effect.mapError(updateFailed),
        )

    return EngineRpcs.of({
      'engine.connect': hello =>
        Effect.fromResult(
          negotiate({ client: hello.protocol, engine: protocolVersion }),
        ).pipe(
          Effect.map(
            protocol =>
              new EngineHello({
                protocol,
                engine: engine.id,
                release: engine.version.release,
              }),
          ),
        ),
      'engine.version': () => Effect.succeed(engine.version),
      'engine.status': () =>
        protocol.clientIds.pipe(
          Effect.flatMap(clients => engine.status({ clients: clients.size })),
          Effect.orDie,
        ),
      'engine.settings': () => Effect.orDie(engine.settings),
      'engine.stop': () => engine.stop,
      'engine.update': ({ to }) => update(to),
      'engine.watchStatus': notImplemented('engine.watchStatus'),
      'engine.watchLoad': notImplemented('engine.watchLoad'),
    })
  }),
)
