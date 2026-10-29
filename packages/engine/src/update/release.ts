import { Option } from 'effect'
import * as NodePath from 'node:path'

import type { ReleaseVersion } from '@fabrica/contracts'

// A release of the engine as its installers read it (spec §9.2, §22.1, §22.5): where its files are
// served, what they are named, what checksums.txt says, where a version is installed and linked from,
// and which of two releases is the later. `fabrica engine update` and the app's install over SSH (M4)
// read them here; the install script (scripts/install.sh) holds the same names, and the distribution's
// own (apps/engine/src/layout.ts) are checked against these by the update's tests.

/** Where Fabrica's releases are served from: GitHub's releases of its public repository (§20.5). */
export const RELEASES = 'https://github.com/noesis-sol/fabrica/releases'

/** The engine targets (spec §4), as Node names their platform and architecture. */
export const ENGINE_TARGETS = [
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
] as const

export type EngineTarget = (typeof ENGINE_TARGETS)[number]

/** The engine target of a host, as Node names its platform and architecture; none for another host. */
export const targetOf = ({
  platform,
  arch,
}: {
  readonly platform: string
  readonly arch: string
}): Option.Option<EngineTarget> =>
  Option.fromNullishOr(
    ENGINE_TARGETS.find(target => target === `${platform}-${arch}`),
  )

/** The release's list of SHA-256 sums, in sha256sum's format, signed by the release key. */
export const CHECKSUMS = 'checksums.txt'

/** The raw 64-byte ed25519 signature over checksums.txt (scripts/sign-checksums.ts). */
export const SIGNATURE = 'checksums.txt.sig'

/** An ed25519 signature's length. */
export const SIGNATURE_BYTES = 64

/** A distribution's name: its archive's without `.tar.gz`, and the folder it unpacks into. */
export const distributionName = ({
  version,
  target,
}: {
  readonly version: ReleaseVersion
  readonly target: EngineTarget
}): string => `fabrica-${version}-${target}`

/** A distribution's archive. */
export const archiveName = (options: {
  readonly version: ReleaseVersion
  readonly target: EngineTarget
}): string => `${distributionName(options)}.tar.gz`

/** The `fabrica` command in an unpacked distribution, relative to its folder. */
export const LAUNCHER = 'bin/fabrica'

/** A release's tag: its version after a `v`. */
export const tagOf = (version: ReleaseVersion): string => `v${version}`

/** What `fabrica --version` prints on stdout for a version: Effect's CLI puts the `v` before it. */
export const versionLine = (version: ReleaseVersion): string =>
  `fabrica ${tagOf(version)}`

/** Which release a request names: the latest, or a version. */
export type ReleaseChoice = Option.Option<ReleaseVersion>

/** The address of a release's file: the latest release's, or a version's. */
export const assetUrl = ({
  releases,
  release,
  name,
}: {
  readonly releases: string
  readonly release: ReleaseChoice
  readonly name: string
}): string =>
  Option.match(release, {
    onNone: () => `${releases}/latest/download/${name}`,
    onSome: version => `${releases}/download/${tagOf(version)}/${name}`,
  })

/** One line of checksums.txt: a file's name and its SHA-256, in lowercase hex. */
export interface ChecksumEntry {
  readonly name: string
  readonly sha256: string
}

const CHECKSUM_LINE = /^([0-9a-f]{64}) [ *](\S+)$/u

/** The entries of checksums.txt, in sha256sum's format (`<sum>  <name>`); lines of another shape are left out. */
export const parseChecksums = (text: string): ReadonlyArray<ChecksumEntry> =>
  text.split('\n').flatMap(line => {
    const match = CHECKSUM_LINE.exec(line.replace(/\r$/u, ''))
    const [, sha256, name] = match ?? []
    return sha256 === undefined || name === undefined ? [] : [{ name, sha256 }]
  })

const DISTRIBUTION =
  /^fabrica-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-([a-z]+-[a-z0-9]+)\.tar\.gz$/u

/** The engine archives checksums.txt lists for `target`, each with its version. */
export const archivesFor = ({
  entries,
  target,
}: {
  readonly entries: ReadonlyArray<ChecksumEntry>
  readonly target: EngineTarget
}): ReadonlyArray<ChecksumEntry & { readonly version: string }> =>
  entries.flatMap(entry => {
    const [, version, of] = DISTRIBUTION.exec(entry.name) ?? []
    return version === undefined || of !== target ? [] : [{ ...entry, version }]
  })

/** Where the engine's versions are installed and `fabrica` is linked from, under a home folder (§9.2). */
export interface InstallPlaces {
  /** The folder each version is unpacked in, by its version: `~/.local/share/fabrica/engine`. */
  readonly engines: string
  /** The `fabrica` on the PATH, a link to a version's launcher: `~/.local/bin/fabrica`. */
  readonly link: string
}

/**
 * The install places under `home`, as the install script makes them: POSIX paths, since the engine's
 * host is POSIX, whichever machine the app that installs it over SSH or in WSL2 runs on.
 */
export const installPlaces = (home: string): InstallPlaces => ({
  engines: NodePath.posix.join(home, '.local', 'share', 'fabrica', 'engine'),
  link: NodePath.posix.join(home, '.local', 'bin', 'fabrica'),
})

/** The folder a version is installed in. */
export const versionFolder = ({
  places,
  version,
}: {
  readonly places: InstallPlaces
  readonly version: ReleaseVersion
}): string => NodePath.posix.join(places.engines, version)

const parts = (version: ReleaseVersion) => {
  const dash = version.indexOf('-')
  const core = dash === -1 ? version : version.slice(0, dash)
  const pre = dash === -1 ? [] : version.slice(dash + 1).split('.')
  return { core: core.split('.').map(Number), pre }
}

const compareIdentifiers = (a: string, b: string): number => {
  const numeric = /^\d+$/u
  if (numeric.test(a) && numeric.test(b))
    return Math.sign(Number(a) - Number(b))
  if (numeric.test(a)) return -1
  if (numeric.test(b)) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Semantic Versioning's order of two releases: below 0 where `a` comes before `b`, 0 where they are
 * the same release, above 0 where it comes after. A pre-release comes before its release.
 */
export const compareReleases = (
  a: ReleaseVersion,
  b: ReleaseVersion,
): number => {
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < 3; i++) {
    const order = Math.sign((left.core[i] ?? 0) - (right.core[i] ?? 0))
    if (order !== 0) return order
  }
  if (left.pre.length === 0 || right.pre.length === 0)
    return Math.sign(right.pre.length - left.pre.length)
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const [x, y] = [left.pre[i], right.pre[i]]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const order = compareIdentifiers(x, y)
    if (order !== 0) return order
  }
  return 0
}
