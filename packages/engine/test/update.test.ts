import { Deferred, Effect, Fiber, Layer, Option } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { sign } from 'node:crypto'
import { existsSync, watch } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import * as NodePath from 'node:path'

import { NodeSocket } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import {
  ClientHello,
  EngineHost,
  FabricaRpcs,
  UpdateStarted,
  protocolVersion,
} from '@fabrica/contracts'

import {
  DISTRIBUTION_LAYOUT,
  ENGINE_TARGETS as LAYOUT_TARGETS,
  distributionName as layoutName,
} from '../../../apps/engine/src/layout'
import { releaseKeysOf } from '../../../scripts/sign-checksums'
import { EngineEnd, pathsIn, startEngine } from '../src/engine'
import {
  ENGINE_TARGETS,
  type InstallPlaces,
  LAUNCHER,
  RELEASE_KEYS,
  UpdateFailure,
  Updater,
  assetUrl,
  compareReleases,
  distributionName,
  parseChecksums,
  relaunch,
  targetOf,
  verifyChecksums,
} from '../src/update'
import {
  type FixtureRelease,
  PATH,
  entries,
  fixtureReleases,
  fixtureUpdater,
  installedBefore,
  keyPair,
  launcher,
  makeHome,
  releaseKey,
  serveReleases,
  shStub,
  target,
  tempFolder,
} from './fixture-releases'

// `fabrica engine update` and `engine.update` (spec §9.2, §20.4, §22.5) against fixture releases served
// over HTTP from a local folder, laid out as GitHub serves them: the signature verified before any sum
// is trusted, the archive's SHA-256, the new launcher's --version, the version's folder and the link
// renamed into place; the engine group's update answering and asking the engine to restart; and the
// restart into the new launcher, detached.

const repository = NodePath.join(import.meta.dirname, '..', '..', '..')

const strangerKey = keyPair()

