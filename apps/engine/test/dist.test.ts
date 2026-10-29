import { Context, Effect, Layer, Option } from 'effect'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, layer } from '@effect/vitest'
import { Toolbox, layerToolbox, runCommand, tempFolder } from '@fabrica/testkit'

import {
  type Distribution,
  DistributionFailure,
  type Download,
  buildDistribution,
  fetchPinned,
  nodePin,
  sha256Of,
} from '../build/distribution'
import packageJson from '../package.json' with { type: 'json' }
import {
  DISTRIBUTION_LAYOUT,
  ENGINE_TARGETS,
  distributionName,
} from '../src/layout'

// The engine distribution (spec §22.1): built once for the file, from the repository's engine, Pi and
// extension, with a fixture standing in for Node's archive: a link to the Node running the tests, so
// any host builds and runs any target's archive, and nothing is downloaded. The archive is unpacked
// outside the repository and run there, as an install would.

const app = fileURLToPath(new URL('..', import.meta.url))
const repository = join(app, '..', '..')

const TARGET = 'linux-arm64'
const VERSION = '9.8.7-test'
const NAME = distributionName({ version: VERSION, target: TARGET })
const NODE_TOP = `node-v26.13.0-${TARGET}`

/** A download the build must not make: the cache holds the pinned file. */
const offline: Download = url =>
  Effect.fail(DistributionFailure.Download({ url, message: 'offline' }))

/** A built distribution, and the folder its archive was unpacked into. */
class Built extends Context.Service<
  Built,
  {
    readonly made: Distribution
    readonly out: string
    readonly root: string
  }
>()('Built') {}

const layerBuilt = Layer.effect(
  Built,
  Effect.gen(function* () {
    const tools = yield* Toolbox
    const [fixture, out, unpacked] = yield* Effect.all([
      tempFolder('dist-node'),
      tempFolder('dist-out'),
      tempFolder('dist-unpacked'),
    ])
    const cache = join(out, 'cache')
    yield* Effect.promise(async () => {
      await mkdir(join(fixture, NODE_TOP, 'bin'), { recursive: true })
      await mkdir(cache)
      await symlink(process.execPath, join(fixture, NODE_TOP, 'bin', 'node'))
      await writeFile(join(fixture, NODE_TOP, 'LICENSE'), "Node's licence\n")
    })
    const nodeArchive = join(cache, `${NODE_TOP}.tar.gz`)
    yield* runCommand({
      command: 'tar',
      args: ['-czf', nodeArchive, '-C', fixture, NODE_TOP],
      cwd: fixture,
      env: tools.env(),
    })
    const made = yield* buildDistribution({
      target: TARGET,
      version: VERSION,
      node: {
        url: `https://nodejs.org/dist/v26.13.0/${NODE_TOP}.tar.gz`,
        sha256: yield* Effect.promise(() => sha256Of(nodeArchive)),
      },
      app,
      extension: join(repository, 'packages', 'pi-extension'),
      out,
      download: offline,
      env: tools.env(),
    })
    yield* runCommand({
      command: 'tar',
      args: ['-xzf', made.archive, '-C', unpacked],
      cwd: unpacked,
      env: tools.env(),
    })
    return { made, out, root: join(unpacked, NAME) }
  }),
).pipe(Layer.provideMerge(layerToolbox({ tools: ['tar', 'gzip', 'readlink'] })))

