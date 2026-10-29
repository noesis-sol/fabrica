import { Duration, Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { execFileSync } from 'node:child_process'
import {
  type KeyObject,
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import {
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import {
  type InstallPlaces,
  distributionName,
  installPlaces,
  layer as updaterLayer,
} from '../src/update'

// Fixture releases of the engine for the tests of its update (spec §9.2, §20.4, §22.5), here and in the
// CLI's: each release's archive for one target, checksums.txt and its signature, laid out as GitHub
// serves them and served over HTTP from a local folder; a test's home with a version installed before,
// and the Updater on the fixture's releases, installing under that home.

/** The PATH the engine's commands run with here: Node's folder, and the system's, where tar and gzip are. */
export const PATH = `${NodePath.dirname(process.execPath)}:/usr/bin:/bin`

/** A new empty folder, its real path, removed with what it holds as the scope ends; short, as a socket's path must be. */
export const tempFolder = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(async () =>
      realpath(await mkdtemp(NodePath.join(tmpdir(), `fab-${prefix}-`))),
    ),
    folder =>
      Effect.promise(() => rm(folder, { recursive: true, force: true })),
  )

/** A shell script running `body`. */
export const shStub = (body: string): string => `#!/bin/sh\n${body}\n`

export interface KeyPair {
  readonly privateKey: KeyObject
  readonly publicPem: string
}

export const keyPair = (): KeyPair => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

export const releaseKey = keyPair()

export const target = 'linux-x64'
export const platform = { platform: 'linux', arch: 'x64' } as const

/** The fixture's `fabrica`: says where and how it ran in $HOME/ran, warns on stderr, prints `said`. */
export const launcher = (said: string) =>
  shStub(
    'printf \'%s %s\\n\' "$PWD" "$*" >> "$HOME/ran"\n' +
      'echo "a warning on stderr" >&2\n' +
      `echo '${said}'`,
  )

export interface FixtureRelease {
  readonly version: string
  /** Its launcher's text; by default one printing `fabrica v<version>`. */
  readonly launcher?: string
  /** Its archive's bytes aren't those checksums.txt has. */
  readonly tampered?: boolean
  /** The key its checksums.txt is signed with; the release key by default. */
  readonly key?: KeyPair
}

/** A folder holding each release's archive for `target`, checksums.txt and its signature, under download/v<version>/. */
export const fixtureReleases = Effect.fn(function* (
  releases: ReadonlyArray<FixtureRelease>,
) {
  const root = yield* tempFolder('releases')
  for (const release of releases) {
    const folder = NodePath.join(root, 'download', `v${release.version}`)
    const stage = NodePath.join(root, 'stage', release.version)
    const name = distributionName({ version: release.version, target })
    const bin = NodePath.join(stage, name, 'bin')
    yield* Effect.promise(async () => {
      await mkdir(folder, { recursive: true })
      await mkdir(bin, { recursive: true })
      await writeFile(
        NodePath.join(bin, 'fabrica'),
        release.launcher ?? launcher(`fabrica v${release.version}`),
      )
      await chmod(NodePath.join(bin, 'fabrica'), 0o755)
    })
    const archive = NodePath.join(folder, `${name}.tar.gz`)
    yield* Effect.sync(() =>
      execFileSync('tar', ['-czf', archive, '-C', stage, name], {
        cwd: root,
        env: { PATH, COPYFILE_DISABLE: '1' },
        stdio: 'ignore',
      }),
    )
    const bytes = yield* Effect.promise(() => readFile(archive))
    const sum = createHash('sha256').update(bytes).digest('hex')
    // Another target's archive beside it, as a release lists every target's.
    const other = 'a'.repeat(64)
    const checksums = Buffer.from(
      `${sum}  ${name}.tar.gz\n${other}  fabrica-${release.version}-darwin-arm64.tar.gz\n`,
    )
    const signature = sign(
      null,
      checksums,
      (release.key ?? releaseKey).privateKey,
    )
    yield* Effect.promise(async () => {
      if (release.tampered === true)
        await writeFile(archive, Buffer.concat([bytes, Buffer.from('x')]))
      await writeFile(NodePath.join(folder, 'checksums.txt'), checksums)
      await writeFile(NodePath.join(folder, 'checksums.txt.sig'), signature)
    })
  }
  return root
})

export interface Served {
  readonly url: string
  /** The paths asked for, in order. */
  readonly asked: Array<string>
}

/** The fixture `root` served over HTTP on the loopback, `latest/download/<name>` from the `latest` version's. */
export const serveReleases = ({
  root,
  latest,
}: {
  readonly root: string
  readonly latest: string
}) =>
  Effect.acquireRelease(
    Effect.callback<Served & { readonly server: Server }>(resume => {
      const asked: Array<string> = []
      const server = createServer((request, response) => {
        const path = new URL(request.url ?? '/', 'http://fixture').pathname
        asked.push(path)
        const file = path.startsWith('/latest/download/')
          ? NodePath.join(
              root,
              'download',
              `v${latest}`,
              path.slice('/latest/download/'.length),
            )
          : NodePath.join(root, path)
        readFile(file).then(
          bytes => {
            response.writeHead(200, {
              'content-type': 'application/octet-stream',
            })
            response.end(bytes)
          },
          () => {
            response.writeHead(404)
            response.end()
          },
        )
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port =
          address !== null && typeof address === 'object' ? address.port : 0
        resume(
          Effect.succeed({ server, url: `http://127.0.0.1:${port}`, asked }),
        )
      })
    }),
    ({ server }) =>
      Effect.callback<void>(resume => {
        server.closeAllConnections()
        server.close(() => resume(Effect.void))
      }),
  )

/** A host of the test's: its home, and the engine's install places under it. */
export const makeHome = Effect.fn(function* () {
  const root = yield* tempFolder('upd')
  const home = NodePath.join(root, 'home')
  yield* Effect.promise(() => mkdir(home))
  return { root, home, places: installPlaces(home) }
})

/** The process runner's host facts: the PATH above, and the test's home. */
export const runnerConfig = ({
  path,
  home,
}: {
  readonly path: string
  readonly home: string
}): RunnerConfig => ({
  hostEnvironment: { PATH: path, HOME: home, LANG: 'C', SECRET: 'never' },
  enginePriority: 0,
  priority: hostPriority,
  listProcesses,
  pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
  self: process.pid,
  killGrace: Duration.seconds(2),
  outputGrace: Duration.millis(200),
})

/** The Updater on the fixture's releases, signed with `keys`, installing under `home`. */
export const fixtureUpdater = ({
  releases,
  keys = [releaseKey.publicPem],
  home,
  path,
}: {
  readonly releases: string
  readonly keys?: ReadonlyArray<string>
  readonly home: string
  readonly path: string
}) =>
  updaterLayer({
    source: { releases, keys },
    places: installPlaces(home),
    host: platform,
  }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(runnerLayer(runnerConfig({ path, home }))),
    Layer.provide(layerClock),
  )

/** The entries of a folder, sorted; none where it isn't there. */
export const entries = (folder: string) =>
  Effect.promise(() =>
    readdir(folder).then(
      names => names.toSorted(),
      () => [],
    ),
  )

/** A version installed by an earlier install, linked from `fabrica`. */
export const installedBefore = Effect.fn(function* (
  places: InstallPlaces,
  version: string,
) {
  const bin = NodePath.join(places.engines, version, 'bin')
  yield* Effect.promise(async () => {
    await mkdir(bin, { recursive: true })
    await writeFile(
      NodePath.join(bin, 'fabrica'),
      launcher(`fabrica v${version}`),
    )
    await chmod(NodePath.join(bin, 'fabrica'), 0o755)
    await mkdir(NodePath.dirname(places.link), { recursive: true })
    await symlink(NodePath.join(bin, 'fabrica'), places.link)
  })
})
