import { Duration, Effect, Option } from 'effect'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import {
  CommandOutcome,
  ExitStatus,
  ProcessRunner,
  StartFailure,
  findOnPath,
} from '../process'
import {
  LAUNCHD_LABEL,
  STOP_TIMEOUT,
  SYSTEMD_UNIT,
  type ServiceDefinition,
  type ServiceHost,
  launchdPlist,
  serviceCommand,
  serviceFile,
  systemdUnit,
} from './definition'
import {
  LauncherMissing,
  Linger,
  ServiceFailed,
  ServiceInstalled,
  type ServiceManager,
  ServiceState,
  type ServiceStatus,
  type ServiceUninstalled,
} from './outcome'

// `fabrica service install|uninstall|status` (spec §7.1, §19) against the host's service manager:
// launchd's `launchctl` in the user's `gui/<uid>` domain on macOS, `systemctl --user` on Linux, each run
// through the engine's process runner. Installing writes the service's file, replacing one there, and
// (re)starts the service from it; on Linux it also enables the user's linger, so the engine runs
// without a login session and starts at boot, and says how to enable it with sudo where logind
// refuses. Uninstalling stops the service and removes its file, leaving the linger as it is, since
// other user units may need it.

/** How long one `launchctl` or `systemctl` may take: a stop waits on the engine's wind-down. */
const TIME_LIMIT = Duration.seconds(STOP_TIMEOUT + 30)

/** A manager's command that ran to its end. */
interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** What a command that failed said: its stderr, else its stdout, else its exit code. */
const said = (command: string, ran: Ran): string =>
  [ran.stderr.trim(), ran.stdout.trim()].find(text => text !== '') ??
  `${command} exited ${ran.code}`

/** Runs a manager's command for `step`, failing only where it didn't run to an exit code. */
const manage = Effect.fn('LoginService.manage')(function* ({
  step,
  command,
  args,
  home,
}: {
  readonly step: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly home: string
}) {
  const runner = yield* ProcessRunner
  const outcome = yield* runner.run({
    command,
    args,
    cwd: home,
    timeLimit: TIME_LIMIT,
  })
  const failed = (reason: string) =>
    Effect.fail(new ServiceFailed({ step, reason }))
  return yield* CommandOutcome.$match(outcome, {
    Exited: ({ status, stdout, stderr }) =>
      ExitStatus.$match(status, {
        Code: ({ code }): Effect.Effect<Ran, ServiceFailed> =>
          Effect.succeed({ code, stdout, stderr }),
        Signal: ({ signal }) => failed(`${command} was ended by ${signal}`),
      }),
    TimedOut: () =>
      failed(`${command} didn't finish within ${Duration.format(TIME_LIMIT)}`),
    Cut: ({ stream }) => failed(`${command} wrote too much to ${stream}`),
    FailedToStart: ({ reason }) =>
      failed(
        StartFailure.$match(reason, {
          NotOnPath: ({ path }) => `${command} isn't on the PATH (${path})`,
          SpawnFailed: ({ message }) => message,
        }),
      ),
  })
})

/** Runs a manager's command for `step`, failing where it exits other than 0. */
const succeed = (options: Parameters<typeof manage>[0]) =>
  manage(options).pipe(
    Effect.flatMap(ran =>
      ran.code === 0
        ? Effect.succeed(ran)
        : Effect.fail(
            new ServiceFailed({
              step: options.step,
              reason: said(options.command, ran),
            }),
          ),
    ),
  )

const fileFailed = (step: string) => (cause: unknown) =>
  new ServiceFailed({
    step,
    reason: cause instanceof Error ? cause.message : String(cause),
  })

/** Whether `file` is there. */
const exists = (file: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    lstat(file).then(
      () => true,
      () => false,
    ),
  )

/** Writes `text` to `file` whole, through a file beside it, so the manager never reads half of it. */
const writeWhole = ({
  file,
  text,
}: {
  readonly file: string
  readonly text: string
}) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(NodePath.dirname(file), { recursive: true })
      const next = `${file}.${process.pid}.new`
      await writeFile(next, text, { mode: 0o644 })
      await rename(next, file)
    },
    catch: fileFailed(`write ${file}`),
  })

