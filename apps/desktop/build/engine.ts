import { Data } from 'effect'
import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, rm } from 'node:fs/promises'
import * as NodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { type EngineTarget, distributionName } from '@fabrica/engine-app/layout'

import engineManifest from '../../engine/package.json' with { type: 'json' }

// The engine distribution the packaged app embeds (spec §22.2), staged by electron-builder's beforePack
// hook for each platform and architecture it packs, into `stage/engine`, which electron-builder.yml's
// extraResources copy into the app's resources. The macOS and Linux apps get their own architecture's
// distribution unpacked, as `engine/`, for the local engine (local-engine.ts); the Windows app gets the
// Linux x64 release as a release folder has it, the archive, checksums.txt and, where it was signed,
// checksums.txt.sig, as `engine-release/`, to install in WSL2 as an engine is installed on any host
// (§7.6, §9.2).
//
// The archives are the engine build's, in apps/engine/out (`pnpm --filter @fabrica/engine-app dist
// <target>`), so the app embeds what the release ships.

/** What the app embeds: an unpacked distribution, or a release to install from. */
export type Embedded = Data.TaggedEnum<{
  Unpacked: { readonly target: EngineTarget }
  Release: { readonly target: EngineTarget }
}>
export const Embedded = Data.taggedEnum<Embedded>()

/** The engine each app the spec builds embeds (§4), by its platform and architecture. */
const embedded: Readonly<Record<string, Embedded>> = {
  'darwin-x64': Embedded.Unpacked({ target: 'darwin-x64' }),
  'darwin-arm64': Embedded.Unpacked({ target: 'darwin-arm64' }),
  'linux-x64': Embedded.Unpacked({ target: 'linux-x64' }),
  'linux-arm64': Embedded.Unpacked({ target: 'linux-arm64' }),
  'win32-x64': Embedded.Release({ target: 'linux-x64' }),
}

/** The engine the app built for `platform` and `arch` embeds; an app the spec doesn't build fails. */
export const embeddedEngine = (platform: string, arch: string): Embedded => {
  const engine = embedded[`${platform}-${arch}`]
  if (engine === undefined) {
    throw new Error(
      `no engine for the app on ${platform}-${arch}: the app is built for macOS and Linux, x64 and arm64, and Windows x64 (spec §4)`,
    )
  }
  return engine
}

/** electron-builder's architectures, by the number its hooks are given (builder-util's `Arch`). */
const architectures: ReadonlyArray<string> = [
  'ia32',
  'x64',
  'armv7l',
  'arm64',
  'universal',
]

const desktop = NodePath.dirname(
  NodePath.dirname(fileURLToPath(import.meta.url)),
)

/** Where the hook stages the engine; electron-builder.yml's extraResources copy it from there. */
const stageFolder = NodePath.join(desktop, 'stage', 'engine')

/** The engine build's output: its archives and their checksums.txt. */
const engineOut = NodePath.join(desktop, '..', 'engine', 'out')

const run = promisify(execFile)

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

/** Stages `engine` of `version` from the engine build's output `out` into `stage`, emptied first. */
export const stageEngine = async (options: {
  readonly engine: Embedded
  readonly version: string
  readonly out: string
  readonly stage: string
  /** The environment `tar` runs with, which finds it on its PATH. */
  readonly env: Readonly<Record<string, string | undefined>>
}): Promise<void> => {
  const name = distributionName({
    version: options.version,
    target: options.engine.target,
  })
  const archive = NodePath.join(options.out, `${name}.tar.gz`)
  if (!(await exists(archive))) {
    throw new Error(
      `${archive} is missing: build it first, with pnpm --filter @fabrica/engine-app dist ${options.engine.target}`,
    )
  }
  await rm(options.stage, { recursive: true, force: true })
  await mkdir(options.stage, { recursive: true })
  await Embedded.$match(options.engine, {
    Unpacked: () =>
      run(
        'tar',
        ['-xzf', archive, '-C', options.stage, '--strip-components=1'],
        {
          env: options.env,
        },
      ),
    Release: async () => {
      const signature = NodePath.join(options.out, 'checksums.txt.sig')
      const files = [
        archive,
        NodePath.join(options.out, 'checksums.txt'),
        ...((await exists(signature)) ? [signature] : []),
      ]
      for (const file of files) {
        await copyFile(
          file,
          NodePath.join(options.stage, NodePath.basename(file)),
        )
      }
    },
  })
}

/** What electron-builder tells a beforePack hook, of what this one reads. */
export interface PackingApp {
  readonly electronPlatformName: string
  readonly arch: number
}

/** electron-builder's beforePack hook: stages the engine the app being packed embeds. */
export default async function stageAppEngine(
  packing: PackingApp,
): Promise<void> {
  await stageEngine({
    engine: embeddedEngine(
      packing.electronPlatformName,
      architectures[packing.arch] ?? String(packing.arch),
    ),
    version: engineManifest.version,
    out: engineOut,
    stage: stageFolder,
    env: process.env,
  })
}
