import { Effect, Option } from 'effect'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, layer } from '@effect/vitest'
import { Toolbox, runCommand, tempFolder } from '@fabrica/testkit'

import {
  DistributionFailure,
  type Download,
  fetchPinned,
  nodePin,
  sha256Of,
} from '../build/distribution'
import packageJson from '../package.json' with { type: 'json' }
import { DISTRIBUTION_LAYOUT, ENGINE_TARGETS } from '../src/layout'
import { Built, layerBuilt, repository } from './built-distribution'

// The engine distribution (spec §22.1), built once for the file as built-distribution.ts says.

layer(layerBuilt, { timeout: '3 minutes' })('the engine distribution', it => {
  it.effect('names its archive for its version and target', () =>
    Effect.gen(function* () {
      const { made, name, out } = yield* Built
      expect(made.archive).toBe(join(out, `${name}.tar.gz`))
    }),
  )

  it.effect("lists the archive's checksum in checksums.txt", () =>
    Effect.gen(function* () {
      const { made, name } = yield* Built
      const [listed, actual] = yield* Effect.promise(() =>
        Promise.all([readFile(made.checksums, 'utf8'), sha256Of(made.archive)]),
      )
      expect(made.sha256).toBe(actual)
      expect(listed).toBe(`${actual}  ${name}.tar.gz\n`)
    }),
  )

  it.effect('holds one folder, named as the archive', () =>
    Effect.gen(function* () {
      const { made, name } = yield* Built
      const tools = yield* Toolbox
      const listing = yield* runCommand({
        command: 'tar',
        args: ['-tzf', made.archive],
        cwd: tools.home,
        env: tools.env(),
      })
      const entries = listing.split('\n').filter(entry => entry !== '')
      expect(entries.filter(entry => !entry.startsWith(`${name}/`))).toEqual([])
      // No AppleDouble files, which macOS's tar adds for extended attributes.
      expect(entries.filter(entry => entry.includes('/._'))).toEqual([])
      // Pi's and DuckDB's source maps and type declarations are left out: nothing reads them.
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
          expect(pin.hash).toBe('sha256')
          expect(pin.checksum).toMatch(/^[0-9a-f]{64}$/)
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
        hash: 'sha256',
        checksum: 'a'.repeat(64),
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
      const pin = { url, hash: 'sha256' as const, checksum: sha256('node') }
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
          pin: { url, hash: 'sha256', checksum: sha256('node') },
          cache,
          download,
        })
        expect(calls).toEqual([url])
      }),
  )

  it.effect("refuses a download that isn't the pinned file, and drops it", () =>
    Effect.gen(function* () {
      const cache = yield* tempFolder('dist-cache')
      const pin = { url, hash: 'sha256' as const, checksum: sha256('node') }
      const { download } = writing('not node')
      const failure = yield* Effect.flip(fetchPinned({ pin, cache, download }))
      expect(failure).toEqual(
        DistributionFailure.ChecksumMismatch({
          file: NODE,
          hash: 'sha256',
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
