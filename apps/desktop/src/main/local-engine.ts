import { Data, type Duration, Effect, Option } from 'effect'
import { execFile } from 'node:child_process'
import * as NodePath from 'node:path'

import type { ReleaseVersion } from '@fabrica/contracts'
import { DISTRIBUTION_LAYOUT } from '@fabrica/engine-app/layout'
import {
  type EngineStartFailed,
  reachEngine,
  startDetached,
} from '@fabrica/engine/bridge'
import {
  type InstallPlaces,
  LAUNCHER,
  type UpdateFailure,
  describeFailure,
  installCopyHost,
  installPlaces,
  versionFolder,
} from '@fabrica/engine/update'

// The local engine (spec §7.1, §22.2): the app starts it when it can't reach one, as a detached daemon,
// or installs it as a login service when the user chooses (`fabrica service install`). Either runs
// from a copy of the engine distribution the app bundles, installed as on any host (§9.2) into
// `~/.local/share/fabrica/engine/<version>/`, `~/.local/bin/fabrica` linked to it, never from the
// app's own folder, which goes or is replaced under it (an AppImage's mount, a dmg, an update). It is
// reached as the stdio bridge reaches it, through its socket, so the app and `fabrica bridge` agree on
// when an engine answers. A development build bundles no engine: it reaches one the developer
// started, and starts none.

/** A part of the engine distribution a packaged app bundles: unpacked under its resources, as `engine/` (§22.2). */
const bundledPart = (resources: string, part: string): string =>
  NodePath.join(resources, 'engine', part)

/** The bundled distribution's Node, which the app's own ssh askpass runs on while the app runs. */
export const bundledNode = (resources: string): string =>
  bundledPart(resources, DISTRIBUTION_LAYOUT.node)

/** The engine distribution a packaged app bundles, and where its copy is installed. */
export interface BundledEngine {
  /** The unpacked distribution, in the app's resources. */
  readonly folder: string
  /** Its version: the app's own. */
  readonly version: ReleaseVersion
  /** Where the engine's versions are installed and `fabrica` is linked, under the user's home folder. */
  readonly places: InstallPlaces
}

/** The engine a packaged app with `resources` and of `version` bundles, its copy installed under `home`. */
export const bundledEngine = ({
  resources,
  version,
  home,
}: {
  readonly resources: string
  readonly version: ReleaseVersion
  readonly home: string
}): BundledEngine => ({
  folder: NodePath.join(resources, 'engine'),
  version,
  places: installPlaces(home),
})

/** The launcher of the bundled engine's installed copy, which the local engine runs. */
export const installedLauncher = (engine: BundledEngine): string =>
  NodePath.join(
    versionFolder({ places: engine.places, version: engine.version }),
    LAUNCHER,
  )

export interface LocalEngineOptions {
  /** The local engine's socket (§8.2). */
  readonly socket: string
  /** The engine the app bundles: none in a development build. */
  readonly bundled: Option.Option<BundledEngine>
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

/** The bundled engine's copy couldn't be installed. */
export class EngineCopyFailed extends Data.TaggedError('EngineCopyFailed')<{
  readonly failure: UpdateFailure
}> {
  override get message() {
    return `the bundled engine couldn't be installed: ${describeFailure(this.failure)}`
  }
}

/** Installs the bundled engine's copy where it isn't installed yet: its launcher. */
const installCopyOf = (
  engine: BundledEngine,
  env: LocalEngineOptions['env'],
): Effect.Effect<string, EngineCopyFailed> =>
  installCopyHost({
    places: engine.places,
    version: engine.version,
    from: engine.folder,
    env,
  }).pipe(Effect.mapError(failure => new EngineCopyFailed({ failure })))

/** `fabrica service install` failed, or couldn't be run: what it said. */
export class ServiceInstallFailed extends Data.TaggedError(
  'ServiceInstallFailed',
)<{ readonly reason: string }> {
  override get message() {
    return `the login service couldn't be installed: ${this.reason}`
  }
}

/** Makes sure the local engine answers: one already running, or one started from the bundled engine's copy. */
export const ensureLocalEngine = Effect.fn('LocalEngine.ensure')(function* (
  options: LocalEngineOptions,
) {
  return yield* reachEngine({
    socket: options.socket,
    startEngine: Option.match(options.bundled, {
      onNone: (): Effect.Effect<
        void,
        NoBundledEngine | EngineCopyFailed | EngineStartFailed
      > => Effect.fail(new NoBundledEngine({ socket: options.socket })),
      onSome: engine =>
        Effect.flatMap(installCopyOf(engine, options.env), launcher =>
          startDetached({
            command: launcher,
            args: ['serve'],
            env: options.env,
          }),
        ),
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
 * bundled engine's copy's `fabrica service install`, which also starts it (§7.1, §19); the service
 * runs `~/.local/bin/fabrica`, linked to that copy.
 */
export const installLoginService = Effect.fn('LocalEngine.installService')(
  function* (options: Pick<LocalEngineOptions, 'bundled' | 'env'>) {
    const engine = yield* Option.match(options.bundled, {
      onNone: () =>
        Effect.fail(
          new ServiceInstallFailed({
            reason: 'this build bundles no engine to install',
          }),
        ),
      onSome: Effect.succeed,
    })
    const launcher = yield* installCopyOf(engine, options.env).pipe(
      Effect.mapError(
        copy =>
          new ServiceInstallFailed({ reason: describeFailure(copy.failure) }),
      ),
    )
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
