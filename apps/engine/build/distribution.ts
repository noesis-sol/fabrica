// The engine distribution's build (spec §22.1): per engine target, one tar.gz holding the pinned Node
// runtime, the engine bundle, DuckDB, Pi and the first-party extension at exact versions, and the
// `fabrica` launcher, laid out as `src/layout.ts` says; and `checksums.txt` over the version's archives.
//
// Node's archive for the target is the one mise.lock pins, by URL and checksum (§20.4): downloaded
// once into a cache, and checked against the checksum each time it is used. Pi and DuckDB are copied
// with the dependencies pnpm installed for them from the committed lockfile, as pnpm laid them out. The
// bundles are pure JavaScript and Pi's few native files come prebuilt for every platform in its own
// packages; DuckDB's native library is in a package per platform, of which pnpm installs only the
// host's, so the target's is fetched from npm's registry as the lockfile pins it, by version and
// integrity, into the same cache. Any host builds every target's archive.
//
// Node runs the build itself (`node build/dist.ts`), stripping its types: relative imports name their
// `.ts` files.

import { Data, Effect, Option, Schema } from 'effect'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import * as NodePath from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { build as viteBuild } from 'vite'

import {
  DISTRIBUTION_LAYOUT,
  type EngineTarget,
  distributionName,
} from '../src/layout.ts'

/** Why a distribution couldn't be built. */
export type DistributionFailure = Data.TaggedEnum<{
  /** mise.lock pins no Node archive for the target's platform. */
  NodeNotPinned: { readonly platform: string }
  /** A downloaded file isn't the one its pin names. */
  ChecksumMismatch: {
    readonly file: string
    readonly hash: Hash
    readonly expected: string
    readonly actual: string
  }
  /** A URL couldn't be fetched. */
  Download: { readonly url: string; readonly message: string }
  /** A package pnpm installed, Pi or DuckDB, isn't laid out as the distribution expects it. */
  PackageLayout: { readonly message: string }
  /** pnpm-lock.yaml pins no integrity for a package the distribution fetches. */
  NotInLockfile: { readonly name: string; readonly version: string }
  /** A step of the build failed: a bundle, a copy, a command. */
  Step: { readonly step: string; readonly message: string }
}>
export const DistributionFailure = Data.taggedEnum<DistributionFailure>()

export class DistributionFailed extends Data.TaggedError('DistributionFailed')<{
  readonly target: EngineTarget
  readonly reason: DistributionFailure
}> {
  override get message() {
    return `${this.target}: ${DistributionFailure.$match(this.reason, {
      NodeNotPinned: ({ platform }) =>
        `mise.lock pins no Node archive for ${platform}`,
      ChecksumMismatch: ({ file, hash, expected, actual }) =>
        `${file}: ${hash} ${actual}, but its pin is ${expected}`,
      Download: ({ url, message }) => `${url}: ${message}`,
      PackageLayout: ({ message }) => message,
      NotInLockfile: ({ name, version }) =>
        `pnpm-lock.yaml pins no integrity for ${name}@${version}`,
      Step: ({ step, message }) => `${step}: ${message}`,
    })}`
  }
}

/** The hashes a pin's checksum is in: sha256 for mise.lock's, sha512 for pnpm-lock.yaml's integrity. */
export type Hash = 'sha256' | 'sha512'

/** A pinned download: where it is, and its checksum in hex, by the hash it names. */
export interface Pin {
  readonly url: string
  readonly hash: Hash
  readonly checksum: string
}

/** mise's name for a target's platform: `macos` for `darwin`. */
const misePlatform = (target: EngineTarget): string =>
  target.startsWith('darwin-')
    ? `macos-${target.slice('darwin-'.length)}`
    : target