describe('the engine update', () => {
  /** A home with 0.1.0 installed, the fixture's releases served, and the Updater over them. */
  const setUp = Effect.fn(function* ({
    releases,
    latest,
    keys,
  }: {
    readonly releases: ReadonlyArray<FixtureRelease>
    readonly latest: string
    readonly keys?: ReadonlyArray<string>
  }) {
    const host = yield* makeHome()
    yield* installedBefore(host.places, '0.1.0')
    const root = yield* fixtureReleases(releases)
    const served = yield* serveReleases({ root, latest })
    const updater = fixtureUpdater({
      releases: served.url,
      home: host.home,
      path: PATH,
      ...(keys === undefined ? {} : { keys }),
    })
    const install = (release: Option.Option<string>) =>
      Effect.gen(function* () {
        const service = yield* Updater
        return yield* service.install({ current: '0.1.0', release })
      }).pipe(Effect.provide(updater))
    return { ...host, served, install }
  })

  /** What `fabrica` links to. */
  const linked = (places: InstallPlaces) =>
    Effect.promise(() => readlink(places.link))

  /** The engine as an earlier install left it: 0.1.0 alone, linked. */
  const leftAsItWas = Effect.fn(function* (places: InstallPlaces) {
    expect(yield* entries(places.engines)).toStrictEqual(['0.1.0'])
    expect(yield* linked(places)).toBe(
      NodePath.join(places.engines, '0.1.0', LAUNCHER),
    )
    expect(yield* entries(NodePath.dirname(places.link))).toStrictEqual([
      'fabrica',
    ])
  })

  it.live('installs the latest release, verified, and relinks fabrica', () =>
    Effect.gen(function* () {
      const { places, home, served, install } = yield* setUp({
        releases: [{ version: '0.2.0' }],
        latest: '0.2.0',
      })
      const installed = yield* install(Option.none())
      const launcherPath = NodePath.join(places.engines, '0.2.0', LAUNCHER)
      expect(installed).toStrictEqual({
        version: '0.2.0',
        launcher: launcherPath,
      })
      expect(yield* linked(places)).toBe(launcherPath)
      // The stage is gone; the version before stays, for a way back.
      expect(yield* entries(places.engines)).toStrictEqual(['0.1.0', '0.2.0'])
      expect(yield* entries(NodePath.dirname(places.link))).toStrictEqual([
        'fabrica',
      ])
      // Its --version ran in a folder of the engine's own beside its versions, never in /tmp.
      const ran = yield* Effect.promise(() =>
        readFile(NodePath.join(home, 'ran'), 'utf8'),
      )
      const [where, args] = ran.trim().split(' ')
      expect(args).toBe('--version')
      expect(
        NodePath.dirname(NodePath.dirname(NodePath.dirname(where ?? ''))),
      ).toBe(places.engines)
      // The signed sums before the archive, which comes from the version's own release.
      const [first, second, ...rest] = served.asked
      expect([first, second].toSorted()).toStrictEqual([
        '/latest/download/checksums.txt',
        '/latest/download/checksums.txt.sig',
      ])
      expect(rest).toStrictEqual([
        `/download/v0.2.0/fabrica-0.2.0-${target}.tar.gz`,
      ])
    }).pipe(Effect.scoped),
  )

  it.live('installs the release asked for rather than the latest', () =>
    Effect.gen(function* () {
      const { places, install } = yield* setUp({
        releases: [{ version: '0.2.0' }, { version: '0.3.0' }],
        latest: '0.3.0',
      })
      const installed = yield* install(Option.some('0.2.0'))
      expect(installed.version).toBe('0.2.0')
      expect(yield* linked(places)).toBe(
        NodePath.join(places.engines, '0.2.0', LAUNCHER),
      )
    }).pipe(Effect.scoped),
  )

  it.live(
    'refuses a signature made with another key, downloading no archive',
    () =>
      Effect.gen(function* () {
        const { places, served, install } = yield* setUp({
          releases: [{ version: '0.2.0', key: strangerKey }],
          latest: '0.2.0',
        })
        const failure = yield* Effect.flip(install(Option.none()))
        expect(failure).toStrictEqual(UpdateFailure.BadSignature())
        expect(served.asked.some(path => path.endsWith('.tar.gz'))).toBe(false)
        yield* leftAsItWas(places)
      }).pipe(Effect.scoped),
  )

  it.live('refuses an archive whose SHA-256 isn’t the signed one', () =>
    Effect.gen(function* () {
      const { places, install } = yield* setUp({
        releases: [{ version: '0.2.0', tampered: true }],
        latest: '0.2.0',
      })
      const failure = yield* Effect.flip(install(Option.none()))
      expect(failure._tag).toBe('ChecksumMismatch')
      yield* leftAsItWas(places)
    }).pipe(Effect.scoped),
  )

  it.live('installs nothing without a release key, asking for nothing', () =>
    Effect.gen(function* () {
      const { places, served, install } = yield* setUp({
        releases: [{ version: '0.2.0' }],
        latest: '0.2.0',
        keys: [],
      })
      const failure = yield* Effect.flip(install(Option.none()))
      expect(failure).toStrictEqual(UpdateFailure.NoReleaseKey())
      expect(served.asked).toStrictEqual([])
      yield* leftAsItWas(places)
    }).pipe(Effect.scoped),
  )

  it.live('refuses a new launcher that names another version', () =>
    Effect.gen(function* () {
      const { places, install } = yield* setUp({
        releases: [{ version: '0.2.0', launcher: launcher('fabrica v0.1.9') }],
        latest: '0.2.0',
      })
      const failure = yield* Effect.flip(install(Option.none()))
      expect(failure).toStrictEqual(
        UpdateFailure.WrongVersion({
          said: 'fabrica v0.1.9',
          want: 'fabrica v0.2.0',
        }),
      )
      yield* leftAsItWas(places)
    }).pipe(Effect.scoped),
  )

  it.live('refuses the release it runs, and a latest older than it', () =>
    Effect.gen(function* () {
      const { places, install } = yield* setUp({
        releases: [{ version: '0.0.9' }],
        latest: '0.0.9',
      })
      expect(yield* Effect.flip(install(Option.some('0.1.0')))).toStrictEqual(
        UpdateFailure.AlreadyThere({ version: '0.1.0' }),
      )
      expect(yield* Effect.flip(install(Option.none()))).toStrictEqual(
        UpdateFailure.LatestOlder({ latest: '0.0.9', current: '0.1.0' }),
      )
      // Named, an older release is a way back.
      expect((yield* install(Option.some('0.0.9'))).version).toBe('0.0.9')
      expect(yield* linked(places)).toBe(
        NodePath.join(places.engines, '0.0.9', LAUNCHER),
      )
    }).pipe(Effect.scoped),
  )

  it.live(
    'switches the link by a rename: one that can’t be made leaves the old',
    () =>
      Effect.gen(function* () {
        const host = yield* makeHome()
        const root = yield* fixtureReleases([{ version: '0.2.0' }])
        const served = yield* serveReleases({ root, latest: '0.2.0' })
        // `fabrica` is a folder holding a file: no link can be renamed over it.
        const linkFolder = NodePath.dirname(host.places.link)
        yield* Effect.promise(async () => {
          await mkdir(host.places.link, { recursive: true })
          await writeFile(NodePath.join(host.places.link, 'kept'), '')
        })
        const failure = yield* Effect.flip(
          Effect.gen(function* () {
            const service = yield* Updater
            return yield* service.install({
              current: '0.1.0',
              release: Option.none(),
            })
          }).pipe(
            Effect.provide(
              fixtureUpdater({
                releases: served.url,
                home: host.home,
                path: PATH,
              }),
            ),
          ),
        )
        expect(failure._tag).toBe('PlaceFailed')
        // No temporary link is left beside it, and what was there is as it was.
        expect(yield* entries(linkFolder)).toStrictEqual(['fabrica'])
        expect(yield* entries(host.places.link)).toStrictEqual(['kept'])
        // A link there is replaced whole: the name is never missing between the two.
        yield* Effect.promise(async () => {
          await rm(host.places.link, { recursive: true })
          await symlink('/nowhere/fabrica', host.places.link)
        })
        const before = yield* Effect.promise(() => lstat(host.places.link))
        const installed = yield* Effect.gen(function* () {
          const service = yield* Updater
          return yield* service.install({
            current: '0.1.0',
            release: Option.none(),
          })
        }).pipe(
          Effect.provide(
            fixtureUpdater({
              releases: served.url,
              home: host.home,
              path: PATH,
            }),
          ),
        )
        const after = yield* Effect.promise(() => lstat(host.places.link))
        expect(after.isSymbolicLink()).toBe(true)
        expect(after.ino).not.toBe(before.ino)
        expect(yield* Effect.promise(() => readlink(host.places.link))).toBe(
          installed.launcher,
        )
        expect(yield* entries(linkFolder)).toStrictEqual(['fabrica'])
      }).pipe(Effect.scoped),
  )

  describe('engine.update', () => {
    const engineHost = new EngineHost({
      platform: 'linux',
      arch: 'x64',
      hostname: 'test-host',
      cores: 8,
    })

    const hello = new ClientHello({
      name: 'update test',
      kind: 'cli',
      release: '0.1.0',
      protocol: protocolVersion,
    })

    /** An engine at 0.1.0 with `update` as its Updater, and a client on its socket. */
    const engineWith = Effect.fn(function* (update: Layer.Layer<Updater>) {
      const root = yield* tempFolder('upe')
      const paths = pathsIn({
        data: NodePath.join(root, 'd'),
        socketFolder: NodePath.join(root, 'd'),
      })
      const engine = yield* startEngine({
        paths,
        host: engineHost,
        release: '0.1.0',
        update,
      })
      const protocol = yield* Layer.build(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide([
            NodeSocket.layerNet({ path: paths.socket }),
            RpcSerialization.layerNdjson,
          ]),
        ),
      )
      const client = yield* RpcClient.make(FabricaRpcs).pipe(
        Effect.provide(protocol),
      )
      yield* client['engine.connect'](hello)
      return { engine, client }
    })

    it.live(
      'answers once the release is installed, and restarts the engine into it',
      () =>
        Effect.gen(function* () {
          const host = yield* makeHome()
          const root = yield* fixtureReleases([{ version: '0.2.0' }])
          const served = yield* serveReleases({ root, latest: '0.2.0' })
          const { engine, client } = yield* engineWith(
            fixtureUpdater({
              releases: served.url,
              home: host.home,
              path: PATH,
            }),
          )
          const started = yield* client['engine.update']({ to: Option.none() })
          expect(started).toStrictEqual(
            new UpdateStarted({ from: '0.1.0', to: '0.2.0' }),
          )
          expect(yield* engine.stopRequested).toStrictEqual(
            EngineEnd.Restart({
              launcher: NodePath.join(host.places.engines, '0.2.0', LAUNCHER),
            }),
          )
          expect(yield* engine.stopping).toBe(true)
        }).pipe(Effect.scoped),
    )

    it.live('answers a failed update in words, the engine left running', () =>
      Effect.gen(function* () {
        const host = yield* makeHome()
        const root = yield* fixtureReleases([
          { version: '0.2.0', key: strangerKey },
        ])
        const served = yield* serveReleases({ root, latest: '0.2.0' })
        const { engine, client } = yield* engineWith(
          fixtureUpdater({
            releases: served.url,
            home: host.home,
            path: PATH,
          }),
        )
        const failed = yield* Effect.flip(
          client['engine.update']({ to: Option.none() }),
        )
        expect(failed._tag).toBe('UpdateFailed')
        expect(failed.reason).toContain(
          "checksums.txt.sig doesn't verify checksums.txt with a release key",
        )
        expect(yield* engine.stopping).toBe(false)
      }).pipe(Effect.scoped),
    )

    it.live(
      'takes one update at a time, and none once the engine is stopping',
      () =>
        Effect.gen(function* () {
          const began = yield* Deferred.make<void>()
          const finish = yield* Deferred.make<void>()
          const { engine, client } = yield* engineWith(
            Layer.succeed(
              Updater,
              Updater.of({
                install: () =>
                  Deferred.succeed(began, undefined).pipe(
                    Effect.andThen(Deferred.await(finish)),
                    Effect.andThen(
                      Effect.fail(UpdateFailure.Refused({ why: 'held' })),
                    ),
                  ),
              }),
            ),
          )
          const first = yield* Effect.forkChild(
            Effect.flip(client['engine.update']({ to: Option.none() })),
          )
          yield* Deferred.await(began)
          const second = yield* Effect.flip(
            client['engine.update']({ to: Option.some('0.2.0') }),
          )
          expect(second.reason).toBe('an update is under way already')
          yield* Deferred.succeed(finish, undefined)
          expect((yield* Fiber.join(first)).reason).toBe('held')
          yield* engine.stop
          const stopping = yield* Effect.flip(
            client['engine.update']({ to: Option.none() }),
          )
          expect(stopping.reason).toBe('the engine is stopping')
        }).pipe(Effect.scoped),
    )

    it.live(
      'stops, where it was asked to stop before it was asked to restart',
      () =>
        Effect.gen(function* () {
          const { engine } = yield* engineWith(
            Layer.succeed(Updater, Updater.of({ install: () => Effect.never })),
          )
          yield* engine.stop
          yield* engine.restart('/elsewhere/bin/fabrica')
          expect(yield* engine.stopRequested).toStrictEqual(EngineEnd.Stop())
        }).pipe(Effect.scoped),
    )
  })
})

