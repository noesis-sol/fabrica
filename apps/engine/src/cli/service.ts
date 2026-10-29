import { Effect, Layer } from 'effect'
import { Command } from 'effect/cli'
import { userInfo } from 'node:os'
import * as NodePath from 'node:path'

import { Daemon, LoginService, Process, Update } from '@fabrica/engine'

import { hostFacts, hostPaths } from '../host'
import { printAnswer } from './output'

// `fabrica service install|uninstall|status` (spec §19, §7.1): the login service that runs `fabrica
// serve`, a launchd agent on macOS and a systemd user unit on Linux, run from the `fabrica` link the
// install script makes (§9.2), with the PATH and XDG folders of the shell that installs it. Installing
// on Linux enables the user's linger, so the engine runs without a login session, and says how to
// enable it with sudo where logind refuses. Its commands are run on this host, not through the engine.

/** The commands the login service runs, on this host's process runner. */
const runner = Process.layerHost.pipe(Layer.provide(Process.layerClock))

/** The host's facts the login service works from, read once as the command starts. */
const serviceHost = Effect.gen(function* () {
  const facts = yield* hostFacts
  const uid = process.getuid?.()
  if (uid === undefined) {
    return yield* new Daemon.UnsupportedPlatform({ platform: process.platform })
  }
  const host: LoginService.ServiceHost = {
    platform: process.platform,
    home: facts.home,
    uid,
    user: userInfo().username,
    environment: { ...process.env },
  }
  return { facts, host }
})

const managerName = (manager: LoginService.ServiceManager): string =>
  manager === 'launchd'
    ? `the launchd agent ${LoginService.LAUNCHD_LABEL}`
    : `the systemd user unit ${LoginService.SYSTEMD_UNIT}`

/** `install`'s answer as text. */
export const installedText = (
  installed: LoginService.ServiceInstalled,
): string =>
  LoginService.ServiceInstalled.match(installed, {
    launchd: ({ file, command }) =>
      [
        `installed ${managerName('launchd')}: ${file}`,
        `it runs ${command.join(' ')} now and at every login`,
      ].join('\n'),
    systemd: ({ file, command, linger }) =>
      [
        `installed ${managerName('systemd')}: ${file}`,
        `it runs ${command.join(' ')} now and whenever the user manager starts`,
        LoginService.Linger.match(linger, {
          Enabled: () =>
            'linger is enabled: the engine starts at boot and runs without a login session',
          Refused: ({ reason, remedy }) =>
            `linger isn't enabled (${reason}): the engine runs only while you are logged in; enable it with: ${remedy}`,
        }),
      ].join('\n'),
  })

/** `uninstall`'s answer as text. */
export const uninstalledText = ({
  manager,
  file,
  removed,
}: LoginService.ServiceUninstalled): string =>
  removed
    ? `stopped and removed ${managerName(manager)}: ${file}`
    : `no login service was installed: ${file} isn't there`

/** `status`'s answer as text. */
export const statusText = ({
  manager,
  file,
  installed,
  state,
}: LoginService.ServiceStatus): string =>
  [
    `service    ${managerName(manager)}`,
    `file       ${file}`,
    `installed  ${installed ? 'yes' : 'no'}`,
    `engine     ${LoginService.ServiceState.match(state, {
      Running: ({ pid }) => `running (pid ${pid})`,
      Stopped: ({ state }) => `not running (${state})`,
      NotLoaded: () => `not loaded by ${manager}`,
    })}`,
  ].join('\n')

const install = Command.make('install', {}, () =>
  Effect.gen(function* () {
    const { facts, host } = yield* serviceHost
    const paths = yield* hostPaths(facts)
    // launchd opens the log file before it starts the engine, so its folder is made first.
    yield* Daemon.prepareFolders(paths)
    const installed = yield* LoginService.install({
      host,
      definition: {
        launcher: Update.installPlaces(facts.home).link,
        home: facts.home,
        environment: LoginService.carriedEnvironment(host.environment),
        logFile: NodePath.join(paths.logs, 'service.log'),
      },
    })
    yield* printAnswer({
      schema: LoginService.ServiceInstalled,
      value: installed,
      text: installedText,
    })
  }).pipe(Effect.provide(runner)),
).pipe(
  Command.withDescription(
    'Installs and starts the login service that runs the engine',
  ),
)

const uninstall = Command.make('uninstall', {}, () =>
  Effect.gen(function* () {
    const { host } = yield* serviceHost
    yield* printAnswer({
      schema: LoginService.ServiceUninstalled,
      value: yield* LoginService.uninstall(host),
      text: uninstalledText,
    })
  }).pipe(Effect.provide(runner)),
).pipe(Command.withDescription('Stops and removes the login service'))

const status = Command.make('status', {}, () =>
  Effect.gen(function* () {
    const { host } = yield* serviceHost
    yield* printAnswer({
      schema: LoginService.ServiceStatus,
      value: yield* LoginService.status(host),
      text: statusText,
    })
  }).pipe(Effect.provide(runner)),
).pipe(
  Command.withDescription(
    'Whether the login service is installed, and whether its engine runs',
  ),
)

export const service = Command.make('service').pipe(
  Command.withDescription('The login service'),
  Command.withSubcommands([install, uninstall, status]),
)
