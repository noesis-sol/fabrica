import { Context, Effect, Layer } from 'effect'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Toolbox, layerToolbox, runCommand, tempFolder } from '@fabrica/testkit'

import {
  type Distribution,
  DistributionFailure,
  type Download,
  buildDistribution,
  digestOf,
  duckDbNative,
  sha256Of,
} from '../build/distribution'
import {
  ENGINE_TARGETS,
  type EngineTarget,
  distributionName,
} from '../src/layout'

// The engine distribution (spec §22.1) its tests check: built once for a test file, from the
// repository's engine, DuckDB, Pi and extension, for the target of the Node running the tests, whose
// DuckDB loads there. Fixtures stand in for what the build downloads, so nothing is: Node's archive
// holds a link to the Node running the tests, and DuckDB's native package is the one pnpm installed
// here, its library linked, with pnpm-lock.yaml's pin for it given by the fixture's integrity. The
// archive is unpacked outside the repository and run there, as an install would.

export const app = fileURLToPath(new URL('..', import.meta.url))
export const repository = join(app, '..', '..')

export const VERSION = '9.8.7-test'

/** A download the build must not make: the cache holds the pinned file. */
export const offline: Download = url =>
  Effect.fail(DistributionFailure.Download({ url, message: 'offline' }))

/** A built distribution, its target and name, and the folder its archive was unpacked into. */
export class Built extends Context.Service<
  Built,
  {
    readonly made: Distribution
    readonly target: EngineTarget
    readonly name: string
    readonly out: string
    readonly root: string
  }
>()('Built') {}

/** `@duckdb/node-bindings` where pnpm installed it, and the version of each native package it names. */
export const installedBindings = Effect.promise(async () => {
  const folder = await realpath(
    join(
      await realpath(join(app, 'node_modules', '@duckdb', 'node-api')),
      '..',
      'node-bindings',
    ),
  )
  const manifest: {
    readonly optionalDependencies: Readonly<Record<string, string>>
  } = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'))
  return { folder, natives: manifest.optionalDependencies }
})

const isTarget = (name: string): name is EngineTarget =>
  ENGINE_TARGETS.some(target => target === name)

/**
 * A tarball of DuckDB's native package for `target`, as npm's registry serves one, written to `file`
 * from the package pnpm installed: its files copied, its library (`libduckdb.*`, a hundred megabytes)
 * linked.
 */
const nativeFixture = ({
  installed,
  file,
}: {
  readonly installed: string
  readonly file: string
}) =>
  Effect.gen(function* () {
    const tools = yield* Toolbox
    const fixture = yield* tempFolder('dist-duckdb')
    const into = join(fixture, 'package')
    yield* Effect.promise(async () => {
      await mkdir(into)
      for (const entry of await readdir(installed))
        await (entry.startsWith('libduckdb')
          ? symlink(join(installed, entry), join(into, entry))
          : copyFile(join(installed, entry), join(into, entry)))
    })
    yield* runCommand({
      command: 'tar',
      args: ['-czf', file, '-C', fixture, 'package'],
      cwd: fixture,
      env: tools.env(),
    })
  })

export const layerBuilt = Layer.effect(
  Built,
  Effect.gen(function* () {
    const tools = yield* Toolbox
    const host = `${process.platform}-${process.arch}`
    if (!isTarget(host))
      return yield* Effect.die(`the tests run on no engine target: ${host}`)
    const target = host
    const name = distributionName({ version: VERSION, target })
    const nodeTop = `node-v26.13.0-${target}`
    const [fixture, out, unpacked] = yield* Effect.all([
      tempFolder('dist-node'),
      tempFolder('dist-out'),
      tempFolder('dist-unpacked'),
    ])
    const cache = join(out, 'cache')
    yield* Effect.promise(async () => {
      await mkdir(join(fixture, nodeTop, 'bin'), { recursive: true })
      await mkdir(cache)
      await symlink(process.execPath, join(fixture, nodeTop, 'bin', 'node'))
      await writeFile(join(fixture, nodeTop, 'LICENSE'), "Node's licence\n")
    })
    const nodeArchive = join(cache, `${nodeTop}.tar.gz`)
    yield* runCommand({
      command: 'tar',
      args: ['-czf', nodeArchive, '-C', fixture, nodeTop],
      cwd: fixture,
      env: tools.env(),
    })

    // DuckDB's native package, where pnpm installed it beside `@duckdb/node-bindings`.
    const native = duckDbNative(target)
    const bindings = yield* installedBindings
    const version = bindings.natives[native] ?? ''
    const nativeTarball = join(
      cache,
      `${native.slice('@duckdb/'.length)}-${version}.tgz`,
    )
    yield* nativeFixture({
      installed: yield* Effect.promise(() =>
        realpath(join(bindings.folder, '..', native.slice('@duckdb/'.length))),
      ),
      file: nativeTarball,
    })
    const integrity = yield* Effect.promise(() =>
      digestOf(nativeTarball, 'sha512'),
    )
    const lockfile = [
      `  '${native}@${version}':`,
      `    resolution: {integrity: sha512-${Buffer.from(integrity, 'hex').toString('base64')}}`,
      '',
    ].join('\n')

    const made = yield* buildDistribution({
      target,
      version: VERSION,
      node: {
        url: `https://nodejs.org/dist/v26.13.0/${nodeTop}.tar.gz`,
        hash: 'sha256',
        checksum: yield* Effect.promise(() => sha256Of(nodeArchive)),
      },
      lockfile,
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
    return { made, target, name, out, root: join(unpacked, name) }
  }),
).pipe(Layer.provideMerge(layerToolbox({ tools: ['tar', 'gzip', 'readlink'] })))