/** Completes once `file` exists, on its folder's change events. */
const appears = (file: string): Effect.Effect<void> =>
  Effect.callback<void>(resume => {
    const watcher = watch(NodePath.dirname(file), () => {
      if (existsSync(file)) resume(Effect.void)
    })
    if (existsSync(file)) resume(Effect.void)
    return Effect.sync(() => watcher.close())
  })

describe('the restart into an update', () => {
  it.live(
    'starts the new launcher’s serve, detached, in the allowlisted environment',
    () =>
      Effect.gen(function* () {
        const root = yield* tempFolder('relaunch')
        const fabrica = NodePath.join(root, 'fabrica')
        const said = NodePath.join(root, 'said')
        yield* Effect.promise(async () => {
          await writeFile(
            fabrica,
            shStub(
              `printf '%s|%s|%s\\n' "$*" "$HOME" "\${SECRET-unset}" > '${said}.tmp'\nmv '${said}.tmp' '${said}'`,
            ),
          )
          await chmod(fabrica, 0o755)
        })
        yield* relaunch({
          launcher: fabrica,
          cwd: root,
          hostEnvironment: {
            PATH: '/usr/bin:/bin',
            HOME: root,
            SECRET: 'never',
          },
        })
        yield* appears(said)
        expect(yield* Effect.promise(() => readFile(said, 'utf8'))).toBe(
          `serve|${root}|unset\n`,
        )
      }).pipe(Effect.scoped),
  )

  it.live('says so where the new launcher can’t start', () =>
    Effect.gen(function* () {
      const root = yield* tempFolder('relaunch')
      const failed = yield* Effect.flip(
        relaunch({
          launcher: NodePath.join(root, 'missing'),
          cwd: root,
          hostEnvironment: { PATH: '/usr/bin:/bin', HOME: root },
        }),
      )
      expect(failed._tag).toBe('RelaunchFailed')
    }).pipe(Effect.scoped),
  )
})

