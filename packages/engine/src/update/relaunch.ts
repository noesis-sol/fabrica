import { Data, Effect, Option, Runtime } from 'effect'
import { spawn } from 'node:child_process'

import { commandEnvironment } from '../process/environment'
import { RESTART_EXIT_CODE } from '../service/definition'
import type { ServiceManager } from '../service/outcome'

// The engine's restart into an update (spec §9.2, §7.1): once the old engine's root scope has ended
// (its runs wound down, its socket closed, its lock released), its process starts the new launcher's
// `fabrica serve` as a detached daemon, in a session of its own, and exits. It isn't one of the
// runner's commands, whose scope's end ends their tree: the new engine outlives the old. It gets the
// allowlisted environment every command the engine starts gets (§20.2). Run by the login service
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

/** Starts `launcher serve` detached from this process, returning once it has started. */
export const relaunch = Effect.fn('Update.relaunch')(function* ({
  launcher,
  cwd,
  hostEnvironment,
}: {
  readonly launcher: string
  readonly cwd: string
  /** The engine's own environment, read once where it started. */
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>
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
      const child = spawn(launcher, ['serve'], {
        cwd,
        env: commandEnvironment({ host: hostEnvironment, extra: {} }),
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
 * process to exit; elsewhere it starts `launcher serve`, as `relaunch` does.
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
