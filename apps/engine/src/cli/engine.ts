import { Data, DateTime, Effect, Schema } from 'effect'
import { Argument, Command } from 'effect/cli'

import {
  EngineStatus,
  EngineVersion,
  ProtocolVersion,
  ReleaseVersion,
  UpdateStarted,
  protocolVersion,
} from '@fabrica/contracts'

import { version } from '../version'
import { withEngine } from './connect'
import { printAnswer } from './output'
import { sanitiseLine } from './sanitise'

// `fabrica engine status|stop|update|version` (spec §19, §8.1, §9.2): the engine's state, stopping it,
// updating it and its version, with this CLI's beside it. `update [<version>]` has the engine install
// the release named, or the latest, and restart into it once its runs are wound down. Values the engine
// sends are printed one to a line.

/** The engine refused the update, or couldn't have or verify it. */
export class UpdateRefused extends Data.TaggedError('UpdateRefused')<{
  readonly reason: string
}> {
  override get message() {
    return this.reason
  }
}

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

const statusText = (status: EngineStatus): string =>
  [
    `engine    ${sanitiseLine(status.id)}`,
    `release   ${sanitiseLine(status.release)}`,
    `started   ${DateTime.formatIso(status.startedAt)}`,
    `host      ${sanitiseLine(status.host.hostname)} (${status.host.platform} ${sanitiseLine(status.host.arch)}, ${status.host.cores} cores)`,
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
  ({ version }) =>
    withEngine(client => client.rpc['engine.update']({ to: version })).pipe(
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
    ),
).pipe(
  Command.withDescription(
    'Updates the engine, restarting it once its runs are wound down',
  ),
)

export const engine = Command.make('engine').pipe(
  Command.withDescription('The engine'),
  Command.withSubcommands([status, stop, update, engineVersion]),
)