layer(layerBuilt, { timeout: '3 minutes' })('the engine distribution', it => {
  it.effect('names its archive for its version and target', () =>
    Effect.gen(function* () {
      const { made, out } = yield* Built
      expect(made.archive).toBe(join(out, `${NAME}.tar.gz`))
    }),
  )

  it.effect("lists the archive's checksum in checksums.txt", () =>
    Effect.gen(function* () {
      const { made } = yield* Built
      const [listed, actual] = yield* Effect.promise(() =>
        Promise.all([readFile(made.checksums, 'utf8'), sha256Of(made.archive)]),
      )
      expect(made.sha256).toBe(actual)
      expect(listed).toBe(`${actual}  ${NAME}.tar.gz\n`)
    }),
  )

  it.effect('holds one folder, named as the archive', () =>
    Effect.gen(function* () {
      const { made } = yield* Built
      const tools = yield* Toolbox
      const listing = yield* runCommand({
        command: 'tar',
        args: ['-tzf', made.archive],
        cwd: tools.home,
        env: tools.env(),
      })
      const entries = listing.split('\n').filter(entry => entry !== '')
      expect(entries.filter(entry => !entry.startsWith(`${NAME}/`))).toEqual([])
      // No AppleDouble files, which macOS's tar adds for extended attributes.
      expect(entries.filter(entry => entry.includes('/._'))).toEqual([])
      // Pi's source maps and type declarations are left out: nothing reads them.
      expect(
        entries.filter(entry => /\.(map|d\.ts|d\.mts|d\.cts)$/.test(entry)),
      ).toEqual([])
    }),
  )

  it.effect("has each of the layout's parts", () =>
    Effect.gen(function* () {
      const { root } = yield* Built
      const missing = yield* Effect.promise(() =>
        Promise.all(
          Object.values(DISTRIBUTION_LAYOUT).map(part =>
            access(join(root, part)).then(
              () => [],
              () => [part],
            ),
          ),
        ),
      )
      expect(missing.flat()).toEqual([])
    }),
  )

  it.effect('makes the launcher executable', () =>
    Effect.gen(function* () {
      const { root } = yield* Built
      const launcher = join(root, DISTRIBUTION_LAYOUT.launcher)
      const executable = yield* Effect.promise(() =>
        access(launcher, constants.X_OK).then(
          () => true,
          () => false,
        ),
      )
      expect(executable).toBe(true)
    }),
  )

  it.effect('ships Pi at the version apps/engine pins', () =>
    Effect.gen(function* () {
      const { root } = yield* Built
      const pi = yield* Effect.promise(() =>
        readFile(join(root, DISTRIBUTION_LAYOUT.pi, 'package.json'), 'utf8'),
      )
      expect(JSON.parse(pi)).toMatchObject({
        name: '@earendil-works/pi-coding-agent',
        version: packageJson.dependencies['@earendil-works/pi-coding-agent'],
      })
    }),
  )

  it.effect(
    'runs fabrica --version on its Node, away from the repository',
    () =>
      Effect.gen(function* () {
        const { root } = yield* Built
        const tools = yield* Toolbox
        const out = yield* runCommand({
          command: join(root, DISTRIBUTION_LAYOUT.launcher),
          args: ['--version'],
          cwd: tools.home,
          env: tools.env(),
        })
        expect(out).toBe(`fabrica v${packageJson.version}\n`)
      }),
  )

  it.effect('runs through a link to the launcher, as an install makes', () =>
    Effect.gen(function* () {
      const { root } = yield* Built
      const tools = yield* Toolbox
      const bin = yield* tempFolder('dist-bin')
      const link = join(bin, 'fabrica')
      yield* Effect.promise(() =>
        symlink(join(root, DISTRIBUTION_LAYOUT.launcher), link),
      )
      const out = yield* runCommand({
        command: link,
        args: ['--version'],
        cwd: tools.home,
        env: tools.env(),
      })
      expect(out).toBe(`fabrica v${packageJson.version}\n`)
    }),
  )

  it.effect('runs Pi from its own folder, its dependencies beside it', () =>
    Effect.gen(function* () {
      const { root } = yield* Built
      const tools = yield* Toolbox
      const out = yield* runCommand({
        command: join(root, DISTRIBUTION_LAYOUT.node),
        args: [join(root, DISTRIBUTION_LAYOUT.piCli), '--version'],
        cwd: tools.home,
        env: tools.env({ PI_CODING_AGENT_DIR: join(tools.home, 'pi') }),
      })
      expect(out.trim()).toBe(
        packageJson.dependencies['@earendil-works/pi-coding-agent'],
      )
    }),
  )

  it.effect("keeps Node's licence beside its binary", () =>
    Effect.gen(function* () {
      const { root } = yield* Built
      const licence = yield* Effect.promise(() =>
        readFile(join(root, DISTRIBUTION_LAYOUT.nodeLicense), 'utf8'),
      )
      expect(licence).toBe("Node's licence\n")
    }),
  )
})

