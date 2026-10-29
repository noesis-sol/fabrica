// The engine distribution's layout (spec §22.1): where each of its parts lies, relative to the folder
// it unpacks into. The build places them there, and the engine finds them there; both read it here.
//
// Node runs the build itself (`node build/dist.ts`), stripping its types, so this module imports
// nothing relative.

/** An engine target (spec §4), named as Node names its platform and architecture. */
export const ENGINE_TARGETS = [
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
] as const

export type EngineTarget = (typeof ENGINE_TARGETS)[number]

/** The parts of an unpacked distribution, by their paths relative to its folder. */
export const DISTRIBUTION_LAYOUT = {
  /** The `fabrica` command: a shell script running the bundled Node on the bundle. */
  launcher: 'bin/fabrica',
  /** The pinned Node runtime, which runs the engine, Pi and the reapers. */
  node: 'node/bin/node',
  /** Node's licence, shipped with its binary. */
  nodeLicense: 'node/LICENSE',
  /** The engine bundle: `apps/engine` and `packages/engine`, migrations included. */
  bundle: 'lib/engine/main.js',
  /**
   * The folder DuckDB is installed in, the bundle's, whose import of it Node resolves there: its
   * `node_modules`, laid out as pnpm laid it out, with the target's native package.
   */
  duckDbFolder: 'lib/engine',
  /** DuckDB's package, `@duckdb/node-api`, which the engine imports when it opens its query layer. */
  duckDb: 'lib/engine/node_modules/@duckdb/node-api',
  /** The folder Pi is installed in: its `node_modules`, laid out as pnpm laid it out. */
  piFolder: 'lib/pi',
  /** Pi's package. */
  pi: 'lib/pi/node_modules/@earendil-works/pi-coding-agent',
  /** Pi's CLI script, in its package (its `bin`). */
  piCli:
    'lib/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
  /** The first-party extension, bundled. */
  extension: 'lib/extension/index.js',
} as const

/** A distribution's name, and its archive's without `.tar.gz`: also the folder it unpacks into. */
export const distributionName = ({
  version,
  target,
}: {
  readonly version: string
  readonly target: EngineTarget
}): string => `fabrica-${version}-${target}`