/** The Node archive mise.lock pins for a target: its `[tools.node."platforms.<platform>"]` entry. */
export const nodePin = (
  lock: string,
  target: EngineTarget,
): Option.Option<Pin> => {
  const header = `[tools.node."platforms.${misePlatform(target)}"]`
  const lines = lock.split('\n')
  const start = lines.findIndex(line => line.trim() === header)
  if (start === -1) return Option.none()
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => line.trim().startsWith('['))
  const entry = end === -1 ? rest : rest.slice(0, end)
  const value = (pattern: RegExp) =>
    Option.fromNullishOr(
      entry.map(line => pattern.exec(line.trim())?.[1]).find(Boolean),
    )
  return Option.all({
    url: value(/^url = "(https:\/\/[^"]+\.tar\.gz)"$/),
    hash: Option.some<Hash>('sha256'),
    checksum: value(/^checksum = "sha256:([0-9a-f]{64})"$/),
  })
}

/**
 * The tarball pnpm-lock.yaml pins for a package of npm's registry, by its integrity in the lockfile's
 * `packages` section: `'<name>@<version>':` and, on the line after it, `resolution: {integrity: …}`.
 */
export const npmPin = (
  lock: string,
  { name, version }: { readonly name: string; readonly version: string },
): Option.Option<Pin> => {
  const header = `'${name}@${version}':`
  const lines = lock.split('\n')
  const integrity = lines
    .flatMap((line, index) =>
      line.trim() === header
        ? [
            /^resolution: \{integrity: sha512-([A-Za-z0-9+/]{86}==)\}$/.exec(
              lines[index + 1]?.trim() ?? '',
            )?.[1],
          ]
        : [],
    )
    .find(Boolean)
  const file = `${name.slice(name.indexOf('/') + 1)}-${version}.tgz`
  return Option.map(Option.fromNullishOr(integrity), (base64): Pin => ({
    url: `https://registry.npmjs.org/${name}/-/${file}`,
    hash: 'sha512',
    checksum: Buffer.from(base64, 'base64').toString('hex'),
  }))
}

/** Fetches a URL into a file. */
export type Download = (
  url: string,
  file: string,
) => Effect.Effect<void, DistributionFailure>

/** Fetches a URL into a file over HTTPS, through a partial file renamed once it is whole. */
export const httpsDownload: Download = (url, file) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url)
      if (!response.ok || response.body === null)
        throw new Error(`HTTP ${response.status}`)
      const partial = `${file}.partial`
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(partial),
      )
      await rename(partial, file)
    },
    catch: error =>
      DistributionFailure.Download({ url, message: String(error) }),
  })

/** A file's checksum by a hash, in hex. */
export const digestOf = async (file: string, hash: Hash): Promise<string> => {
  const digest = createHash(hash)
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}

/** A file's sha256, in hex. */
export const sha256Of = (file: string): Promise<string> =>
  digestOf(file, 'sha256')

const step = <A>(name: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: error =>
      DistributionFailure.Step({ step: name, message: String(error) }),
  })

