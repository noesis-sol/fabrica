import { Data, Effect, Option, Result, type Scope } from 'effect'
import type { HttpClient } from 'effect/http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import * as NodePath from 'node:path'

import type { ReleaseVersion } from '@fabrica/contracts'
import {
  ARCHIVE_LIMIT,
  CHECKSUMS,
  CHECKSUMS_LIMIT,
  type ChosenArchive,
  ENGINE_TARGETS,
  type EngineTarget,
  type ReleaseChoice,
  SIGNATURE,
  SIGNATURE_BYTES,
  UpdateFailure,
  archivesFor,
  assetUrl,
  chooseArchive,
  download,
  parseChecksums,
  verifyChecksums,
} from '@fabrica/engine/update'

import { InstallFailure } from './failure'

// Where the engine the app installs comes from (spec §9.2, §20.4, §22.2): a folder of the app's own
// holding a release's checksums.txt, its signature and its archives, sent to the host over the shell; or
// Fabrica's releases, whose archive the host downloads itself, or the app downloads and sends on where
// the host has neither curl nor wget. Either way the app verifies checksums.txt's signature with the
// release keys before it trusts a sum in it, and the host checks the archive's SHA-256 against the sum
// before it unpacks it, so an archive is never unpacked that the release key didn't vouch for.

export type DistributionSource = Data.TaggedEnum<{
  /** A folder of the app's: checksums.txt, checksums.txt.sig and the archives, as a release has them. */
  Folder: { readonly folder: string; readonly keys: ReadonlyArray<string> }
  /** Releases served as GitHub serves them, and the folder of the app's that downloads go into. */
  Releases: {
    readonly releases: string
    readonly keys: ReadonlyArray<string>
    readonly release: ReleaseChoice
    readonly stage: string
  }
}>
export const DistributionSource = Data.taggedEnum<DistributionSource>()

/** How the host gets the archive: sent from a local file, or downloaded there from its address. */
export type Delivery = Data.TaggedEnum<{
  Upload: { readonly file: string }
  Download: { readonly url: string }
}>
export const Delivery = Data.taggedEnum<Delivery>()

/** The release's engine for a host, its checksums.txt verified: its archive, its sum and its version. */
export interface Offered {
  readonly archive: ChosenArchive
  readonly version: ReleaseVersion
}

const release = (failure: UpdateFailure) => InstallFailure.Release({ failure })

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const readLocal = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(path),
    catch: error =>
      release(
        UpdateFailure.DownloadFailed({ url: path, message: message(error) }),
      ),
  })

/** A folder of the app's for one download, removed with what it holds as the scope ends. */
const downloadStage = (stage: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(NodePath.join(stage, 'engine-')),
      catch: error =>
        release(
          UpdateFailure.PlaceFailed({ path: stage, message: message(error) }),
        ),
    }),
    folder =>
      Effect.promise(() => rm(folder, { recursive: true, force: true })),
  )

/** Downloads `url` into a file of a new folder under `stage`, refused past `limit` bytes. */
const fetchFile = ({
  stage,
  url,
  name,
  limit,
}: {
  readonly stage: string
  readonly url: string
  readonly name: string
  readonly limit: number
}) =>
  Effect.gen(function* () {
    const folder = yield* downloadStage(stage)
    const file = NodePath.join(folder, name)
    yield* download({ url, to: file, limit }).pipe(Effect.mapError(release))
    return file
  })

/** checksums.txt and its signature, from the source. */
const manifestOf = (source: DistributionSource) =>
  DistributionSource.$match(source, {
    Folder: ({ folder }) =>
      Effect.all(
        [
          readLocal(NodePath.join(folder, CHECKSUMS)),
          readLocal(NodePath.join(folder, SIGNATURE)),
        ],
        { concurrency: 'unbounded' },
      ),
    Releases: ({ releases, release: choice, stage }) => {
      const fetched = (name: string, limit: number) =>
        fetchFile({
          stage,
          url: assetUrl({ releases, release: choice, name }),
          name,
          limit,
        }).pipe(Effect.flatMap(readLocal))
      return Effect.all(
        [
          fetched(CHECKSUMS, CHECKSUMS_LIMIT),
          fetched(SIGNATURE, SIGNATURE_BYTES),
        ],
        { concurrency: 'unbounded' },
      )
    },
  })

/** The targets checksums.txt has an engine for. */
const targetsIn = (checksums: string): ReadonlyArray<EngineTarget> => {
  const entries = parseChecksums(checksums)
  return ENGINE_TARGETS.filter(
    target => archivesFor({ entries, target }).length > 0,
  )
}

/**
 * The source's engine for `target`, once its checksums.txt verifies with one of the source's keys;
 * an architecture mismatch where it lists none for the target.
 */
export const offeredFor = Effect.fn('EngineInstall.offered')(function* ({
  source,
  target,
}: {
  readonly source: DistributionSource
  readonly target: EngineTarget
}) {
  const [checksums, signature] = yield* manifestOf(source)
  // Verified before any sum in it is trusted.
  yield* Effect.fromResult(
    Result.mapError(
      verifyChecksums({ checksums, signature, keys: source.keys }),
      release,
    ),
  )
  const text = checksums.toString('utf8')
  const choice = DistributionSource.$match(source, {
    Folder: (): ReleaseChoice => Option.none(),
    Releases: ({ release: chosen }) => chosen,
  })
  const archive = yield* Effect.fromResult(
    chooseArchive({ checksums: text, target, release: choice }),
  ).pipe(
    Effect.mapError(failure =>
      UpdateFailure.$is('NoArchive')(failure)
        ? InstallFailure.ArchitectureMismatch({
            target,
            offered: targetsIn(text),
          })
        : release(failure),
    ),
  )
  return { archive, version: archive.version } satisfies Offered
})

/** How the host gets the offered archive: from its address where it can download, else sent by the app. */
export const deliveryOf = ({
  source,
  offered,
  hostDownloads,
}: {
  readonly source: DistributionSource
  readonly offered: Offered
  readonly hostDownloads: boolean
}): Effect.Effect<
  Delivery,
  InstallFailure,
  HttpClient.HttpClient | Scope.Scope
> =>
  DistributionSource.$match(source, {
    Folder: ({ folder }) =>
      Effect.succeed(
        Delivery.Upload({ file: NodePath.join(folder, offered.archive.name) }),
      ),
    Releases: ({ releases, stage }) => {
      // From the version's own release, so a latest that moves on meanwhile can't change what is had.
      const url = assetUrl({
        releases,
        release: Option.some(offered.version),
        name: offered.archive.name,
      })
      return hostDownloads
        ? Effect.succeed(Delivery.Download({ url }))
        : fetchFile({
            stage,
            url,
            name: offered.archive.name,
            limit: ARCHIVE_LIMIT,
          }).pipe(Effect.map(file => Delivery.Upload({ file })))
    },
  })