const remove = (file: string) =>
  Effect.tryPromise({
    try: () => rm(file, { force: true }),
    catch: fileFailed(`remove ${file}`),
  })

/** One manager's commands, over a host. */
interface Manager {
  readonly install: (options: {
    readonly file: string
    readonly definition: ServiceDefinition
  }) => Effect.Effect<ServiceInstalled, ServiceFailed, ProcessRunner>
  readonly uninstall: (
    file: string,
  ) => Effect.Effect<boolean, ServiceFailed, ProcessRunner>
  readonly state: Effect.Effect<ServiceState, ServiceFailed, ProcessRunner>
}

/** A top-level property of `launchctl print`'s answer, indented by one tab. */
const printed = (output: string, name: string): Option.Option<string> =>
  Option.fromNullishOr(
    new RegExp(`^\\t${name} = (.+)$`, 'mu').exec(output)?.[1],
  )

const launchd = (host: ServiceHost): Manager => {
  const domain = `gui/${host.uid}`
  const target = `${domain}/${LAUNCHD_LABEL}`
  const launchctl = (step: string, args: ReadonlyArray<string>) => ({
    step,
    command: 'launchctl',
    args,
    home: host.home,
  })
  /** `launchctl print`'s answer, where launchd has the agent. */
  const loaded = manage(launchctl(`read ${target}`, ['print', target])).pipe(
    Effect.map(ran =>
      ran.code === 0 ? Option.some(ran.stdout) : Option.none<string>(),
    ),
  )
  const bootout = loaded.pipe(
    Effect.flatMap(answer =>
      Option.isSome(answer)
        ? succeed(launchctl(`stop ${target}`, ['bootout', target])).pipe(
            Effect.as(true),
          )
        : Effect.succeed(false),
    ),
  )
  return {
    install: ({ file, definition }) =>
      Effect.gen(function* () {
        yield* writeWhole({ file, text: launchdPlist(definition) })
        yield* bootout
        yield* succeed(launchctl(`enable ${target}`, ['enable', target]))
        yield* succeed(launchctl(`load ${file}`, ['bootstrap', domain, file]))
        return ServiceInstalled.cases.launchd.make({
          file,
          command: serviceCommand(definition),
        })
      }),
    uninstall: file =>
      Effect.gen(function* () {
        const [wasLoaded, wasThere] = yield* Effect.all(
          [bootout, exists(file)],
          { concurrency: 'unbounded' },
        )
        yield* remove(file)
        return wasLoaded || wasThere
      }),
    state: loaded.pipe(
      Effect.map(answer =>
        Option.match(answer, {
          onNone: () => ServiceState.cases.NotLoaded.make({}),
          onSome: output =>
            Option.match(
              Option.filter(
                Option.map(printed(output, 'pid'), Number),
                Number.isSafeInteger,
              ),
              {
                onSome: pid => ServiceState.cases.Running.make({ pid }),
                onNone: () =>
                  ServiceState.cases.Stopped.make({
                    state: Option.getOrElse(
                      printed(output, 'state'),
                      () => 'not running',
                    ),
                  }),
              },
            ),
        }),
      ),
    ),
  }
}

/** `systemctl show`'s `Name=value` lines, by name. */
const properties = (output: string): ReadonlyMap<string, string> =>
  new Map(
    output.split('\n').flatMap(line => {
      const equals = line.indexOf('=')
      return equals === -1
        ? []
        : [[line.slice(0, equals), line.slice(equals + 1)] as const]
    }),
  )

