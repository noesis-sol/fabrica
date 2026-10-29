import { Effect } from 'effect'

import { Daemon } from '@fabrica/engine'

import { hostFacts, hostPaths } from './host'

// `fabrica bridge` (spec §19, §8.2): connects stdin and stdout to the local engine's socket, starting
// the engine when it isn't running; what SSH and WSL2 clients run.

/**
 * Starts `fabrica serve` from this same program, detached from the bridge and its terminal, with the
 * bridge's environment: the engine's own environment, from which it builds every command's (§20.2).
 */
const startServe = Effect.suspend(() => {
  const [entry] = process.argv.slice(1)
  return Daemon.startDetached({
    command: process.execPath,
    args: [
      ...process.execArgv,
      ...(entry === undefined ? [] : [entry]),
      'serve',
    ],
    env: process.env,
  })
})

export const bridge = Effect.gen(function* () {
  const paths = yield* hostFacts.pipe(Effect.flatMap(hostPaths))
  yield* Daemon.runBridge({
    socket: paths.socket,
    input: process.stdin,
    output: process.stdout,
    startEngine: startServe,
  })
}).pipe(
  // Its input is let go once the engine has closed the connection, so the process ends.
  Effect.ensuring(Effect.sync(() => process.stdin.destroy())),
)