describe('a release’s names and order', () => {
  it('names what the distribution’s build names', () => {
    expect(ENGINE_TARGETS).toStrictEqual(LAYOUT_TARGETS)
    expect(LAUNCHER).toBe(DISTRIBUTION_LAYOUT.launcher)
    for (const of of ENGINE_TARGETS)
      expect(distributionName({ version: '1.2.3-rc.1', target: of })).toBe(
        layoutName({ version: '1.2.3-rc.1', target: of }),
      )
  })

  it.effect('holds the install script’s release keys', () =>
    Effect.gen(function* () {
      const script = yield* Effect.promise(() =>
        readFile(NodePath.join(repository, 'scripts', 'install.sh'), 'utf8'),
      )
      expect(RELEASE_KEYS).toStrictEqual(releaseKeysOf(script))
    }),
  )

  it('finds the target of an engine host only', () => {
    expect(targetOf({ platform: 'darwin', arch: 'arm64' })).toStrictEqual(
      Option.some('darwin-arm64'),
    )
    expect(targetOf({ platform: 'win32', arch: 'x64' })).toStrictEqual(
      Option.none(),
    )
    expect(targetOf({ platform: 'linux', arch: 'ia32' })).toStrictEqual(
      Option.none(),
    )
  })

  it('reads the latest release’s files from GitHub’s latest/download', () => {
    const releases = 'https://github.com/noesis-sol/fabrica/releases'
    expect(
      assetUrl({ releases, release: Option.none(), name: 'checksums.txt' }),
    ).toBe(`${releases}/latest/download/checksums.txt`)
    expect(
      assetUrl({ releases, release: Option.some('0.2.0'), name: 'x.tar.gz' }),
    ).toBe(`${releases}/download/v0.2.0/x.tar.gz`)
  })

  it('reads checksums.txt as sha256sum writes it', () => {
    const sum = 'b'.repeat(64)
    expect(
      parseChecksums(
        `${sum}  fabrica-0.2.0-linux-x64.tar.gz\r\n${sum} *install.sh\nnot a line\n`,
      ),
    ).toStrictEqual([
      { name: 'fabrica-0.2.0-linux-x64.tar.gz', sha256: sum },
      { name: 'install.sh', sha256: sum },
    ])
  })

  it('refuses a signature of the wrong length, or over other bytes', () => {
    const checksums = Buffer.from('sums\n')
    const signature = sign(null, checksums, releaseKey.privateKey)
    const keys = [strangerKey.publicPem, releaseKey.publicPem]
    expect(verifyChecksums({ checksums, signature, keys })._tag).toBe('Success')
    expect(
      verifyChecksums({
        checksums: Buffer.from('sums!\n'),
        signature,
        keys,
      })._tag,
    ).toBe('Failure')
    expect(
      verifyChecksums({ checksums, signature: signature.subarray(1), keys })
        ._tag,
    ).toBe('Failure')
  })

  it.each([
    ['0.2.0', '0.1.0', 1],
    ['0.1.0', '0.1.0', 0],
    ['0.10.0', '0.9.9', 1],
    ['1.0.0-rc.1', '1.0.0', -1],
    ['1.0.0-rc.2', '1.0.0-rc.10', -1],
    ['1.0.0-rc.1', '1.0.0-rc', 1],
    ['1.0.0-beta', '1.0.0-alpha', 1],
    ['1.0.0-1', '1.0.0-alpha', -1],
  ] as const)('orders %s against %s as %i', (a, b, order) => {
    expect(compareReleases(a, b)).toBe(order)
    expect(compareReleases(b, a)).toBe(order === 0 ? 0 : -order)
  })
})
