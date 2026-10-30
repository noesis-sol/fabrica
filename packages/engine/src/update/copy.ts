import { Effect, Layer, Option } from 'effect'
import { cp, lstat, stat } from 'node:fs/promises'
import * as NodePath from 'node:path'

import type { ReleaseVersion } from '@fabrica/contracts'

import { layerClock } from '../process/deadlines'
import {
  ProcessRunner,
  hostConfig,
  make as makeRunner,
} from '../process/runner'
import { UpdateFailure } from './failure'
import { type InstallPlaces, LAUNCHER, versionFolder } from './release'
import { checkLauncher, linkLauncher, makeStage, placeRelease } from './steps'

// Installing a copy of an engine distribution unpacked already: the one the app embeds, which the
// local engine runs from once it is copied out of the app's folder (spec §7.1), since that folder
// isn't the engine's to keep: an AppImage's mount goes as the app quits, a dmg's as it is ejected, and
// an update replaces the app's folder under the running engine. The copy is installed as a release is
// (steps.ts): copied into a stage of its own beside the engine's versions, its launcher checked there,
// renamed into `~/.local/share/fabrica/engine/<version>/` and `~/.local/bin/fabrica` linked to it. A
// version installed already is kept as it is, since its engine may be running.

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Whether `path` names something, a link that names nothing aside. */
const resolves = (path: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => stat(path)).pipe(
    Effect.option,
    Effect.map(Option.isSome),
  )

/**
 * Installs a copy of the distribution of `version` unpacked in `from`, where that version isn't
 * installed yet, and links `fabrica` to it; where it is, links `fabrica` to it only where the link
 * names no engine. Returns the installed launcher.
 */
export const installCopy = Effect.fn('Update.installCopy')(function* ({
  places,
  version,
  from,
}: {
  readonly places: InstallPlaces
  readonly version: ReleaseVersion
  readonly from: string
}) {
  const launcher = NodePath.join(versionFolder({ places, version }), LAUNCHER)
  const installed = yield* Effect.tryPromise(() => lstat(launcher)).pipe(
    Effect.option,
  )
  if (Option.isSome(installed)) {
    if (!(yield* resolves(places.link)))
      yield* linkLauncher({ places, launcher })
    return launcher
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const stage = yield* makeStage(places)
      const folder = NodePath.join(stage, 'copied')
      // Links copied as they are: a distribution's own links are relative, within it.
      yield* Effect.tryPromise({
        try: () =>
          cp(from, folder, {
            recursive: true,
            verbatimSymlinks: true,
            errorOnExist: true,
          }),
        catch: error =>
          UpdateFailure.PlaceFailed({ path: folder, message: message(error) }),
      })
      yield* checkLauncher({ folder, shown: from, version })
      return yield* placeRelease({ places, version, folder, stage })
    }),
  )
})

/**
 * `installCopy` with the engine's process runner on this host, for a host outside the engine (the
 * app), the launcher's check run in `env`, the host's environment as it read it.
 */
export const installCopyHost = ({
  env,
  ...options
}: Parameters<typeof installCopy>[0] & {
  readonly env: Readonly<Record<string, string | undefined>>
}): Effect.Effect<string, UpdateFailure> =>
  installCopy(options).pipe(
    Effect.provide(
      Layer.effect(
        ProcessRunner,
        Effect.suspend(() =>
          makeRunner({ ...hostConfig(), hostEnvironment: env }),
        ),
      ).pipe(Layer.provide(layerClock)),
    ),
  )
