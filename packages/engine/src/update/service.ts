import { Context, Effect, Layer, Option } from 'effect'
import { FetchHttpClient, HttpClient } from 'effect/http'

import type { ReleaseVersion } from '@fabrica/contracts'

import { layerClock } from '../process/deadlines'
import { ProcessRunner, layerHost as runnerLayerHost } from '../process/runner'
import { UpdateFailure } from './failure'
import { RELEASE_KEYS } from './keys'
import {
  type InstallPlaces,
  RELEASES,
  type ReleaseChoice,
  targetOf,
} from './release'
import {
  type ReleaseSource,
  fetchRelease,
  makeStage,
  placeRelease,
  unpackRelease,
} from './steps'

// The Updater (spec §9.2, §20.4): installs a release of the engine on its own host, as the install
// script does, for `engine.update` to restart the engine into. The engine reads its host's target
// and its install places once as it starts, and the release source is Fabrica's GitHub releases with
// the engine's release keys; a test gives a fixture's.

/** A release the Updater installed: its version, and its launcher, which `fabrica` now links to. */
export interface Installed {
  readonly version: ReleaseVersion
  readonly launcher: string
}

export interface UpdaterShape {
  /** Installs the release asked for, or the latest, in place of the engine's `current` one. */
  readonly install: (request: {
    readonly current: ReleaseVersion
    readonly release: ReleaseChoice
  }) => Effect.Effect<Installed, UpdateFailure>
}

export class Updater extends Context.Service<Updater, UpdaterShape>()(
  '@fabrica/engine/Updater',
) {}

/** What the Updater works from, each read once where the engine starts. */
export interface UpdaterConfig {
  readonly source: ReleaseSource
  readonly places: InstallPlaces
  /** The host, as Node names its platform and architecture. */
  readonly host: { readonly platform: string; readonly arch: string }
}

/** The Updater over the HTTP client and the process runner in context. */
export const make = Effect.fn('Updater.make')(function* (
  config: UpdaterConfig,
) {
  const context = yield* Effect.context<HttpClient.HttpClient | ProcessRunner>()
  const install = Effect.fn('Updater.install')(function* ({
    current,
    release,
  }: {
    readonly current: ReleaseVersion
    readonly release: ReleaseChoice
  }) {
    const target = yield* Option.match(targetOf(config.host), {
      onNone: () => Effect.fail(UpdateFailure.NoTarget(config.host)),
      onSome: Effect.succeed,
    })
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const stage = yield* makeStage(config.places)
        const fetched = yield* fetchRelease({
          source: config.source,
          target,
          release,
          current,
          stage,
        })
        const folder = yield* unpackRelease({ fetched, stage })
        const launcher = yield* placeRelease({
          places: config.places,
          version: fetched.version,
          folder,
          stage,
        })
        return { version: fetched.version, launcher } satisfies Installed
      }),
    ).pipe(Effect.provide(context))
  })
  return Updater.of({ install })
})

/** The Updater over the HTTP client and the process runner given. */
export const layer = (
  config: UpdaterConfig,
): Layer.Layer<Updater, never, HttpClient.HttpClient | ProcessRunner> =>
  Layer.effect(Updater, make(config))

/** The Updater on the engine's own host: Node's fetch, and the engine's process runner. */
export const layerHost = (
  config: Omit<UpdaterConfig, 'source'>,
): Layer.Layer<Updater> =>
  layer({ ...config, source: { releases: RELEASES, keys: RELEASE_KEYS } }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(runnerLayerHost),
    Layer.provide(layerClock),
  )

/** An Updater refusing every update: the engine of a test that installs nothing. */
export const layerRefusing = (why: string): Layer.Layer<Updater> =>
  Layer.succeed(
    Updater,
    Updater.of({ install: () => Effect.fail(UpdateFailure.Refused({ why })) }),
  )
