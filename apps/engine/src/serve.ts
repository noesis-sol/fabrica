import { Effect, Option, Stdio } from 'effect'
import { fileURLToPath } from 'node:url'

import { Daemon, LoginService, Update } from '@fabrica/engine'

import { engineHost, hostFacts, hostPaths } from './host'
import { agentPlaces, onHost, runHosting } from './hosting'
import { passphraseSource, terminalAsk } from './passphrase'
import { version } from './version'

// `fabrica serve` (spec §19, §7.1, §9.2): runs the engine in the foreground, as the login service runs
// it, until `fabrica engine stop`, `fabrica engine update` or SIGTERM. A second one on the machine exits,
// saying an engine runs. Updated, the engine winds its runs down and ends its scope, releasing its lock,
// and then starts the new release's `fabrica serve` in its place; run by the login service, it exits
// instead, with the code its manager restarts it on, and the manager starts the new release from the
// link the update switched. `--listen <addr>` has it listen over TLS too (§9.3), with the certificate
// `--listen-certificate` and `--listen-key` give, or its own; each flag over the engine's setting of the
// same name, and given again to the release it restarts as, with the engine's environment. Its runs run on the host (`hosting.ts`): Pi beside the engine, through its model proxy.
// Where no keyring answers, its secret store's passphrase is read from `--passphrase-file`, or else
// typed at a prompt where it runs on a terminal (`passphrase.ts`, §20.3).

export const serve = (flags: Update.ServeFlags) =>
  Effect.gen(function* () {
    const facts = yield* hostFacts
    const [paths, host] = yield* Effect.all([
      hostPaths(facts),
      engineHost(facts),
    ])
    const hostEnvironment = { ...process.env }
    const onTerminal = yield* Effect.flatMap(
      Stdio.Stdio,
      stdio => stdio.stdinIsTerminal,
    )
    const passphrase = passphraseSource({
      file: flags.passphrase_file,
      prompt: onTerminal ? Option.some(yield* terminalAsk) : Option.none(),
    })
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
          self: fileURLToPath(import.meta.url),
          release: version,
          totalMemory: facts.memoryBytes,
          passphrase,
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
          flags,
          service,
        }).pipe(
          Effect.andThen(
            Effect.logInfo(`the engine restarts as ${launcher} serve`),
          ),
        ),
    })
  })