/** Runs a command to its end; fails with what it said on stderr when it exits but 0. */
const runCommand = ({
  command,
  args,
  env,
}: {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string | undefined>>
}) =>
  Effect.callback<void, DistributionFailure>(resume => {
    const stderr: Array<Buffer> = []
    // A command that can't start reports an error, then may close too: the first ends it.
    let ended = false
    const end = (result: Effect.Effect<void, DistributionFailure>) => {
      if (ended) return
      ended = true
      resume(result)
    }
    const failed = (message: string) =>
      end(
        Effect.fail(
          DistributionFailure.Step({
            step: `${command} ${args.join(' ')}`,
            message,
          }),
        ),
      )
    const child = spawn(command, [...args], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', error => failed(error.message))
    child.on('close', code =>
      code === 0
        ? end(Effect.void)
        : failed(
            `exit ${code ?? 'by a signal'}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
          ),
    )
  })

/**
 * The pinned file in `cache`, downloaded when it is missing or isn't the pinned one, and checked
 * against its checksum before it is used.
 */
export const fetchPinned = Effect.fn('Distribution.fetchPinned')(function* ({
  pin,
  cache,
  download,
}: {
  readonly pin: Pin
  readonly cache: string
  readonly download: Download
}) {
  const file = NodePath.join(cache, NodePath.posix.basename(pin.url))
  const cached = yield* Effect.promise(() =>
    digestOf(file, pin.hash).then(Option.some, () => Option.none<string>()),
  )
  if (Option.contains(cached, pin.checksum)) return file
  yield* step('cache', () => mkdir(cache, { recursive: true }))
  yield* download(pin.url, file)
  const actual = yield* step('checksum', () => digestOf(file, pin.hash))
  if (actual === pin.checksum) return file
  yield* step('reject', () => rm(file, { force: true }))
  return yield* Effect.fail(
    DistributionFailure.ChecksumMismatch({
      file: NodePath.basename(file),
      hash: pin.hash,
      expected: pin.checksum,
      actual,
    }),
  )
})

/** Unpacks Node's binary and licence from its archive into the stage. */
const placeNode = Effect.fn('Distribution.placeNode')(function* ({
  archive,
  stage,
  env,
}: {
  readonly archive: string
  readonly stage: string
  readonly env: Readonly<Record<string, string | undefined>>
}) {
  // Node's archive holds one folder named as the archive.
  const top = NodePath.basename(archive, '.tar.gz')
  const unpacked = NodePath.join(stage, '.node')
  yield* step('unpack Node', () => mkdir(unpacked, { recursive: true }))
  yield* runCommand({
    command: 'tar',
    args: [
      '-xzf',
      archive,
      '-C',
      unpacked,
      `${top}/bin/node`,
      `${top}/LICENSE`,
    ],
    env,
  })
  yield* step('place Node', async () => {
    await mkdir(
      NodePath.dirname(NodePath.join(stage, DISTRIBUTION_LAYOUT.node)),
      { recursive: true },
    )
    await rename(
      NodePath.join(unpacked, top, 'bin', 'node'),
      NodePath.join(stage, DISTRIBUTION_LAYOUT.node),
    )
    await rename(
      NodePath.join(unpacked, top, 'LICENSE'),
      NodePath.join(stage, DISTRIBUTION_LAYOUT.nodeLicense),
    )
    await rm(unpacked, { recursive: true, force: true })
  })
})

/** Bundles the engine, `apps/engine` and `packages/engine`, as `vite.config.ts` says, into the stage. */
const bundleEngine = ({
  app,
  stage,
}: {
  readonly app: string
  readonly stage: string
}) =>
  step('bundle the engine', () =>
    viteBuild({
      root: app,
      configFile: NodePath.join(app, 'vite.config.ts'),
      logLevel: 'warn',
      build: {
        outDir: NodePath.dirname(
          NodePath.join(stage, DISTRIBUTION_LAYOUT.bundle),
        ),
        emptyOutDir: true,
      },
    }),
  )

/**
 * Bundles the first-party extension into the stage, every dependency in it but Pi's own packages,
 * which Pi gives the extensions it loads.
 */
const bundleExtension = ({
  extension,
  stage,
}: {
  readonly extension: string
  readonly stage: string
}) =>
  step('bundle the extension', () =>
    viteBuild({
      root: extension,
      configFile: false,
      logLevel: 'warn',
      build: {
        ssr: 'src/index.ts',
        target: 'node26',
        outDir: NodePath.dirname(
          NodePath.join(stage, DISTRIBUTION_LAYOUT.extension),
        ),
        emptyOutDir: true,
        rollupOptions: { external: [/^@earendil-works\//, /^typebox(\/|$)/] },
      },
      ssr: { noExternal: true, target: 'node' },
    }),
  )

const PI_PACKAGE = '@earendil-works/pi-coding-agent'

/** A package installed by pnpm: the folder holding its `node_modules`, and its name there. */
interface Installed {
  readonly entry: string
  readonly name: string
}

/** The pnpm entry of a package's real folder, `<entry>/node_modules/<name>`. */
const installedAt = (real: string, name: string): Installed => ({
  entry: real.slice(0, real.length - `/node_modules/${name}`.length),
  name,
})

/** The names in an entry's `node_modules`, scoped ones as `@scope/name`. */
const namesIn = async (modules: string): Promise<ReadonlyArray<string>> => {
  const names = await readdir(modules)
  const scoped = await Promise.all(
    names
      .filter(name => !name.startsWith('.'))
      .map(async name =>
        name.startsWith('@')
          ? (await readdir(NodePath.join(modules, name))).map(
              inner => `${name}/${inner}`,
            )
          : [name],
      ),
  )
  return scoped.flat()
}

/** Files a running program never reads: source maps and type declarations. */
const unread = /\.(map|d\.ts|d\.mts|d\.cts)$/

/** A package copied into a distribution: its name, and the folder it was copied into. */
interface Placed {
  readonly name: string
  readonly folder: string
}

/**
 * Copies a package and every package it reaches into `<to>/node_modules`, as pnpm laid them out: each
 * pnpm entry under `.pnpm`, its own package and its links to its dependencies' entries, and
 * `<to>/node_modules/<name>` a link to the package's. The dependencies `leaveOut` names are neither
 * linked nor copied. Answers with every package copied, the links aside.
 */
const copyInstalled = Effect.fn('Distribution.copyInstalled')(function* ({
  from,
  name,
  to,
  leaveOut,
}: {
  /** The package's folder, or a link to it, where pnpm installed it. */
  readonly from: string
  readonly name: string
  readonly to: string
  readonly leaveOut: (name: string) => boolean
}) {
  const store = NodePath.join(to, 'node_modules', '.pnpm')
  const placed = (installed: Installed) =>
    NodePath.join(
      store,
      NodePath.basename(installed.entry),
      'node_modules',
      installed.name,
    )
  const root = installedAt(
    yield* step(`find ${name}`, () => realpath(from)),
    name,
  )
  const seen = new Map<string, string>()
  const copied: Array<Placed> = []
  const queue = [root.entry]
  // The loop reaches the entries it adds as it goes.
  for (const entry of queue) {
    const id = NodePath.basename(entry)
    const earlier = seen.get(id)
    if (earlier === entry) continue
    if (earlier !== undefined)
      return yield* Effect.fail(
        DistributionFailure.PackageLayout({
          message: `two pnpm entries named ${id}: ${earlier} and ${entry}`,
        }),
      )
    seen.set(id, entry)
    const modules = NodePath.join(entry, 'node_modules')
    const names = yield* step(`read ${name}`, () => namesIn(modules))
    for (const inner of names) {
      const source = NodePath.join(modules, inner)
      const into = placed({ entry, name: inner })
      const info = yield* step(`read ${name}`, () => lstat(source))
      if (info.isSymbolicLink()) {
        if (leaveOut(inner)) continue
        const dependency = installedAt(
          yield* step(`read ${name}`, () => realpath(source)),
          inner,
        )
        queue.push(dependency.entry)
        yield* step(`link ${name}`, async () => {
          await mkdir(NodePath.dirname(into), { recursive: true })
          await symlink(
            NodePath.relative(NodePath.dirname(into), placed(dependency)),
            into,
          )
        })
      } else {
        yield* step(`copy ${name}`, () =>
          cp(source, into, {
            recursive: true,
            verbatimSymlinks: true,
            filter: file => !unread.test(file),
          }),
        )
        copied.push({ name: inner, folder: into })
      }
    }
  }
  const link = NodePath.join(to, 'node_modules', name)
  yield* step(`link ${name}`, async () => {
    await mkdir(NodePath.dirname(link), { recursive: true })
    await symlink(NodePath.relative(NodePath.dirname(link), placed(root)), link)
  })
  return copied
})

const DUCKDB_PACKAGE = '@duckdb/node-api'
const DUCKDB_BINDINGS = '@duckdb/node-bindings'

/** What the build reads of `@duckdb/node-bindings`'s manifest: its native packages, by version. */
const decodeBindingsManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      optionalDependencies: Schema.Record(Schema.String, Schema.String),
    }),
  ),
)

/** DuckDB's packages holding its native library, one per platform: `@duckdb/node-bindings-<platform>`. */
const isDuckDbNative = (name: string) => name.startsWith(`${DUCKDB_BINDINGS}-`)

/**
 * The package holding DuckDB's native library for a target. The Linux targets' are glibc's, as the
 * distribution's Node is built for glibc, and DuckDB loads its musl package only on musl.
 */
export const duckDbNative = (target: EngineTarget): string =>
  `${DUCKDB_BINDINGS}-${target}`

/**
 * Copies DuckDB, the engine's `@duckdb/node-api`, and the packages it reaches into `<to>/node_modules`,
 * with the target's native package in place of the host's: the version `@duckdb/node-bindings` names
 * for it, fetched as pnpm-lock.yaml pins it into `cache`, unpacked into its own pnpm entry and linked
 * from `@duckdb/node-bindings`'s, where DuckDB requires it.
 */
const copyDuckDb = Effect.fn('Distribution.copyDuckDb')(function* ({
  from,
  to,
  target,
  lockfile,
  cache,
  download,
  env,
}: {
  /** `@duckdb/node-api` where pnpm installed it for the engine. */
  readonly from: string
  readonly to: string
  readonly target: EngineTarget
  /** pnpm-lock.yaml's text. */
  readonly lockfile: string
  readonly cache: string
  readonly download: Download
  readonly env: Readonly<Record<string, string | undefined>>
}) {
  const copied = yield* copyInstalled({
    from,
    name: DUCKDB_PACKAGE,
    to,
    leaveOut: isDuckDbNative,
  })
  const bindings = copied.filter(({ name }) => name === DUCKDB_BINDINGS)
  const [only] = bindings
  if (only === undefined || bindings.length > 1)
    return yield* Effect.fail(
      DistributionFailure.PackageLayout({
        message: `${DUCKDB_PACKAGE} reaches ${bindings.length} copies of ${DUCKDB_BINDINGS}, not one`,
      }),
    )
  const name = duckDbNative(target)
  const manifest = yield* step(`read ${DUCKDB_BINDINGS}`, () =>
    readFile(NodePath.join(only.folder, 'package.json'), 'utf8'),
  )
  const version = decodeBindingsManifest(manifest).pipe(
    Option.flatMap(({ optionalDependencies }) =>
      Option.fromNullishOr(optionalDependencies[name]),
    ),
  )
  if (Option.isNone(version))
    return yield* Effect.fail(
      DistributionFailure.PackageLayout({
        message: `${DUCKDB_BINDINGS} names no ${name}`,
      }),
    )
  const pin = yield* Option.match(
    npmPin(lockfile, { name, version: version.value }),
    {
      onNone: () =>
        Effect.fail(
          DistributionFailure.NotInLockfile({ name, version: version.value }),
        ),
      onSome: Effect.succeed,
    },
  )
  const tarball = yield* fetchPinned({ pin, cache, download })
  // An npm tarball holds one folder, `package`; pnpm names an entry `<scope>+<name>@<version>`.
  const entry = NodePath.join(
    to,
    'node_modules',
    '.pnpm',
    `${name.replace('/', '+')}@${version.value}`,
  )
  const into = NodePath.join(entry, 'node_modules', name)
  yield* step(`unpack ${name}`, () => mkdir(entry, { recursive: true }))
  yield* runCommand({
    command: 'tar',
    args: ['-xzf', tarball, '-C', entry, 'package'],
    env,
  })
  yield* step(`place ${name}`, async () => {
    await mkdir(NodePath.dirname(into), { recursive: true })
    await rename(NodePath.join(entry, 'package'), into)
    // Beside `@duckdb/node-bindings` in its entry's `node_modules`.
    const link = NodePath.join(
      only.folder.slice(0, only.folder.length - DUCKDB_BINDINGS.length),
      name,
    )
    await mkdir(NodePath.dirname(link), { recursive: true })
    await symlink(NodePath.relative(NodePath.dirname(link), into), link)
  })
})

/** Checks that Pi's CLI is where the layout says, so a Pi that moved it fails the build, not an agent. */
const checkPiCli = Effect.fn('Distribution.checkPiCli')(function* (
  stage: string,
) {
  const manifest = yield* step('read Pi', () =>
    readFile(
      NodePath.join(stage, DISTRIBUTION_LAYOUT.pi, 'package.json'),
      'utf8',
    ),
  )
  const cli = /"pi"\s*:\s*"([^"]+)"/.exec(manifest)?.[1]
  const expected = NodePath.posix.relative(
    DISTRIBUTION_LAYOUT.pi,
    DISTRIBUTION_LAYOUT.piCli,
  )
  if (cli === undefined || NodePath.posix.normalize(cli) !== expected)
    return yield* Effect.fail(
      DistributionFailure.PackageLayout({
        message: `Pi's bin is ${cli ?? 'missing'}, the layout's ${expected}`,
      }),
    )
})

/**
 * The `fabrica` command: finds the distribution's folder through any links to it (the install script
 * links it into a folder on the PATH), then runs the bundled Node on the bundle. It runs no command
 * but `readlink`, and that only when it was reached through a link.
 */
export const LAUNCHER = `#!/bin/sh
# fabrica: runs the engine bundle on the engine distribution's own Node.
self=$0
while [ -h "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=\${self%/*}/$link ;;
  esac
done
case $self in
  */*) bin=\${self%/*} ;;
  *) bin=. ;;
esac
root=$(cd -P "$bin/.." && pwd) || exit 1
exec "$root/${DISTRIBUTION_LAYOUT.node}" "$root/${DISTRIBUTION_LAYOUT.bundle}" "$@"
`

/**
 * The total size of what a folder holds, links counted as themselves: walked by hand, since Node's
 * recursive `readdir` follows links to folders, and would count each package pnpm links twice.
 */
export const sizeOf = async (folder: string): Promise<number> => {
  const names = await readdir(folder)
  const sizes = await Promise.all(
    names.map(async name => {
      const path = NodePath.join(folder, name)
      const info = await lstat(path)
      return info.isDirectory() ? info.size + (await sizeOf(path)) : info.size
    }),
  )
  return sizes.reduce((sum, size) => sum + size, 0)
}

/** The archives of a version in `out`, and their checksums, as `sha256sum` writes them. */
const writeChecksums = async ({
  out,
  version,
}: {
  readonly out: string
  readonly version: string
}): Promise<string> => {
  const archives = (await readdir(out))
    .filter(
      name =>
        name.startsWith(`fabrica-${version}-`) && name.endsWith('.tar.gz'),
    )
    .toSorted()
  const lines = await Promise.all(
    archives.map(
      async name => `${await sha256Of(NodePath.join(out, name))}  ${name}\n`,
    ),
  )
  const file = NodePath.join(out, 'checksums.txt')
  await writeFile(file, lines.join(''))
  return file
}

/** What the build of one target made. */
export interface Distribution {
  readonly archive: string
  readonly sha256: string
  /** The archive's size, in bytes. */
  readonly archiveBytes: number
  /** The unpacked distribution's size, in bytes. */
  readonly unpackedBytes: number
  /** DuckDB's part of it, its packages with the target's native library, in bytes. */
  readonly duckDbBytes: number
  /** `checksums.txt`, over every archive of the version in `out`. */
  readonly checksums: string
}

/** What a distribution is built from. */
export interface DistributionInputs {
  readonly target: EngineTarget
  readonly version: string
  /** The Node archive for the target, as mise.lock pins it. */
  readonly node: Pin
  /** pnpm-lock.yaml's text, which pins DuckDB's native package for the target. */
  readonly lockfile: string
  /** `apps/engine`. */
  readonly app: string
  /** `packages/pi-extension`. */
  readonly extension: string
  /** Where the archives and `checksums.txt` are written; the stage and the download cache are in it. */
  readonly out: string
  readonly download: Download
  /** The environment `tar` runs with, which finds it on its PATH. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/** Builds a target's distribution: its archive in `out`, and `checksums.txt` written again. */
export const buildDistribution = Effect.fn('Distribution.build')(
  function* (inputs: DistributionInputs) {
    const name = distributionName(inputs)
    const stageRoot = NodePath.join(inputs.out, 'stage')
    const stage = NodePath.join(stageRoot, name)
    const archive = NodePath.join(inputs.out, `${name}.tar.gz`)
    const cache = NodePath.join(inputs.out, 'cache')
    const nodeArchive = yield* fetchPinned({
      pin: inputs.node,
      cache,
      download: inputs.download,
    })
    yield* step('clear the stage', async () => {
      await rm(stage, { recursive: true, force: true })
      await rm(archive, { force: true })
      await mkdir(stage, { recursive: true })
    })
    yield* Effect.all(
      [
        placeNode({ archive: nodeArchive, stage, env: inputs.env }),
        // The bundle's folder is emptied as it is written: DuckDB is copied into it after.
        bundleEngine({ app: inputs.app, stage }).pipe(
          Effect.andThen(
            copyDuckDb({
              from: NodePath.join(inputs.app, 'node_modules', DUCKDB_PACKAGE),
              to: NodePath.join(stage, DISTRIBUTION_LAYOUT.duckDbFolder),
              target: inputs.target,
              lockfile: inputs.lockfile,
              cache,
              download: inputs.download,
              env: inputs.env,
            }),
          ),
        ),
        bundleExtension({ extension: inputs.extension, stage }),
        copyInstalled({
          from: NodePath.join(inputs.app, 'node_modules', PI_PACKAGE),
          name: PI_PACKAGE,
          to: NodePath.join(stage, DISTRIBUTION_LAYOUT.piFolder),
          leaveOut: () => false,
        }),
      ],
      { concurrency: 'unbounded' },
    )
    yield* checkPiCli(stage)
    yield* step('write the launcher', async () => {
      const launcher = NodePath.join(stage, DISTRIBUTION_LAYOUT.launcher)
      await mkdir(NodePath.dirname(launcher), { recursive: true })
      await writeFile(launcher, LAUNCHER)
      await chmod(launcher, 0o755)
    })
    // macOS's tar would add AppleDouble files for extended attributes; COPYFILE_DISABLE stops it.
    yield* runCommand({
      command: 'tar',
      args: ['-czf', archive, '-C', stageRoot, name],
      env: { ...inputs.env, COPYFILE_DISABLE: '1' },
    })
    const [sha256, archiveBytes, unpackedBytes, duckDbBytes, checksums] =
      yield* step('measure', () =>
        Promise.all([
          sha256Of(archive),
          lstat(archive).then(info => info.size),
          sizeOf(stage),
          sizeOf(
            NodePath.join(
              stage,
              DISTRIBUTION_LAYOUT.duckDbFolder,
              'node_modules',
            ),
          ),
          writeChecksums({ out: inputs.out, version: inputs.version }),
        ]),
      )
    return {
      archive,
      sha256,
      archiveBytes,
      unpackedBytes,
      duckDbBytes,
      checksums,
    }
  },
  (effect, inputs) =>
    Effect.mapError(
      effect,
      reason => new DistributionFailed({ target: inputs.target, reason }),
    ),
)
