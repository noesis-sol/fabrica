import { Context, Data, DateTime, Effect, Layer, Option, Schema } from 'effect'
import { Argument, Command } from 'effect/cli'

import {
  EngineStatus,
  EngineVersion,
  type Host,
  ProtocolVersion,
  ReleaseVersion,
  UpdateStarted,
  formatListenAddress,
  protocolVersion,
} from '@fabrica/contracts'
import { Daemon, Update } from '@fabrica/engine'

import { engineHost, hostFacts } from '../host'
import { version } from '../version'
import { withEngine } from './connect'
import { printAnswer } from './output'
import { sanitiseLine } from './sanitise'

// `fabrica engine status|stop|update|version` (spec §19, §8.1, §9.2): the engine's state, stopping it,
// updating it and its version, with this CLI's beside it. `update [<version>]` has the engine install
// the release named, or the latest, and restart into it once its runs are wound down; where no local
// engine answers on its socket, the CLI installs the release itself, as the engine would, and restarts
// nothing: the next `fabrica serve` runs it. Values the engine sends are printed one to a line.

/** The engine refused the update, or couldn't have or verify it. */
export class UpdateRefused extends Data.TaggedError('UpdateRefused')<{
  readonly reason: string
}> {
  override get message() {
    return this.reason
  }
}

/** The Updater of this host's install, for an update where no engine runs; a test gives a fixture's. */
export const LocalUpdater = Context.Reference<{
  readonly updater: Layer.Layer<
    Update.Updater,
    Daemon.UnsupportedPlatform,
    Host
  >
}>('@fabrica/engine-app/LocalUpdater', {
  defaultValue: () => ({
    updater: Layer.unwrap(
      Effect.gen(function* () {
        const facts = yield* hostFacts
        const host = yield* engineHost(facts)
        return Update.layerHost({
          places: Update.installPlaces(facts.home),
          host: { platform: host.platform, arch: host.arch },
        })
      }),
    ),
  }),
})

/** `fabrica engine version`'s answer: this CLI's release and protocol, and the engine's. */
const VersionAnswer = Schema.Struct({
  cli: Schema.Struct({ release: ReleaseVersion, protocol: ProtocolVersion }),
  engine: EngineVersion,
})

const versionText = (answer: typeof VersionAnswer.Type): string =>
  [
    `fabrica ${sanitiseLine(answer.cli.release)} (protocol ${answer.cli.protocol})`,
    `engine  ${sanitiseLine(answer.engine.release)} (protocol ${answer.engine.protocol}, speaks ${answer.engine.supported.join(', ')})`,
  ].join('\n')

/** Where the engine listens over TLS and its certificate's fingerprint, the user to compare it with the app's at pairing (§9.3). */
const listeningText = (
  listening: EngineStatus['listening'],
): ReadonlyArray<string> =>
  Option.match(listening, {
    onNone: () => ['listens   on its local socket only'],
    onSome: ({ address, fingerprint }) => [
      `listens   ${sanitiseLine(formatListenAddress(address))} over TLS`,
      `          certificate SHA-256 ${fingerprint}`,
    ],
  })

const statusText = (status: EngineStatus): string =>
  [
    `engine    ${sanitiseLine(status.id)}`,
    `release   ${sanitiseLine(status.release)}`,
    `started   ${DateTime.formatIso(status.startedAt)}`,
    `host      ${sanitiseLine(status.host.hostname)} (${status.host.platform} ${sanitiseLine(status.host.arch)}, ${status.host.cores} cores)`,
    ...listeningText(status.listening),
    `projects  ${status.projects}`,
    `runs      ${status.runs}`,
    `workers   ${status.liveWorkers} of ${status.machineWorkers}`,
    `clients   ${status.clients}`,
    `stopping  ${status.stopping ? 'yes' : 'no'}`,
  ].join('\n')

/** `fabrica engine stop`'s answer. */
const StopAnswer = Schema.Struct({ stopping: Schema.Boolean })

const engineVersion = Command.make('version', {}, () =>
  withEngine(client => client.rpc['engine.version']()).pipe(
    Effect.flatMap(engine =>
      printAnswer({
        schema: VersionAnswer,
        value: { cli: { release: version, protocol: protocolVersion }, engine },
        text: versionText,
      }),
    ),
  ),
).pipe(Command.withDescription("The engine's version and this fabrica's"))

const status = Command.make('status', {}, () =>
  withEngine(client => client.rpc['engine.status']()).pipe(
    Effect.flatMap(value =>
      printAnswer({ schema: EngineStatus, value, text: statusText }),
    ),
  ),
).pipe(Command.withDescription("The engine's state"))

const stop = Command.make('stop', {}, () =>
  withEngine(client => client.rpc['engine.stop']()).pipe(
    Effect.andThen(
      printAnswer({
        schema: StopAnswer,
        value: { stopping: true },
        text: () => 'the engine is winding its runs down and stopping',
      }),
    ),
  ),
).pipe(Command.withDescription('Winds the runs down and stops the engine'))

const updateText = (started: UpdateStarted): string =>
  `the engine installed ${sanitiseLine(started.to)}, and restarts into it from ${sanitiseLine(started.from)} once its runs are wound down`

/** `fabrica engine update`'s answer where no engine runs: the release installed, and its launcher. */
const InstalledAnswer = Schema.Struct({
  from: ReleaseVersion,
  to: ReleaseVersion,
  launcher: Schema.String,
})

const installedText = (installed: typeof InstalledAnswer.Type): string =>
  `no engine was running: fabrica installed ${sanitiseLine(installed.to)} in place of ${sanitiseLine(installed.from)}, and the next \`fabrica serve\` runs it`

/** Installs `release`, or the latest, on this host, as the engine would: for where no engine runs. */
const installHere = (release: Option.Option<ReleaseVersion>) =>
  Effect.gen(function* () {
    const { updater } = yield* LocalUpdater
    const installed = yield* Update.Updater.use(service =>
      service.install({ current: version, release }),
    ).pipe(
      Effect.mapError(
        failure =>
          new UpdateRefused({
            reason: `the engine wasn't updated: ${sanitiseLine(Update.describeFailure(failure))}`,
          }),
      ),
      Effect.provide(updater),
    )
    return yield* printAnswer({
      schema: InstalledAnswer,
      value: {
        from: version,
        to: installed.version,
        launcher: installed.launcher,
      },
      text: installedText,
    })
  })

const update = Command.make(
  'update',
  {
    version: Argument.String('version').pipe(
      Argument.withDescription(
        'The release to update to, such as 0.2.0; the latest where none is given',
      ),
      Argument.withSchema(ReleaseVersion),
      Argument.optional,
    ),
  },
  ({ version: release }) =>
    withEngine(client => client.rpc['engine.update']({ to: release })).pipe(
      Effect.catchTag('UpdateFailed', ({ reason }) =>
        Effect.fail(
          new UpdateRefused({
            reason: `the engine wasn't updated: ${sanitiseLine(reason)}`,
          }),
        ),
      ),
      Effect.flatMap(value =>
        printAnswer({ schema: UpdateStarted, value, text: updateText }),
      ),
      Effect.catchTag('EngineUnreachable', () => installHere(release)),
    ),
).pipe(
  Command.withDescription(
    'Updates the engine, restarting it once its runs are wound down; installs the release where no engine runs',
  ),
)

export const engine = Command.make('engine').pipe(
  Command.withDescription('The engine'),
  Command.withSubcommands([status, stop, update, engineVersion]),
)
