// scripts/earlier-app.ts: the earlier release whose app the release's update test updates (spec §22.2,
// §22.5). Once a release is published, .github/workflows/release.yml's `update` job downloads, on each
// target the app updates itself on, the newest earlier release's app (the Linux x64 AppImage, the Windows
// x64 NSIS installer, a macOS architecture's zip) and checks that it updates itself to the new one from
// the published feeds.
//
//   gh api --paginate repos/<owner>/<repo>/releases \
//     --jq '.[] | {tag: .tag_name, draft, prerelease, assets: [.assets[].name]} | tojson' > releases.jsonl
//   node scripts/earlier-app.ts <version> releases.jsonl <target> >> "$GITHUB_OUTPUT"
//
// It prints `tag=v<earlier>` and `asset=<its app>`, or `skip=<why>` where there is nothing to test: the
// version is a pre-release, which is never GitHub's latest, the one electron-updater's GitHub provider
// reads (the app leaves allowPrerelease off), or no earlier release has the target's app, as before the
// second release that publishes it. An earlier release is a published one, neither a draft nor a
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

/** The targets the app updates itself on, as .github/workflows/app.yml names them. */
export const AppTarget = Schema.Literals([
  'linux-x64',
  'windows-x64',
  'macos-x64',
  'macos-arm64',
])
export type AppTarget = typeof AppTarget.Type

/**
 * The name of the file a release's app updates from on `target`, as electron-builder names it
 * (electron-builder.yml): the AppImage, the NSIS installer, the zip.
 */
export const appAssetName = (target: AppTarget, version: string): string => {
  switch (target) {
    case 'linux-x64':
      return `Fabrica-${version}-linux-x86_64.AppImage`
    case 'windows-x64':
      return `Fabrica-${version}-win-x64.exe`
    case 'macos-x64':
      return `Fabrica-${version}-mac-x64.zip`
    case 'macos-arm64':
      return `Fabrica-${version}-mac-arm64.zip`
  }
}

/** What `target`'s app is, for a reason to skip. */
const appDescription = (target: AppTarget): string => {
  switch (target) {
    case 'linux-x64':
      return 'Linux x64 AppImage'
    case 'windows-x64':
      return 'Windows x64 installer'
    case 'macos-x64':
      return 'macOS x64 zip'
    case 'macos-arm64':
      return 'macOS arm64 zip'
  }
}

/** What the update test updates from, or why it has nothing to update. */
export type EarlierApp = Data.TaggedEnum<{
  /** The newest earlier release's app. */
  Found: { readonly tag: string; readonly asset: string }
  /** The version is a pre-release, which the app's updates never read. */
  PreRelease: {}
  /** No earlier release has the target's app. */
  NoEarlierApp: {}
}>
export const EarlierApp = Data.taggedEnum<EarlierApp>()

/** The newest release below `version` whose app for `target` is among its assets. */
export const earlierApp = (options: {
  readonly version: string
  readonly target: AppTarget
  readonly releases: ReadonlyArray<Release>
}): EarlierApp => {
  const { version, target, releases } = options
  return Option.match(parseVersion(version), {
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
            release.assets.includes(appAssetName(target, release.tag.slice(1))),
        )
        .sort((a, b) => versionOrder(b.parsed, a.parsed))
      const [newest] = earlier
      return newest === undefined
        ? EarlierApp.NoEarlierApp()
        : EarlierApp.Found({
            tag: newest.release.tag,
            asset: appAssetName(target, newest.text),
          })
    },
  })
}

/** The lines the workflow's step output takes. */
export const outputLines = (options: {
  readonly app: EarlierApp
  readonly version: string
  readonly target: AppTarget
}): string =>
  EarlierApp.$match(options.app, {
    Found: ({ tag, asset }) => `tag=${tag}\nasset=${asset}\n`,
    PreRelease: () =>
      `skip=${options.version} is a pre-release, never GitHub's latest, which the app's updates read\n`,
    NoEarlierApp: () =>
      `skip=no release before ${options.version} has the app's ${appDescription(options.target)}: the update is tested from the second release that publishes it on\n`,
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

const usage = `usage: node scripts/earlier-app.ts <version> <releases.jsonl> <${AppTarget.literals.join('|')}>\n`

const decodeTarget = Schema.decodeUnknownOption(AppTarget)

const main = (args: ReadonlyArray<string>): number => {
  const [version, path, targetName] = args
  const target = decodeTarget(targetName)
  if (version === undefined || path === undefined || Option.isNone(target)) {
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
  const app = earlierApp({
    version,
    target: target.value,
    releases: releases.value,
  })
  process.stdout.write(outputLines({ app, version, target: target.value }))
  return 0
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
