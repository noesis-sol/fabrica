import { Effect, Option, Schema } from 'effect'

import { mainPortEnd } from './port'
import { engineSocket, relay } from './relay'
import { ConnectionTarget } from './target'

// The connection process (spec §5, §8.2), Electron's utilityProcess: main sends it, for each page it
// brokers, one end of the page's port with the engine to reach, and it relays the port to that
// engine until the port closes. It renders nothing and touches no repository.

const decodeTarget = Schema.decodeUnknownOption(ConnectionTarget)

process.parentPort.on('message', event => {
  const [port] = event.ports
  if (port === undefined || event.ports.length !== 1) {
    return
  }
  Option.match(decodeTarget(event.data), {
    onNone: () => port.close(),
    onSome: target =>
      Effect.runFork(
        relay({ port: mainPortEnd(port), engine: engineSocket(target) }).pipe(
          Effect.ensuring(Effect.sync(() => port.close())),
        ),
      ),
  })
})
