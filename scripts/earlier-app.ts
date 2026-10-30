// scripts/earlier-app.ts: the earlier release whose app the release's update test updates (spec §22.2,
// §22.5). Once a release is published, .github/workflows/release.yml's `update` job downloads the newest
// earlier release's Linux x64 AppImage and checks that it updates itself to the new one from the
// published feeds.
//
//   gh api --paginate repos/<owner>/<repo>/releases \
//     --jq '.[] | {tag: .tag_name, draft, prerelease, assets: [.assets[].name]} | tojson' > releases.jsonl
//   node scripts/earlier-app.ts <version> releases.jsonl >> "$GITHUB_OUTPUT"
//
// It prints `tag=v<earlier>` and `asset=<its AppImage>`, or `skip=<why>` where there is nothing to test:
// the version is a pre-release, which is never GitHub's latest, the one electron-updater's GitHub provider
// reads (the app leaves allowPrerelease off), or no earlier release has the AppImage, as before the
// second release that publishes the app. An earlier release is a published one, neither a draft nor a
// pre-release (an app at a pre-release would look for pre-releases), whose version is below the
// release's.
//
// Node runs this file itself, stripping its types.
import { Data, Option, Order, Schema } from 'effect'
import { readFileSync } from 'node:fs'

/** A release as `gh api` lists it, cut to what is read here. */
const Release = Schema.Struct({
  tag: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  assets: Schema.Array(Schema.String),
})
export type Release = typeof Release.Type

/** A release's version, `<major>.<minor>.<patch>`, without a pre-release. */
interface Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

const versionOrder: Order.Order<Version> = Order.combineAll([
  Order.mapInput(Order.Number, (version: Version) => version.major),
  Order.mapInput(Order.Number, (version: Version) => version.minor),
  Order.mapInput(Order.Number, (version: Version) => version.patch),
])

/** `0.1.0` as a version; none for a pre-release or what isn't one. */
const parseVersion = (text: string): Option.Option<Version> => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(text)
  return match === null
    ? Option.none()
    : Option.some({
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
      })
}

/** The name of a release's Linux x64 AppImage, as electron-builder names it (electron-builder.yml). */
export const appImageName = (version: string): string =>
  `Fabrica-${version}-linux-x86_64.AppImage`

/** What the update test updates from, or why it has nothing to update. */
export type EarlierApp = Data.TaggedEnum<{
  /** The newest earlier release's AppImage. */
  Found: { readonly tag: string; readonly asset: string }
  /** The version is a pre-release, which the app's updates never read. */
  PreRelease: {}
  /** No earlier release has the AppImage. */
  NoEarlierApp: {}
}>
export const EarlierApp = Data.taggedEnum<EarlierApp>()

/** The newest release below `version` whose AppImage is among its assets. */
export const earlierApp = (
  version: string,
  releases: ReadonlyArray<Release>,
): EarlierApp =>
  Option.match(parseVersion(version), {
    onNone: () => EarlierApp.PreRelease(),
    onSome: current => {
      const earlier = releases
        .filter(release => !release.draft && !release.prerelease)
        .flatMap(release =>
          Option.toArray(
            Option.flatMap(
              Option.liftPredicate(release.tag, tag => tag.startsWith('v')),
              tag =>
                Option.map(parseVersion(tag.slice(1)), parsed => ({
                  release,
                  text: tag.slice(1),
                  parsed,
                })),
            ),
          ),
        )
        .filter(
          ({ parsed, release }) =>
            Order.isLessThan(versionOrder)(parsed, current) &&
            release.assets.includes(appImageName(release.tag.slice(1))),
        )
        .sort((a, b) => versionOrder(b.parsed, a.parsed))
      const [newest] = earlier
      return newest === undefined
        ? EarlierApp.NoEarlierApp()
        : EarlierApp.Found({
            tag: newest.release.tag,
            asset: appImageName(newest.text),
          })
    },
  })

/** The lines the workflow's step output takes. */
export const outputLines = (app: EarlierApp, version: string): string =>
  EarlierApp.$match(app, {
    Found: ({ tag, asset }) => `tag=${tag}\nasset=${asset}\n`,
    PreRelease: () =>
      `skip=${version} is a pre-release, never GitHub's latest, which the app's updates read\n`,
    NoEarlierApp: () =>
      `skip=no release before ${version} has the app's Linux x64 AppImage: the update is tested from the second release that publishes the app on\n`,
  })

const decodeRelease = Schema.decodeUnknownOption(Schema.fromJsonString(Release))

/** The releases of `gh api`'s lines, one JSON object each; none where a line isn't one. */
export const readReleases = (
  text: string,
): Option.Option<ReadonlyArray<Release>> =>
  Option.all(
    text
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => decodeRelease(line)),
  )

const usage = 'usage: node scripts/earlier-app.ts <version> <releases.jsonl>\n'

const main = (args: ReadonlyArray<string>): number => {
  const [version, path] = args
  if (version === undefined || path === undefined) {
    process.stderr.write(usage)
    return 2
  }
  const releases = Option.flatMap(
    Option.liftThrowable(() => readFileSync(path, 'utf8'))(),
    readReleases,
  )
  if (Option.isNone(releases)) {
    process.stderr.write(
      `earlier-app: ${path} lists no releases as gh api does\n`,
    )
    return 1
  }
  process.stdout.write(
    outputLines(earlierApp(version, releases.value), version),
  )
  return 0
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
