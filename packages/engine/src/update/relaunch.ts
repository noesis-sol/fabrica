import { Data, Effect, Option, Runtime } from 'effect'
import { spawn } from 'node:child_process'

import { formatListenAddress } from '@fabrica/contracts'

import { type ListenSettings, absoluteListenPaths } from '../engine/serve'
import { RESTART_EXIT_CODE } from '../service/definition'
import type { ServiceManager } from '../service/outcome'

// The engine's restart into an update (spec §9.2, §7.1): once the old engine's root scope has ended
// (its runs wound down, its socket closed, its lock released), its process starts the new launcher's
// `fabrica serve` as a detached daemon, in a session of its own, and exits. It isn't one of the
// runner's commands, whose scope's end ends their tree: the new engine outlives the old. Nor does it
// get a command's allowlisted environment (§20.2): it is the daemon, and takes the old engine's own
// environment as its host's, the ssh-agent, ssh command, proxies and CA variables its git's network
// commands pass on among it (§11.7). It keeps the old engine's `serve` flags too, its TLS listener's
// (§9.3), their files' paths made absolute, since it runs from the home folder. Run by the login service
// (§7.1), it starts nothing and exits for the service's manager to start the new engine from the link
// the update switched, since the manager would kill or double a `fabrica serve` the engine started.

/** The new engine didn't start. */
export class RelaunchFailed extends Data.TaggedError('RelaunchFailed')<{
  readonly launcher: string
  readonly why: string
}> {
  override get message() {
    return `cannot start the updated engine, ${this.launcher} serve: ${this.why}`
  }
}

/** `fabrica serve`'s arguments for the TLS listener's flags: each flag given, its paths absolute. */
export const serveArguments = (
  flags: ListenSettings,
): ReadonlyArray<string> => {
  const absolute = absoluteListenPaths(flags)
  return [
    'serve',
    ...Option.match(absolute.listen, {
      onNone: () => [],
      onSome: address => ['--listen', formatListenAddress(address)],
    }),
    ...Option.match(absolute.listen_certificate, {
      onNone: () => [],
      onSome: path => ['--listen-certificate', path],
    }),
    ...Option.match(absolute.listen_key, {
      onNone: () => [],
      onSome: path => ['--listen-key', path],
    }),
  ]
}

/** Starts `launcher serve` detached from this process, with its flags, returning once it has started. */
export const relaunch = Effect.fn('Update.relaunch')(function* ({
  launcher,
  cwd,
  hostEnvironment,
  listen,
}: {
  readonly launcher: string
  readonly cwd: string
  /** The engine's own environment, read once where it started: the new engine's, whole. */
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>
  /** The engine's `serve` flags for its TLS listener, given again to the new engine. */
  readonly listen: ListenSettings
}) {
  return yield* Effect.callback<void, RelaunchFailed>(resume => {
    const failed = (error: unknown) =>
      resume(
        Effect.fail(
          new RelaunchFailed({
            launcher,
            why: error instanceof Error ? error.message : String(error),
          }),
        ),
      )
    try {
      const child = spawn(launcher, serveArguments(listen), {
        cwd,
        env: hostEnvironment,
        detached: true,
        stdio: 'ignore',
      })
      child.once('error', failed)
      child.once('spawn', () => {
        child.unref()
        resume(Effect.void)
      })
    } catch (error) {
      failed(error)
    }
  })
})

/** The engine exits for its login service's manager to start the updated engine; its exit code says so. */
export class RestartByService extends Data.TaggedError('RestartByService')<{
  readonly manager: ServiceManager
}> {
  override readonly [Runtime.errorExitCode] = RESTART_EXIT_CODE

  override get message() {
    return `the engine exits for ${this.manager} to start the updated engine`
  }
}

/**
 * Restarts into `launcher`'s release once the engine's scope has ended: where `service` (read once where
 * the engine started) names the manager running the engine, it fails with `RestartByService` for the
 * process to exit; elsewhere it starts `launcher serve` with the engine's flags, as `relaunch` does.
 */
export const restart = Effect.fn('Update.restart')(function* ({
  service,
  ...options
}: Parameters<typeof relaunch>[0] & {
  readonly service: Option.Option<ServiceManager>
}) {
  return yield* Option.match(service, {
    onSome: manager => Effect.fail(new RestartByService({ manager })),
    onNone: () => relaunch(options),
  })
})
