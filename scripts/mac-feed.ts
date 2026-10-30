// scripts/mac-feed.ts: the macOS app's update feed (spec §22.2, §22.5). Each macOS architecture is packaged
// on its own runner (.github/workflows/app.yml), and each run writes its own latest-mac.yml, listing only
// its own zip, under the same name. electron-updater's MacUpdater keeps the files with arm64 in their
// name for an arm64 Mac and the others for an x64 one (filterFilesForArch), so the release
// (.github/workflows/release.yml) publishes one latest-mac.yml listing every architecture's zip, merged
// here from the runs' feeds.
//
//   node scripts/mac-feed.ts <out> <feed>...
//
// The merged feed is the first feed's (its path, sha512 and releaseDate, which electron-updater reads
// only where a feed has no files), with every feed's files, in the feeds' order. It refuses feeds of
// different versions, a feed without files, and a file two feeds list. It is written as YAML 1.1, which
// electron-updater's js-yaml reads: a date electron-builder quoted stays a string.
//
// Node runs this file itself, stripping its types.
import { Data, Option, Result, Schema } from 'effect'
import { readFileSync, writeFileSync } from 'node:fs'
import { parse, stringify } from 'yaml'

/** A file of a feed: its name in the release, its SHA-512 and size, and what else electron-builder wrote. */
const FeedFile = Schema.StructWithRest(
  Schema.Struct({
    url: Schema.String,
    sha512: Schema.String,
    size: Schema.Number,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

/** A latest-mac.yml, as electron-builder writes it, with what else it wrote. */
const Feed = Schema.StructWithRest(
  Schema.Struct({
    version: Schema.String,
    files: Schema.NonEmptyArray(FeedFile),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

export type Feed = typeof Feed.Type

/** Why the feeds don't make one feed. */
export type MergeFailure = Data.TaggedEnum<{
  /** The feeds are of different versions. */
  Versions: { readonly versions: ReadonlyArray<string> }
  /** Two feeds list the same file. */
  SameFile: { readonly url: string }
  /** There is no feed to merge. */
  NoFeed: {}
}>
export const MergeFailure = Data.taggedEnum<MergeFailure>()

/** What a failure says. */
export const describeFailure = (failure: MergeFailure): string =>
  MergeFailure.$match(failure, {
    Versions: ({ versions }) =>
      `the feeds are of different versions: ${versions.join(', ')}`,
    SameFile: ({ url }) => `two feeds list ${url}`,
    NoFeed: () => 'there is no feed to merge',
  })

/** The first feed, with every feed's files in the feeds' order. */
export const mergeFeeds = (
  feeds: ReadonlyArray<Feed>,
): Result.Result<Feed, MergeFailure> => {
  const [first] = feeds
  if (first === undefined) return Result.fail(MergeFailure.NoFeed())
  const versions = [...new Set(feeds.map(feed => feed.version))]
  if (versions.length > 1)
    return Result.fail(MergeFailure.Versions({ versions }))
  const urls = feeds.flatMap(feed => feed.files.map(file => file.url))
  const twice = urls.find((url, index) => urls.indexOf(url) !== index)
  if (twice !== undefined)
    return Result.fail(MergeFailure.SameFile({ url: twice }))
  const [head, ...rest] = feeds.flatMap(feed => feed.files)
  return head === undefined
    ? Result.fail(MergeFailure.NoFeed())
    : Result.succeed({ ...first, files: [head, ...rest] })
}

/** A feed's text, decoded; none where it isn't YAML of a feed's shape. */
export const readFeed = (text: string): Option.Option<Feed> =>
  Option.flatMap(
    Option.liftThrowable(() => parse(text, { version: '1.1' }))(),
    Schema.decodeUnknownOption(Feed),
  )

/** A feed's text, as electron-updater reads it. */
export const writeFeed = (feed: Feed): string =>
  stringify(feed, { version: '1.1' })

const usage = 'usage: node scripts/mac-feed.ts <out> <feed>...\n'

const fail = (message: string): number => {
  process.stderr.write(`mac-feed: ${message}\n`)
  return 1
}

const main = (args: ReadonlyArray<string>): number => {
  const [out, ...paths] = args
  if (out === undefined || paths.length === 0) {
    process.stderr.write(usage)
    return 2
  }
  const feeds: Array<Feed> = []
  for (const path of paths) {
    const feed = Option.flatMap(
      Option.liftThrowable(() => readFileSync(path, 'utf8'))(),
      readFeed,
    )
    if (Option.isNone(feed))
      return fail(`${path} is no update feed electron-builder wrote`)
    feeds.push(feed.value)
  }
  return Result.match(mergeFeeds(feeds), {
    onFailure: failure => fail(describeFailure(failure)),
    onSuccess: feed => {
      writeFileSync(out, writeFeed(feed))
      process.stdout.write(
        `${out}: version ${feed.version}, ${feed.files.map(file => file.url).join(', ')}\n`,
      )
      return 0
    },
  })
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