describe('nodePin', () => {
  it.effect(
    'reads a Node archive and its checksum for every engine target from mise.lock',
    () =>
      Effect.gen(function* () {
        const lock = yield* Effect.promise(() =>
          readFile(join(repository, 'mise.lock'), 'utf8'),
        )
        for (const target of ENGINE_TARGETS) {
          const pin = Option.getOrThrow(nodePin(lock, target))
          expect(pin.url).toMatch(
            new RegExp(
              `^https://nodejs\\.org/dist/v[0-9.]+/node-v[0-9.]+-${target}\\.tar\\.gz$`,
            ),
          )
          expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/)
        }
      }),
  )

  it('names macOS as mise does, and finds nothing for a platform it lacks', () => {
    const lock = [
      '[tools.node."platforms.macos-arm64"]',
      `checksum = "sha256:${'a'.repeat(64)}"`,
      'url = "https://nodejs.org/dist/v1.0.0/node-v1.0.0-darwin-arm64.tar.gz"',
      '',
      '[tools.pnpm."platforms.linux-x64"]',
      `checksum = "sha256:${'b'.repeat(64)}"`,
      'url = "https://example.com/pnpm-linux-x64.tar.gz"',
    ].join('\n')
    expect(nodePin(lock, 'darwin-arm64')).toEqual(
      Option.some({
        url: 'https://nodejs.org/dist/v1.0.0/node-v1.0.0-darwin-arm64.tar.gz',
        sha256: 'a'.repeat(64),
      }),
    )
    expect(nodePin(lock, 'linux-x64')).toEqual(Option.none())
  })
})

describe('fetchPinned', () => {
  const NODE = 'node-v1.0.0-linux-x64.tar.gz'
  const url = `https://nodejs.org/dist/v1.0.0/${NODE}`
  const sha256 = (text: string) =>
    createHash('sha256').update(text).digest('hex')

  /** A download writing `text`, counting its calls. */
  const writing = (text: string) => {
    const calls: Array<string> = []
    const download: Download = (from, file) =>
      Effect.promise(async () => {
        calls.push(from)
        await writeFile(file, text)
      })
    return { calls, download }
  }

  it.effect('downloads a file missing from the cache, and keeps it', () =>
    Effect.gen(function* () {
      const cache = yield* tempFolder('dist-cache')
      const pin = { url, sha256: sha256('node') }
      const { calls, download } = writing('node')
      const file = yield* fetchPinned({ pin, cache, download })
      expect(file).toBe(join(cache, NODE))
      yield* fetchPinned({ pin, cache, download })
      expect(calls).toEqual([url])
    }),
  )

  it.effect(
    "downloads again over a cached file that isn't the pinned one",
    () =>
      Effect.gen(function* () {
        const cache = yield* tempFolder('dist-cache')
        yield* Effect.promise(() => writeFile(join(cache, NODE), 'stale'))
        const { calls, download } = writing('node')
        yield* fetchPinned({
          pin: { url, sha256: sha256('node') },
          cache,
          download,
        })
        expect(calls).toEqual([url])
      }),
  )

  it.effect("refuses a download that isn't the pinned file, and drops it", () =>
    Effect.gen(function* () {
      const cache = yield* tempFolder('dist-cache')
      const pin = { url, sha256: sha256('node') }
      const { download } = writing('not node')
      const failure = yield* Effect.flip(fetchPinned({ pin, cache, download }))
      expect(failure).toEqual(
        DistributionFailure.ChecksumMismatch({
          file: NODE,
          expected: sha256('node'),
          actual: sha256('not node'),
        }),
      )
      const kept = yield* Effect.promise(() =>
        lstat(join(cache, NODE)).then(
          () => true,
          () => false,
        ),
      )
      expect(kept).toBe(false)
    }),
  )
})
