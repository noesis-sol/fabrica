import { Data, type Duration, Effect, Option } from 'effect'
import { execFile } from 'node:child_process'
import * as NodePath from 'node:path'

import { DISTRIBUTION_LAYOUT } from '@fabrica/engine-app/layout'
import {
  type EngineStartFailed,
  reachEngine,
  startDetached,
} from '@fabrica/engine/bridge'

// The local engine (spec §7.1, §22.2): the app starts it when it can't reach one, as a detached daemon
// from the engine distribution it bundles, or installs it as a login service when the user chooses
// (`fabrica service install`). It is reached as the stdio bridge reaches it, through its socket, so the
// app and `fabrica bridge` agree on when an engine answers. A development build bundles no engine:
// it reaches one the developer started, and starts none.

/** The engine distribution a packaged app bundles: unpacked under its resources, as `engine/` (§22.2). */
export const bundledLauncher = (resources: string): string =>
  NodePath.join(resources, 'engine', DISTRIBUTION_LAYOUT.launcher)

export interface LocalEngineOptions {
  /** The local engine's socket (§8.2). */
  readonly socket: string
  /** The bundled distribution's `fabrica`: none in a development build. */
  readonly launcher: Option.Option<string>
  /** The engine's own environment, from which it builds every command's (§20.2): the app's. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** How long a started engine has to take a connection; the bridge's 10 seconds when left out. */
  readonly startWait?: Duration.Input
}

/** No engine answered, and this build bundles none to start. */
export class NoBundledEngine extends Data.TaggedError('NoBundledEngine')<{
  readonly socket: string
}> {
  override get message() {
    return `no engine answers at ${this.socket}, and this build bundles none to start`
  }
}

/** `fabrica service install` failed, or couldn't be run: what it said. */
export class ServiceInstallFailed extends Data.TaggedError(
  'ServiceInstallFailed',
)<{ readonly reason: string }> {
  override get message() {
    return `the login service couldn't be installed: ${this.reason}`
  }
}

/** Makes sure the local engine answers: one already running, or one started from the bundled distribution. */
export const ensureLocalEngine = Effect.fn('LocalEngine.ensure')(function* (
  options: LocalEngineOptions,
) {
  return yield* reachEngine({
    socket: options.socket,
    startEngine: Option.match(options.launcher, {
      onNone: (): Effect.Effect<void, NoBundledEngine | EngineStartFailed> =>
        Effect.fail(new NoBundledEngine({ socket: options.socket })),
      onSome: launcher =>
        startDetached({ command: launcher, args: ['serve'], env: options.env }),
    }),
    ...(options.startWait === undefined
      ? {}
      : { startWait: options.startWait }),
  })
})

/** The most of `fabrica service install`'s output kept, to say why it failed. */
const outputCap = 64 * 1024

/** What a failed command said: its output, or its error where it said nothing. */
const saidOf = (error: Error, stdout: string, stderr: string): string => {
  const said = `${stderr}${stdout}`.trim()
  return said === '' ? error.message : said
}

/**
 * Installs the login service that runs the engine (a launchd agent, a systemd user unit), through the
 * bundled distribution's `fabrica service install`, which also starts it (§7.1, §19).
 */
export const installLoginService = Effect.fn('LocalEngine.installService')(
  function* (options: Pick<LocalEngineOptions, 'launcher' | 'env'>) {
    const launcher = yield* Option.match(options.launcher, {
      onNone: () =>
        Effect.fail(
          new ServiceInstallFailed({
            reason: 'this build bundles no engine to install',
          }),
        ),
      onSome: Effect.succeed,
    })
    yield* Effect.callback<void, ServiceInstallFailed>(resume => {
      const child = execFile(
        launcher,
        ['service', 'install'],
        { env: options.env, maxBuffer: outputCap },
        (error, stdout, stderr) =>
          resume(
            error === null
              ? Effect.void
              : Effect.fail(
                  new ServiceInstallFailed({
                    reason: saidOf(error, stdout, stderr),
                  }),
                ),
          ),
      )
      return Effect.sync(() => child.kill())
    })
  },
)
