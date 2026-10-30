import { Data, Duration, Effect, Option } from 'effect'

import {
  Deadlines,
  ExitStatus,
  ProcessRunner,
  type StartCommand,
  StartFailure,
} from '../process'

// Keeping awake (spec §7.7, H67): while a run goes, the engine keeps its host from idle sleep,
// unless the engine's `keep_awake` is false; an overnight run keeps it awake whatever the setting
// says (§15.6). The engine holds it, not the app, so a run on a remote engine keeps its server awake
// with no client attached. It prevents idle sleep only: a closed lid still sleeps a laptop on battery
// or without an external display, which the run's start says (`startNotices`). tutti kept the
// machine awake only with a flag, and a run started without it slept mid-ticket (tutti-22jf).
//
// The inhibitor is a command held in the run's scope, ended with its tree as the scope closes, and
// watching the engine's own process too, so an engine that dies without closing its scope doesn't
// leave its host awake: `caffeinate -i -w <pid>` on macOS, `systemd-inhibit` holding idle and sleep
// locks for `tail --pid=<pid>` on Linux. The sleep lock is the one that counts there: an idle lock
// stops only logind's own IdleAction, off by default, while a desktop's power manager (GNOME's
// gsd-power) suspends an idle laptop through logind's Suspend, which only a sleep lock refuses, as
// tutti found. Where there is no inhibitor, there is no sleep to prevent. An inhibitor that exits
// within its first second (no logind to ask, a lock refused) holds nothing, and the run says so.

/** The facts about its host keeping awake works from, each read once where the engine starts. */
export interface KeepAwakeHost {
  readonly platform: NodeJS.Platform
  /** The engine's own process ID: the inhibitor ends with it. */
  readonly pid: number
}

/** The engine's own host. */
export const hostKeepAwake = (): KeepAwakeHost => ({
  platform: process.platform,
  pid: process.pid,
})

/** What keeping a run's host awake came to. */
export type KeptAwake = Data.TaggedEnum<{
  /** The inhibitor runs until the run's scope closes. */
  Holding: { readonly command: string; readonly pid: number }
  /** `keep_awake` is false, and the run isn't overnight. */
  NotAsked: {}
  /** The host has no inhibitor: no sleep to prevent (a platform without one, Linux without systemd). */
  NothingToPrevent: {}
  /** The inhibitor didn't start: the host may idle-sleep. */
  Failed: { readonly command: string; readonly reason: string }
  /** The inhibitor started but exited at once, holding nothing: the host may idle-sleep. */
  Ended: { readonly command: string; readonly status: ExitStatus }
}>
export const KeptAwake = Data.taggedEnum<KeptAwake>()

/** The command that keeps `host` from idle sleep while it runs, where it has one. */
export const inhibitorFor = (
  host: KeepAwakeHost,
): Option.Option<StartCommand> => {
  const pid = String(host.pid)
  if (host.platform === 'darwin') {
    return Option.some({
      command: '/usr/bin/caffeinate',
      args: ['-i', '-w', pid],
      cwd: '/',
      stdin: 'null',
    })
  }
  if (host.platform === 'linux') {
    return Option.some({
      command: 'systemd-inhibit',
      args: [
        '--what=idle:sleep',
        '--who=fabrica',
        '--why=A Fabrica run is going',
        '--mode=block',
        'tail',
        `--pid=${pid}`,
        '-f',
        '/dev/null',
      ],
      cwd: '/',
      stdin: 'null',
    })
  }
  return Option.none()
}

/** How long an inhibitor that starts has to exit before it is taken to hold. */
export const inhibitorSettles = Duration.seconds(1)

/** How an inhibitor's exit reads in what the run says of it. */
export const inhibitorExit = (status: ExitStatus): string =>
  ExitStatus.$match(status, {
    Code: ({ code }) => `exit ${code}`,
    Signal: ({ signal }) => signal,
  })

/** Whether a run keeps its host awake: an overnight run always, any other unless `keep_awake` is false. */
export const keepsAwake = (options: {
  readonly keepAwake: boolean
  readonly overnight: boolean
}): boolean => options.overnight || options.keepAwake

/**
 * Keeps `host` from idle sleep until the scope closes, where the run asks it: the scope's end ends
 * the inhibitor's tree. An inhibitor that exits within `inhibitorSettles` of its start holds nothing
 * (`Ended`); one that ends on its own later is logged; the run goes on.
 */
export const keepAwake = Effect.fn('KeepAwake.hold')(function* (options: {
  /** The engine's `keep_awake`. */
  readonly keepAwake: boolean
  readonly overnight: boolean
  readonly host: KeepAwakeHost
}) {
  if (!keepsAwake(options)) return KeptAwake.NotAsked()
  const inhibitor = inhibitorFor(options.host)
  if (Option.isNone(inhibitor)) return KeptAwake.NothingToPrevent()
  const command = inhibitor.value
  const runner = yield* ProcessRunner
  const deadlines = yield* Deadlines
  return yield* runner.start(command).pipe(
    Effect.flatMap(
      Effect.fnUntraced(function* (running) {
        const exited = yield* Effect.raceFirst(
          Effect.map(running.exit, Option.some),
          Effect.as(
            deadlines.sleep(inhibitorSettles),
            Option.none<ExitStatus>(),
          ),
        )
        if (Option.isSome(exited)) {
          return KeptAwake.Ended({
            command: command.command,
            status: exited.value,
          })
        }
        yield* Effect.forkScoped(
          Effect.flatMap(running.exit, status =>
            Effect.logWarning(
              `${command.command} ended by itself (${inhibitorExit(status)}); the host may idle-sleep`,
            ),
          ),
        )
        return KeptAwake.Holding({
          command: command.command,
          pid: running.pid,
        })
      }),
    ),
    Effect.catchTag('StartFailed', ({ reason }) =>
      Effect.succeed(
        StartFailure.$match(reason, {
          NotOnPath: () => KeptAwake.NothingToPrevent(),
          SpawnFailed: ({ message }) =>
            KeptAwake.Failed({ command: command.command, reason: message }),
        }),
      ),
    ),
  )
})
