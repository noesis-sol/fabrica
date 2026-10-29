import { Option, Result } from 'effect'
import * as NodePath from 'node:path'

import { UnsupportedPlatform, absoluteVariable } from '../engine/paths'
import type { ServiceManager } from './outcome'

// The login service (spec §7.1, §12.1, §19): what it runs and the file its manager reads it from, a
// launchd agent on macOS and a systemd user unit on Linux. It runs `fabrica serve` from the `fabrica`
// link the install script makes and an update switches (§9.2), so the service starts the release the
// link names. It carries the installing shell's PATH, so the engine finds the tools its projects' checks
// run, and the XDG folders that place the engine's files (§7.2), so the service's engine and the CLI
// find the same data folder and socket.
//
// Stopped by its manager, the engine alone gets SIGTERM and winds its runs down (§7.1): on Linux,
// `KillMode=mixed` sends SIGTERM to the main process only, then SIGKILL to whatever is left in the
// unit's cgroup once it exits, the backstop of §12.1 (fab-mgi.17). Both managers wait `STOP_TIMEOUT`
// for the wind-down before they kill it, above an agent's release (abort, terminate, reap: 25 s).
// Each restarts the engine where it fails, never where it stopped as asked (`fabrica engine stop`).

/** The launchd agent's label, and its plist's name without `.plist`. */
export const LAUNCHD_LABEL = 'fabrica.engine'

/** The systemd user unit's name. */
export const SYSTEMD_UNIT = 'fabrica.service'

/** How long the manager waits for the engine to wind down before it kills it, in seconds. */
export const STOP_TIMEOUT = 120

/** The installing shell's variables the service carries, where they are set. */
const CARRIED = [
  'PATH',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
] as const

/** The facts about its host the login service works from, each read once where the command starts. */
export interface ServiceHost {
  readonly platform: NodeJS.Platform
  readonly home: string
  /** The user's ID: launchd's domain for the agent is `gui/<uid>`. */
  readonly uid: number
  /** The user's name, which `sudo loginctl enable-linger` names. */
  readonly user: string
  /** The installing shell's environment. */
  readonly environment: Readonly<Record<string, string | undefined>>
}

/** What the service runs, and where. */
export interface ServiceDefinition {
  /** The `fabrica` launcher it runs `serve` with. */
  readonly launcher: string
  readonly home: string
  /** The variables it runs with, by name. */
  readonly environment: Readonly<Record<string, string>>
  /** Where launchd writes the engine's stdout and stderr (systemd's go to the journal). */
  readonly logFile: string
}

/** The command the service runs. */
export const serviceCommand = (
  definition: Pick<ServiceDefinition, 'launcher'>,
): ReadonlyArray<string> => [definition.launcher, 'serve']

/** The variables of `environment` the service carries. */
export const carriedEnvironment = (
  environment: ServiceHost['environment'],
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    CARRIED.flatMap(name => {
      const value = environment[name]
      return value === undefined || value === '' ? [] : [[name, value]]
    }),
  )

/** The manager on `platform`, and the file it reads the service from. */
export const serviceFile = (
  host: Pick<ServiceHost, 'platform' | 'home' | 'environment'>,
): Result.Result<
  { readonly manager: ServiceManager; readonly file: string },
  UnsupportedPlatform
> => {
  switch (host.platform) {
    case 'darwin':
      return Result.succeed({
        manager: 'launchd',
        file: NodePath.join(
          host.home,
          'Library',
          'LaunchAgents',
          `${LAUNCHD_LABEL}.plist`,
        ),
      })
    case 'linux':
      return Result.succeed({
        manager: 'systemd',
        file: NodePath.join(
          Option.getOrElse(
            absoluteVariable(host.environment, 'XDG_CONFIG_HOME'),
            () => NodePath.join(host.home, '.config'),
          ),
          'systemd',
          'user',
          SYSTEMD_UNIT,
        ),
      })
    default:
      return Result.fail(new UnsupportedPlatform({ platform: host.platform }))
  }
}

const xml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')

const xmlString = (text: string): string => `<string>${xml(text)}</string>`

/** The launchd agent's plist. */
export const launchdPlist = (definition: ServiceDefinition): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${xmlString(LAUNCHD_LABEL)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...serviceCommand(definition).map(word => `    ${xmlString(word)}`),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  ${xmlString(definition.home)}`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(definition.environment).flatMap(([name, value]) => [
      `    <key>${xml(name)}</key>`,
      `    ${xmlString(value)}`,
    ]),
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ExitTimeOut</key>',
    `  <integer>${STOP_TIMEOUT}</integer>`,
    '  <key>StandardOutPath</key>',
    `  ${xmlString(definition.logFile)}`,
    '  <key>StandardErrorPath</key>',
    `  ${xmlString(definition.logFile)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')

/** `text` as one quoted word of a unit file: its escapes, and `%` written as the specifier `%%`. */
const unitQuoted = (text: string): string =>
  `"${text
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('%', '%%')}"`

/** A word of `ExecStart=`, where `$` would also name a variable. */
const execWord = (word: string): string =>
  unitQuoted(word).replaceAll('$', '$$$$')

/** The systemd user unit. */
export const systemdUnit = (definition: ServiceDefinition): string =>
  [
    '[Unit]',
    'Description=Fabrica engine',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${serviceCommand(definition).map(execWord).join(' ')}`,
    'WorkingDirectory=%h',
    ...Object.entries(definition.environment).map(
      ([name, value]) => `Environment=${unitQuoted(`${name}=${value}`)}`,
    ),
    'Restart=on-failure',
    'RestartSec=5',
    'KillMode=mixed',
    `TimeoutStopSec=${STOP_TIMEOUT}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
