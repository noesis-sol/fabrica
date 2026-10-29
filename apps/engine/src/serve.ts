import { Effect } from 'effect'

import { Daemon } from '@fabrica/engine'

import { engineHost, hostPaths } from './host'
import { version } from './version'

// `fabrica serve` (spec §19, §7.1): runs the engine in the foreground, as the login service runs it,
// until `fabrica engine stop` or SIGTERM. A second one on the machine exits, saying an engine runs.

export const serve = Effect.gen(function* () {
  const [paths, host] = yield* Effect.all([hostPaths, engineHost])
  yield* Daemon.serveEngine({ paths, host, release: version })
}).pipe(Effect.scoped)
