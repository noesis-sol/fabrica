import { Duration, Effect, Option, Result, Stream } from 'effect'
import { HttpClient } from 'effect/http'
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  symlink,
} from 'node:fs/promises'
import * as NodePath from 'node:path'

import type { ReleaseVersion } from '@fabrica/contracts'

import { CommandOutcome, ExitStatus, ProcessRunner } from '../process'
import { UpdateFailure } from './failure'
import {
  CHECKSUMS,
  type ChecksumEntry,
  type EngineTarget,
  type InstallPlaces,
  LAUNCHER,
  type ReleaseChoice,
  SIGNATURE,
  SIGNATURE_BYTES,
  archiveName,
  archivesFor,
  assetUrl,
  compareReleases,
  distributionName,
  parseChecksums,
  versionFolder,
  versionLine,
} from './release'

// The steps that install a release of the engine (spec §9.2, §20.4, §22.5), as the install script
// takes them: checksums.txt and its signature downloaded, the signature verified with a release key
// before any sum in it is trusted, the archive downloaded and its SHA-256 checked, unpacked in a
// folder of the engine's own (never /tmp, which hardened hosts mount noexec), its launcher's
// `--version` run there, its stdout alone read, then the version's folder renamed into place and the
// link made beside the old one and renamed over it, so that `fabrica` never names a half-written
// engine. Each step fails with its own `UpdateFailure`; the app's install over SSH (M4) reuses the
// ones that need no local file system: the names, the signature and the choice of archive.

/** Where releases come from, and the keys their checksums.txt may be signed with. */
export interface ReleaseSource {
  /** The releases' address, laid out as GitHub serves them (`download/<tag>/<name>`, `latest/download/<name>`). */
  readonly releases: string
  /** PKIX PEM ed25519 public keys. */
  readonly keys: ReadonlyArray<string>
}

/** The most checksums.txt may hold. */
export const CHECKSUMS_LIMIT = 1024 * 1024

/** The most an engine archive may hold: past it, the download is cut and refused. */
export const ARCHIVE_LIMIT = 2 * 1024 * 1024 * 1024

/** How long tar has to unpack the archive. */
const UNPACK_TIME = Duration.minutes(5)

/** How long the new launcher has to print its version. */
const VERSION_TIME = Duration.minutes(1)

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const placing = <A>(path: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: error =>
      UpdateFailure.PlaceFailed({ path, message: message(error) }),
  })

/** What a download wrote: its size and SHA-256, in lowercase hex. */
export interface Downloaded {
  readonly bytes: number
  readonly sha256: string
}

/** Downloads `url` into the new file `to`, refusing it past `limit` bytes. */
export const download = Effect.fn('Update.download')(function* ({
  url,
  to,
  limit,
}: {
  readonly url: string
  readonly to: string
  readonly limit: number
}) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
  const failed = (error: unknown) =>
    UpdateFailure.DownloadFailed({ url, message: message(error) })
  const response = yield* client.get(url).pipe(Effect.mapError(failed))
  const handle = yield* placing(to, () =>
    open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600),
  )
  const hash = createHash('sha256')
  let bytes = 0
  yield* response.stream.pipe(
    Stream.mapError(failed),
    Stream.runForEach((chunk): Effect.Effect<void, UpdateFailure> => {
      bytes += chunk.byteLength
      if (bytes > limit)
        return Effect.fail(UpdateFailure.TooLarge({ url, limit }))
      hash.update(chunk)
      return Effect.asVoid(placing(to, () => handle.write(chunk)))
    }),
    Effect.ensuring(Effect.promise(() => handle.close()).pipe(Effect.ignore)),
  )
  return { bytes, sha256: hash.digest('hex') } satisfies Downloaded
})

/** Whether `signature` verifies `checksums` with one of `keys`. */
export const verifyChecksums = ({
  checksums,
  signature,
  keys,
}: {
  readonly checksums: Uint8Array
  readonly signature: Uint8Array
  readonly keys: ReadonlyArray<string>
}): Result.Result<void, UpdateFailure> => {
  if (keys.length === 0) return Result.fail(UpdateFailure.NoReleaseKey())
  if (signature.byteLength !== SIGNATURE_BYTES)
    return Result.fail(UpdateFailure.BadSignature())
  const verifies = (pem: string): boolean => {
    try {
      return verify(null, checksums, createPublicKey(pem), signature)
    } catch {
      return false
    }
  }
  return keys.some(verifies)
    ? Result.void
    : Result.fail(UpdateFailure.BadSignature())
}

/** The engine archive a release's verified checksums.txt lists for `target`, with its version. */
export interface ChosenArchive extends ChecksumEntry {
  readonly version: ReleaseVersion
}

/**
 * The archive for `target` in a release's verified checksums.txt: the one named for the version
 * asked for, or the latest's one archive for the target, which names its version.
 */
