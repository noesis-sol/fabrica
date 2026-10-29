import { Data } from 'effect'

import { UpdateFailed } from '@fabrica/contracts'

// Why an update or an install didn't happen (spec §9.2, §20.4): one tagged union, made by its
// constructors, each step failing with its own; and the words `engine.update` answers it with.
// Nothing is installed or relinked by a step before the ones that verify it have passed.

export type UpdateFailure = Data.TaggedEnum<{
  /** The engine holds no release key, so it can't tell a release made by Fabrica's workflow from another. */
  NoReleaseKey: {}
  /** The host isn't an engine target. */
  NoTarget: { readonly platform: string; readonly arch: string }
  /** The engine runs that release already. */
  AlreadyThere: { readonly version: string }
  /** The latest release is older than the engine's own. */
  LatestOlder: { readonly latest: string; readonly current: string }
  /** The engine takes no update now: another is under way, it is stopping, or it installs none. */
  Refused: { readonly why: string }
  /** A file of the release couldn't be downloaded. */
  DownloadFailed: { readonly url: string; readonly message: string }
  /** A file of the release was larger than it may be. */
  TooLarge: { readonly url: string; readonly limit: number }
  /** checksums.txt.sig doesn't verify checksums.txt with any release key. */
  BadSignature: {}
  /** checksums.txt lists no archive for this host, or more than one. */
  NoArchive: { readonly target: string; readonly release: string }
  /** The archive's SHA-256 isn't the one checksums.txt has. */
  ChecksumMismatch: {
    readonly archive: string
    readonly want: string
    readonly got: string
  }
  /** tar couldn't unpack the archive. */
  UnpackFailed: { readonly archive: string; readonly message: string }
  /** The unpacked archive holds no launcher. */
  NoLauncher: { readonly path: string }
  /** The new launcher's `--version` failed. */
  WontRun: { readonly message: string }
  /** The new launcher's `--version` names another version. */
  WrongVersion: { readonly said: string; readonly want: string }
  /** A file or a folder of the install couldn't be written. */
  PlaceFailed: { readonly path: string; readonly message: string }
}>
export const UpdateFailure = Data.taggedEnum<UpdateFailure>()

/** What an update failure says, in words. */
export const describeFailure = UpdateFailure.$match({
  NoReleaseKey: () =>
    "this engine holds no release key yet, so it can't tell a release made by Fabrica's release workflow from another: nothing was installed",
  NoTarget: ({ platform, arch }) =>
    `there is no engine distribution for ${platform} ${arch}: releases have macOS and Linux, arm64 and x64`,
  AlreadyThere: ({ version }) => `the engine runs ${version} already`,
  LatestOlder: ({ latest, current }) =>
    `the latest release, ${latest}, is older than this engine's ${current}: name a release to go back to it`,
  Refused: ({ why }) => why,
  DownloadFailed: ({ url, message }) => `cannot download ${url}: ${message}`,
  TooLarge: ({ url, limit }) =>
    `${url} is larger than the ${limit} bytes it may be: nothing was installed`,
  BadSignature: () =>
    "checksums.txt.sig doesn't verify checksums.txt with a release key: the release wasn't made by Fabrica's release workflow, or was changed since. Nothing was installed",
  NoArchive: ({ target, release }) =>
    `checksums.txt of ${release} lists no one engine archive for ${target}`,
  ChecksumMismatch: ({ archive, want, got }) =>
    `${archive}'s SHA-256 is ${got}, not checksums.txt's ${want}: nothing was installed`,
  UnpackFailed: ({ archive, message }) =>
    `cannot unpack ${archive}: ${message}`,
  NoLauncher: ({ path }) => `the archive holds no launcher at ${path}`,
  WontRun: ({ message }) => `the new engine doesn't run: ${message}`,
  WrongVersion: ({ said, want }) =>
    `the new engine's fabrica --version says '${said}', not ${want}`,
  PlaceFailed: ({ path, message }) => `cannot write ${path}: ${message}`,
})

/** The failure as `engine.update` answers it. */
export const updateFailed = (failure: UpdateFailure): UpdateFailed =>
  new UpdateFailed({ reason: describeFailure(failure) })
