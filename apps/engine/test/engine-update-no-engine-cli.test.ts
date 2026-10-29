import { Console, Effect, Exit, Layer } from 'effect'
import { readlink } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { Update } from '@fabrica/engine'
import { layerHost } from '@fabrica/testkit'

import {
  type FixtureRelease,
  PATH,
  entries,
  fixtureReleases,
  fixtureUpdater,
  installedBefore,
  keyPair,
  makeHome,
  serveReleases,
} from '../../../packages/engine/test/fixture-releases'
import { LocalEngine } from '../src/cli/connect'
import { LocalUpdater } from '../src/cli/engine'
import { runCli } from '../src/cli/main'
import { version } from '../src/version'

// `fabrica engine update [<version>]` where no engine answers on the socket (spec §19, §9.2): the CLI
// installs the release itself, from fixture releases served over HTTP, verified as the engine verifies
// them, and relinks `fabrica`; it restarts nothing, and says the next `fabrica serve` runs the release.

/** A home with this CLI's release installed and linked, and the fixture's `releases` served. */
const setUp = Effect.fn(function* ({
  releases,
  latest,
}: {
  readonly releases: ReadonlyArray<FixtureRelease>
  readonly latest: string
}) {
  const host = yield* makeHome()
  yield* installedBefore(host.places, version)
  const root = yield* fixtureReleases(releases)
  const served = yield* serveReleases({ root, latest })
  const updater = fixtureUpdater({
    releases: served.url,
    home: host.home,
    path: PATH,
  })
  return { ...host, served, updater }
})

/** `fabrica <args>` where no engine runs, updating with `updater`: its exit and what it printed. */
const fabrica = ({
  root,
  updater,
  args,
}: {
  readonly root: string
  readonly updater: Layer.Layer<Update.Updater>
  readonly args: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    const out: Array<string> = []
    const err: Array<string> = []
    const console: Console.Console = Object.assign(
      Object.create(globalThis.console),
      {
        log: (...line: ReadonlyArray<unknown>) => out.push(line.join(' ')),
        error: (...line: ReadonlyArray<unknown>) => err.push(line.join(' ')),
      },
    )
    const socket = NodePath.join(root, 'engine.sock')
    const exit = yield* runCli(args).pipe(
      Effect.provideService(Console.Console, console),
      Effect.provideService(LocalUpdater, { updater }),
      Effect.provide([
        NodeServices.layer,
        Layer.succeed(LocalEngine)({ socket: Effect.succeed(socket) }),
        layerHost(),
      ]),
      Effect.exit,
    )
    return { exit, out, err }
  })

const linked = (places: Update.InstallPlaces) =>
  Effect.promise(() => readlink(places.link))

describe('fabrica engine update where no engine runs', () => {
  it.live('installs the latest release and relinks fabrica, as JSON', () =>
    Effect.gen(function* () {
      const { root, places, updater } = yield* setUp({
        releases: [{ version: '0.2.0' }],
        latest: '0.2.0',
      })
      const { exit, out, err } = yield* fabrica({
        root,
        updater,
        args: ['engine', 'update', '--json'],
      })
      expect(err).toStrictEqual([])
      expect(exit).toStrictEqual(Exit.void)
      const launcher = NodePath.join(places.engines, '0.2.0', Update.LAUNCHER)
      expect(out).toHaveLength(1)
      expect(JSON.parse(out[0] ?? '')).toStrictEqual({
        from: version,
        to: '0.2.0',
        launcher,
      })
      expect(yield* linked(places)).toBe(launcher)
      expect(yield* entries(places.engines)).toStrictEqual([version, '0.2.0'])
    }).pipe(Effect.scoped),
  )

  it.live('installs the release named, saying the next serve runs it', () =>
    Effect.gen(function* () {
      const { root, places, served, updater } = yield* setUp({
        releases: [{ version: '0.2.0' }, { version: '0.3.0' }],
        latest: '0.3.0',
      })
      const { exit, out } = yield* fabrica({
        root,
        updater,
        args: ['engine', 'update', '0.2.0'],
      })
      expect(exit).toStrictEqual(Exit.void)
      expect(out).toStrictEqual([
        `no engine was running: fabrica installed 0.2.0 in place of ${version}, and the next \`fabrica serve\` runs it`,
      ])
      expect(yield* linked(places)).toBe(
        NodePath.join(places.engines, '0.2.0', Update.LAUNCHER),
      )
      expect(served.asked).not.toContain('/latest/download/checksums.txt')
    }).pipe(Effect.scoped),
  )

  it.live('says why nothing was installed, leaving fabrica linked', () =>
    Effect.gen(function* () {
      const { root, places, updater } = yield* setUp({
        releases: [{ version: '0.2.0', key: keyPair() }],
        latest: '0.2.0',
      })
      const { exit, out, err } = yield* fabrica({
        root,
        updater,
        args: ['engine', 'update'],
      })
      expect(Exit.isFailure(exit)).toBe(true)
      expect(out).toStrictEqual([])
      expect(err).toStrictEqual([
        `fabrica: the engine wasn't updated: ${Update.describeFailure(Update.UpdateFailure.BadSignature())}`,
      ])
      expect(yield* linked(places)).toBe(
        NodePath.join(places.engines, version, Update.LAUNCHER),
      )
      expect(yield* entries(places.engines)).toStrictEqual([version])
    }).pipe(Effect.scoped),
  )
})
