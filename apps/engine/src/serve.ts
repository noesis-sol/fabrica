import { Effect } from 'effect'
import { fileURLToPath } from 'node:url'

import { Daemon, LoginService, Update } from '@fabrica/engine'

import { engineHost, hostFacts, hostPaths } from './host'
import { agentPlaces, onHost, runHosting } from './hosting'
import { version } from './version'

// `fabrica serve` (spec §19, §7.1, §9.2): runs the engine in the foreground, as the login service runs
// it, until `fabrica engine stop`, `fabrica engine update` or SIGTERM. A second one on the machine exits,
// saying an engine runs. Updated, the engine winds its runs down and ends its scope, releasing its lock,
// and then starts the new release's `fabrica serve` in its place; run by the login service, it exits
// instead, with the code its manager restarts it on, and the manager starts the new release from the
// link the update switched. `--listen <addr>` has it listen over TLS too (§9.3), with the certificate
// `--listen-certificate` and `--listen-key` give, or its own; each flag over the engine's setting of the
// same name. Its runs run on the host (`hosting.ts`): Pi beside the engine, through its model proxy.

export const serve = (flags: Daemon.ListenSettings) =>
  Effect.gen(function* () {
    const facts = yield* hostFacts
    const [paths, host] = yield* Effect.all([
      hostPaths(facts),
      engineHost(facts),
    ])
    const hostEnvironment = { ...process.env }
    const service = LoginService.runningService(hostEnvironment)
    const end = yield* Daemon.serveEngine({
      paths,
      host,
      release: version,
      listen: flags,
      update: Update.layerHost({
        places: Update.installPlaces(facts.home),
        host: { platform: host.platform, arch: host.arch },
      }),
      runs: runHosting(
        onHost({
          paths,
          cores: facts.cores,
          agents: agentPlaces({
            self: fileURLToPath(import.meta.url),
            node: process.execPath,
          }),
          environment: hostEnvironment,
        }),
      ),
    }).pipe(Effect.scoped)
    yield* Daemon.EngineEnd.$match(end, {
      Stop: () => Effect.void,
      Restart: ({ launcher }) =>
        Update.restart({
          launcher,
          cwd: facts.home,
          hostEnvironment,
          service,
        }).pipe(
          Effect.andThen(
            Effect.logInfo(`the engine restarts as ${launcher} serve`),
          ),
        ),
    })
  })