export const chooseArchive = ({
  checksums,
  target,
  release,
}: {
  readonly checksums: string
  readonly target: EngineTarget
  readonly release: ReleaseChoice
}): Result.Result<ChosenArchive, UpdateFailure> => {
  const found = archivesFor({ entries: parseChecksums(checksums), target })
  const fitting = Option.match(release, {
    onNone: () => found,
    onSome: version =>
      found.filter(entry => entry.name === archiveName({ version, target })),
  })
  const [only, ...rest] = fitting
  return only === undefined || rest.length > 0
    ? Result.fail(
        UpdateFailure.NoArchive({
          target,
          release: Option.getOrElse(release, () => 'the latest release'),
        }),
      )
    : Result.succeed(only)
}

/** Refuses a release the engine shouldn't move to: the one it runs, or a latest older than it. */
export const checkMove = ({
  current,
  version,
  release,
}: {
  readonly current: ReleaseVersion
  readonly version: ReleaseVersion
  readonly release: ReleaseChoice
}): Result.Result<void, UpdateFailure> => {
  const order = compareReleases(version, current)
  if (order === 0) return Result.fail(UpdateFailure.AlreadyThere({ version }))
  if (order < 0 && Option.isNone(release))
    return Result.fail(UpdateFailure.LatestOlder({ latest: version, current }))
  return Result.void
}

/** A release's archive, downloaded into the stage and checked against its signed sum. */
export interface Fetched {
  readonly version: ReleaseVersion
  readonly name: string
  readonly archive: string
}

/** Downloads a release's archive for `target` into `stage`, once its checksums.txt verifies. */
export const fetchRelease = Effect.fn('Update.fetchRelease')(function* ({
  source,
  target,
  release,
  current,
  stage,
}: {
  readonly source: ReleaseSource
  readonly target: EngineTarget
  readonly release: ReleaseChoice
  readonly current: ReleaseVersion
  readonly stage: string
}) {
  if (source.keys.length === 0)
    return yield* Effect.fail(UpdateFailure.NoReleaseKey())
  yield* Effect.fromResult(
    Option.match(release, {
      onNone: () => Result.void,
      onSome: version => checkMove({ current, version, release }),
    }),
  )
  const url = (name: string) =>
    assetUrl({ releases: source.releases, release, name })
  const checksumsFile = NodePath.join(stage, CHECKSUMS)
  const signatureFile = NodePath.join(stage, SIGNATURE)
  yield* Effect.all(
    [
      download({
        url: url(CHECKSUMS),
        to: checksumsFile,
        limit: CHECKSUMS_LIMIT,
      }),
      download({
        url: url(SIGNATURE),
        to: signatureFile,
        limit: SIGNATURE_BYTES,
      }),
    ],
    { concurrency: 'unbounded' },
  )
  const [checksums, signature] = yield* Effect.all([
    placing(checksumsFile, () => readFile(checksumsFile)),
    placing(signatureFile, () => readFile(signatureFile)),
  ])
  // Verified before any sum in it is trusted, or the archive downloaded.
  yield* Effect.fromResult(
    verifyChecksums({ checksums, signature, keys: source.keys }),
  )
  const chosen = yield* Effect.fromResult(
    chooseArchive({
      checksums: checksums.toString('utf8'),
      target,
      release,
    }),
  )
  yield* Effect.fromResult(
    checkMove({ current, version: chosen.version, release }),
  )
  // From the version's own release, so a latest that moves on meanwhile can't change what is had.
  const archiveUrl = assetUrl({
    releases: source.releases,
    release: Option.some(chosen.version),
    name: chosen.name,
  })
  const archive = NodePath.join(stage, chosen.name)
  const got = yield* download({
    url: archiveUrl,
    to: archive,
    limit: ARCHIVE_LIMIT,
  })
  if (got.sha256 !== chosen.sha256)
    return yield* Effect.fail(
      UpdateFailure.ChecksumMismatch({
        archive: chosen.name,
        want: chosen.sha256,
        got: got.sha256,
      }),
    )
  return {
    version: chosen.version,
    name: distributionName({ version: chosen.version, target }),
    archive,
  } satisfies Fetched
})

/** What a command's outcome says, where it didn't exit 0. */
const outcomeText = CommandOutcome.$match({
  Exited: ({ status, stderr }) =>
    ExitStatus.$match(status, {
      Code: ({ code }) => `it exited ${code}`,
      Signal: ({ signal }) => `it was ended by ${signal}`,
    }) + (stderr.trim() === '' ? '' : `: ${stderr.trim()}`),
  TimedOut: () => 'it ran out of time',
  Cut: ({ stream, limit }) => `its ${stream} passed ${limit} bytes`,
  FailedToStart: ({ reason }) => `it didn't start (${reason._tag})`,
})

/** Whether a command exited 0, and its stdout where it did. */
const succeeded = (outcome: CommandOutcome): Result.Result<string, string> =>
  CommandOutcome.$is('Exited')(outcome) &&
  ExitStatus.$is('Code')(outcome.status) &&
  outcome.status.code === 0
    ? Result.succeed(outcome.stdout)
    : Result.fail(outcomeText(outcome))

/**
 * Checks the launcher of the unpacked distribution in `folder`: a regular executable file whose
 * `--version`, run in its folder, prints `version` on stdout. `shown` names the folder in a failure.
 */
