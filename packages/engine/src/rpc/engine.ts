import { Effect } from 'effect'
import { RpcServer } from 'effect/rpc'

import {
  EngineHello,
  EngineRpcs,
  negotiate,
  protocolVersion,
} from '@fabrica/contracts'

import { Engine } from '../engine/service'
import { notImplemented } from './not-implemented'

// The Engine group's handlers (spec §8.1, §8.4, §7.1): the handshake, the engine's version, status
// and settings, and its stop, on the daemon's Engine service and the server's connections. Updating
// and the status and load streams are their own tickets'.

/** The Engine group's handlers. */
export const engineHandlers = EngineRpcs.toLayer(
  Effect.gen(function* () {
    const engine = yield* Engine
    const protocol = yield* RpcServer.Protocol
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
      'engine.update': notImplemented('engine.update'),
      'engine.watchStatus': notImplemented('engine.watchStatus'),
      'engine.watchLoad': notImplemented('engine.watchLoad'),
    })
  }),
)