const systemd = (host: ServiceHost): Manager => {
  const systemctl = (step: string, args: ReadonlyArray<string>) =>
    succeed({
      step,
      command: 'systemctl',
      args: ['--user', ...args],
      home: host.home,
    })
  const reload = systemctl('reload the user units', ['daemon-reload'])
  const remedy = `sudo loginctl enable-linger ${host.user}`
  const linger = manage({
    step: 'enable linger',
    command: 'loginctl',
    args: ['enable-linger'],
    home: host.home,
  }).pipe(
    Effect.map(ran =>
      ran.code === 0
        ? Linger.cases.Enabled.make({})
        : Linger.cases.Refused.make({
            reason: said('loginctl', ran),
            remedy,
          }),
    ),
    Effect.catchTag('ServiceFailed', ({ reason }) =>
      Effect.succeed(Linger.cases.Refused.make({ reason, remedy })),
    ),
  )
  return {
    install: ({ file, definition }) =>
      Effect.gen(function* () {
        yield* writeWhole({ file, text: systemdUnit(definition) })
        yield* reload
        yield* systemctl(`enable ${SYSTEMD_UNIT}`, ['enable', SYSTEMD_UNIT])
        yield* systemctl(`start ${SYSTEMD_UNIT}`, ['restart', SYSTEMD_UNIT])
        return ServiceInstalled.cases.systemd.make({
          file,
          command: serviceCommand(definition),
          linger: yield* linger,
        })
      }),
    uninstall: file =>
      Effect.gen(function* () {
        if (!(yield* exists(file))) return false
        yield* systemctl(`stop ${SYSTEMD_UNIT}`, [
          'disable',
          '--now',
          SYSTEMD_UNIT,
        ])
        yield* remove(file)
        yield* reload
        return true
      }),
    state: systemctl(`read ${SYSTEMD_UNIT}`, [
      'show',
      SYSTEMD_UNIT,
      '--property=LoadState,ActiveState,SubState,MainPID',
    ]).pipe(
      Effect.map(({ stdout }) => {
        const shown = properties(stdout)
        const load = shown.get('LoadState')
        const active = shown.get('ActiveState') ?? 'unknown'
        const pid = Number(shown.get('MainPID'))
        if (load === undefined || load === 'not-found') {
          return ServiceState.cases.NotLoaded.make({})
        }
        if (active === 'active' && Number.isSafeInteger(pid) && pid > 0) {
          return ServiceState.cases.Running.make({ pid })
        }
        const sub = shown.get('SubState')
        return ServiceState.cases.Stopped.make({
          state: sub === undefined ? active : `${active} (${sub})`,
        })
      }),
    ),
  }
}

const MANAGERS: Readonly<
  Record<ServiceManager, (host: ServiceHost) => Manager>
> = { launchd, systemd }

/** The host's manager, and the service's file. */
const managerOn = (host: ServiceHost) =>
  Effect.fromResult(serviceFile(host)).pipe(
    Effect.map(({ manager, file }) => ({
      manager,
      file,
      commands: MANAGERS[manager](host),
    })),
  )

/**
 * Installs the login service running `definition`'s launcher, which must be an executable file, and
 * starts it; a service installed before is replaced and restarted.
 */
export const install = Effect.fn('LoginService.install')(function* ({
  host,
  definition,
}: {
  readonly host: ServiceHost
  readonly definition: ServiceDefinition
}) {
  const { file, commands } = yield* managerOn(host)
  const launcher = yield* findOnPath({
    command: definition.launcher,
    path: '',
    cwd: host.home,
  })
  if (Option.isNone(launcher)) {
    return yield* new LauncherMissing({ launcher: definition.launcher })
  }
  return yield* commands.install({ file, definition })
})

/** Stops the login service and removes its file, where it is installed. */
export const uninstall = Effect.fn('LoginService.uninstall')(function* (
  host: ServiceHost,
) {
  const { manager, file, commands } = yield* managerOn(host)
  const removed = yield* commands.uninstall(file)
  return { manager, file, removed } satisfies ServiceUninstalled
})

/** Whether the login service is installed, and whether its engine runs. */
export const status = Effect.fn('LoginService.status')(function* (
  host: ServiceHost,
) {
  const { manager, file, commands } = yield* managerOn(host)
  const [installed, state] = yield* Effect.all([exists(file), commands.state], {
    concurrency: 'unbounded',
  })
  return { manager, file, installed, state } satisfies ServiceStatus
})