export const checkLauncher = Effect.fn('Update.checkLauncher')(function* ({
  folder,
  shown,
  version,
}: {
  readonly folder: string
  readonly shown: string
  readonly version: ReleaseVersion
}) {
  const runner = yield* ProcessRunner
  const launcher = NodePath.join(folder, LAUNCHER)
  const stats = yield* Effect.tryPromise(() => lstat(launcher)).pipe(
    Effect.option,
  )
  if (
    Option.isNone(stats) ||
    !stats.value.isFile() ||
    (stats.value.mode & 0o100) === 0
  )
    return yield* Effect.fail(
      UpdateFailure.NoLauncher({ path: NodePath.join(shown, LAUNCHER) }),
    )
  // Only its stdout is its version, so that a warning on stderr doesn't fail the update.
  const ran = yield* runner.run({
    command: launcher,
    args: ['--version'],
    cwd: folder,
    timeLimit: VERSION_TIME,
    outputLimit: 64 * 1024,
  })
  const said = yield* Effect.fromResult(
    Result.mapError(succeeded(ran), why =>
      UpdateFailure.WontRun({ message: why }),
    ),
  )
  const want = versionLine(version)
  if (said.replace(/\n+$/u, '') !== want)
    return yield* Effect.fail(
      UpdateFailure.WrongVersion({ said: said.trim(), want }),
    )
})

/** Unpacks the fetched archive inside `stage` and checks its launcher. Returns the unpacked folder. */
export const unpackRelease = Effect.fn('Update.unpackRelease')(function* ({
  fetched,
  stage,
}: {
  readonly fetched: Fetched
  readonly stage: string
}) {
  const runner = yield* ProcessRunner
  const into = NodePath.join(stage, 'unpacked')
  yield* placing(into, () => mkdir(into))
  const unpacked = yield* runner.run({
    command: 'tar',
    args: ['-xzf', fetched.archive, '-C', into],
    cwd: into,
    timeLimit: UNPACK_TIME,
  })
  yield* Effect.fromResult(
    Result.mapError(succeeded(unpacked), why =>
      UpdateFailure.UnpackFailed({
        archive: NodePath.basename(fetched.archive),
        message: why,
      }),
    ),
  )
  const folder = NodePath.join(into, fetched.name)
  yield* checkLauncher({
    folder,
    shown: fetched.name,
    version: fetched.version,
  })
  return folder
})

/**
 * Renames the unpacked `folder` into its version's place, moving a version installed there already
 * aside into `stage` (and back, where the rename fails), then makes the link beside the old one and
 * renames it over it: `fabrica` names the old engine or the new one, never neither. Returns the new
 * launcher.
 */
export const placeRelease = Effect.fn('Update.placeRelease')(function* ({
  places,
  version,
  folder,
  stage,
}: {
  readonly places: InstallPlaces
  readonly version: ReleaseVersion
  readonly folder: string
  readonly stage: string
}) {
  const target = versionFolder({ places, version })
  const aside = NodePath.join(stage, 'replaced')
  const there = yield* Effect.tryPromise(() => lstat(target)).pipe(
    Effect.option,
  )
  if (Option.isSome(there)) yield* placing(target, () => rename(target, aside))
  yield* placing(target, () => rename(folder, target)).pipe(
    Effect.tapError(() =>
      Option.isSome(there)
        ? Effect.tryPromise(() => rename(aside, target)).pipe(Effect.ignore)
        : Effect.void,
    ),
  )
  const launcher = NodePath.join(target, LAUNCHER)
  yield* linkLauncher({ places, launcher })
  return launcher
})

/**
 * Makes `fabrica`'s link to `launcher` beside the old one and renames it over it: the link names the
 * old engine or the new one, never neither.
 */
export const linkLauncher = Effect.fn('Update.linkLauncher')(function* ({
  places,
  launcher,
}: {
  readonly places: InstallPlaces
  readonly launcher: string
}) {
  const linkFolder = NodePath.dirname(places.link)
  yield* placing(linkFolder, () => mkdir(linkFolder, { recursive: true }))
  const temporary = NodePath.join(
    linkFolder,
    `.${NodePath.basename(places.link)}-update-${randomBytes(6).toString('hex')}`,
  )
  yield* placing(temporary, () => symlink(launcher, temporary))
  yield* placing(places.link, () => rename(temporary, places.link)).pipe(
    Effect.tapError(() =>
      Effect.tryPromise(() => rm(temporary, { force: true })).pipe(
        Effect.ignore,
      ),
    ),
  )
})

/** A folder of the engine's own beside its versions, for one install, removed with what it holds as the scope ends. */
export const makeStage = (places: InstallPlaces) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      yield* placing(places.engines, () =>
        mkdir(places.engines, { recursive: true }),
      )
      const stage = NodePath.join(
        places.engines,
        `.update-${randomBytes(6).toString('hex')}`,
      )
      yield* placing(stage, () => mkdir(stage, { mode: 0o700 }))
      return stage
    }),
    stage =>
      Effect.tryPromise(() => rm(stage, { recursive: true, force: true })).pipe(
        Effect.ignore,
      ),
  )
