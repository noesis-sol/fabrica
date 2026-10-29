// The engine distribution's build (spec §22.1): per engine target, one tar.gz holding the pinned Node
// runtime, the engine bundle, Pi and the first-party extension at exact versions, and the `fabrica`
// launcher, laid out as `src/layout.ts` says; and `checksums.txt` over the version's archives.
//
// Node's archive for the target is the one mise.lock pins, by URL and checksum (§20.4): downloaded
// once into a cache, and checked against the checksum each time it is used. Pi is copied with the
// dependencies pnpm installed for it from the committed lockfile, as pnpm laid them out. The bundles
// are pure JavaScript and Pi's few native files come prebuilt for every platform in its own packages,
// so any host builds every target's archive.
//
// Node runs the build itself (`node build/dist.ts`), stripping its types: relative imports name their
// `.ts` files.

import { Data, Effect, Option } from 'effect'
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
    readonly expected: string
    readonly actual: string
  }
  /** A URL couldn't be fetched. */
  Download: { readonly url: string; readonly message: string }
  /** Pi's package isn't laid out as the distribution expects it. */
  PiLayout: { readonly message: string }
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
      ChecksumMismatch: ({ file, expected, actual }) =>
        `${file}: sha256 ${actual}, but its pin is ${expected}`,
      Download: ({ url, message }) => `${url}: ${message}`,
      PiLayout: ({ message }) => message,
      Step: ({ step, message }) => `${step}: ${message}`,
    })}`
  }
}

/** A pinned download: where it is, and its sha256 in hex. */
export interface Pin {
  readonly url: string
  readonly sha256: string
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
    sha256: value(/^checksum = "sha256:([0-9a-f]{64})"$/),
  })
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

/** A file's sha256, in hex. */
export const sha256Of = async (file: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

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
    sha256Of(file).then(Option.some, () => Option.none<string>()),
  )
  if (Option.contains(cached, pin.sha256)) return file
  yield* step('cache', () => mkdir(cache, { recursive: true }))
  yield* download(pin.url, file)
  const actual = yield* step('checksum', () => sha256Of(file))
  if (actual === pin.sha256) return file
  yield* step('reject', () => rm(file, { force: true }))
  return yield* Effect.fail(
    DistributionFailure.ChecksumMismatch({
      file: NodePath.basename(file),
      expected: pin.sha256,
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

/**
 * Copies Pi's package and every package it reaches into `<to>/node_modules`, as pnpm laid them out:
 * each pnpm entry under `.pnpm`, its own package and its links to its dependencies' entries, and
 * `<to>/node_modules/<Pi's name>` a link to Pi's.
 */
const copyPi = Effect.fn('Distribution.copyPi')(function* ({
  pi,
  to,
}: {
  readonly pi: string
  readonly to: string
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
    yield* step('find Pi', () => realpath(pi)),
    PI_PACKAGE,
  )
  const seen = new Map<string, string>()
  const queue = [root.entry]
  // The loop reaches the entries it adds as it goes.
  for (const entry of queue) {
    const id = NodePath.basename(entry)
    const earlier = seen.get(id)
    if (earlier === entry) continue
    if (earlier !== undefined)
      return yield* Effect.fail(
        DistributionFailure.PiLayout({
          message: `two pnpm entries named ${id}: ${earlier} and ${entry}`,
        }),
      )
    seen.set(id, entry)
    const modules = NodePath.join(entry, 'node_modules')
    const names = yield* step('read Pi', () => namesIn(modules))
    for (const name of names) {
      const from = NodePath.join(modules, name)
      const into = placed({ entry, name })
      const info = yield* step('read Pi', () => lstat(from))
      if (info.isSymbolicLink()) {
        const dependency = installedAt(
          yield* step('read Pi', () => realpath(from)),
          name,
        )
        queue.push(dependency.entry)
        yield* step('link Pi', async () => {
          await mkdir(NodePath.dirname(into), { recursive: true })
          await symlink(
            NodePath.relative(NodePath.dirname(into), placed(dependency)),
            into,
          )
        })
      } else {
        yield* step('copy Pi', () =>
          cp(from, into, {
            recursive: true,
            verbatimSymlinks: true,
            filter: source => !unread.test(source),
          }),
        )
      }
    }
  }
  const link = NodePath.join(to, 'node_modules', PI_PACKAGE)
  yield* step('link Pi', async () => {
    await mkdir(NodePath.dirname(link), { recursive: true })
    await symlink(NodePath.relative(NodePath.dirname(link), placed(root)), link)
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
      DistributionFailure.PiLayout({
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

/** The total size of a folder's files, links counted as themselves. */
const sizeOf = async (folder: string): Promise<number> => {
  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  })
  const sizes = await Promise.all(
    entries.map(entry =>
      lstat(NodePath.join(entry.parentPath, entry.name)).then(
        info => info.size,
      ),
    ),
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
  /** `checksums.txt`, over every archive of the version in `out`. */
  readonly checksums: string
}

/** What a distribution is built from. */
export interface DistributionInputs {
  readonly target: EngineTarget
  readonly version: string
  /** The Node archive for the target, as mise.lock pins it. */
  readonly node: Pin
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
    const nodeArchive = yield* fetchPinned({
      pin: inputs.node,
      cache: NodePath.join(inputs.out, 'cache'),
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
        bundleEngine({ app: inputs.app, stage }),
        bundleExtension({ extension: inputs.extension, stage }),
        copyPi({
          pi: NodePath.join(inputs.app, 'node_modules', PI_PACKAGE),
          to: NodePath.join(stage, DISTRIBUTION_LAYOUT.piFolder),
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
    const [sha256, archiveBytes, unpackedBytes, checksums] = yield* step(
      'measure',
      () =>
        Promise.all([
          sha256Of(archive),
          lstat(archive).then(info => info.size),
          sizeOf(stage),
          writeChecksums({ out: inputs.out, version: inputs.version }),
        ]),
    )
    return { archive, sha256, archiveBytes, unpackedBytes, checksums }
  },
  (effect, inputs) =>
    Effect.mapError(
      effect,
      reason => new DistributionFailed({ target: inputs.target, reason }),
    ),
)
