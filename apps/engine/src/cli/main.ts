import { Cause, Console, Effect } from 'effect'
import {
  CliConfig,
  CliError,
  CliOutput,
  Command,
  Flag,
  GlobalFlag,
} from 'effect/cli'

import { ListenAddressText } from '@fabrica/contracts'

import { bridge } from '../bridge'
import { serve } from '../serve'
import { version } from '../version'
import { answer } from './answer'
import { credentials } from './credentials'
import { engine } from './engine'
import { EngineName, Json } from './flags'
import { follow } from './follow'
import { init } from './init'
import { insights } from './insights'
import { project } from './project'
import { report } from './report'
import { requires } from './requires'
import { run } from './run'
import { sanitisingConsole } from './sanitise'
import { service } from './service'
import { talk } from './talk'
import { tickets } from './tickets'
import { token } from './token'

// The `fabrica` command (spec §19): every command group of §19, each in its own file, under one root that
// takes `--json` and `--engine <name>` anywhere on the line. Flags take two dashes, their one-letter
// shorthands one; `--help` (`-h`) and `--version` are built in. Everything the CLI prints, the help and
// its errors included, goes through its console, which sanitises it for the terminal.

const serveCommand = Command.make(
  'serve',
  {
    listen: Flag.String('listen').pipe(
      Flag.withDescription(
        'Listens over TLS on this address too, such as 0.0.0.0:8443 or :8443, for clients with a pairing token',
      ),
      Flag.withSchema(ListenAddressText),
      Flag.optional,
    ),
    listen_certificate: Flag.String('listen-certificate').pipe(
      Flag.withDescription(
        "The TLS listener's certificate, a PEM file; the engine's own where none is given",
      ),
      Flag.optional,
    ),
    listen_key: Flag.String('listen-key').pipe(
      Flag.withDescription("The certificate's private key, a PEM file"),
      Flag.optional,
    ),
  },
  serve,
).pipe(
  Command.withDescription(
    'Runs the engine in the foreground, as the login service runs it',
  ),
)

const bridgeCommand = Command.make('bridge', {}, () => bridge).pipe(
  Command.withDescription(
    "Connects stdin and stdout to the local engine's socket, starting the engine when it isn't running",
  ),
)

export const fabrica = Command.make('fabrica').pipe(
  Command.withDescription(
    'Runs a backlog of tickets with several coding agents side by side',
  ),
  Command.withSubcommands([
    serveCommand,
    bridgeCommand,
    service,
    engine,
    token,
    credentials,
    project,
    init,
    run,
    follow,
    answer,
    talk,
    tickets,
    requires,
    report,
    insights,
  ]),
  Command.withGlobalFlags([Json, EngineName]),
)

/** The CLI's own built-in flags: `--help` and `--version`; no wizard, no completions. */
const builtIns = CliConfig.layer({
  builtIns: [GlobalFlag.Help, GlobalFlag.Version],
})

/** Help and errors in plain text: colours would be escape sequences, which the console shows escaped. */
const plainOutput = CliOutput.layer(
  CliOutput.defaultFormatter({ colors: false }),
)

/**
 * Runs the command `args` give (the words after `fabrica`), printing through the current console,
 * sanitised. A failure is printed as it happens (a usage error with the help) and fails the run.
 */
export const runCli = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const console = yield* Console.Console
    return yield* Command.runWith(fabrica, { version })(args).pipe(
      Effect.tapError(error =>
        // The command line's own errors are printed with the help as they are found.
        CliError.isCliError(error)
          ? Effect.void
          : Console.error(`fabrica: ${error.message}`),
      ),
      Effect.tapCause(cause =>
        Cause.hasDies(cause) ? Console.error(Cause.pretty(cause)) : Effect.void,
      ),
      Effect.provideService(Console.Console, sanitisingConsole(console)),
      Effect.provide([builtIns, plainOutput]),
    )
  })
