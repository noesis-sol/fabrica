import { Data, Option, Schema } from 'effect'
import type { AppUpdater } from 'electron-updater'

import { ReleaseVersion } from '@fabrica/contracts'

import { UpdateStatus } from '../preload/api'
import type { UpdateStatusCell } from './updateStatus'

// The app's own updates (spec §22.2): electron-updater, reading the public GitHub Releases
// (electron-builder.yml's `publish`), for the macOS app (from its zip), the Windows app (its NSIS
// installer) and the AppImage. A deb or rpm is updated by hand, so it never checks, and neither does a
// development build. An update is downloaded once found and installed as the app quits; main holds
// where it stands in the update status cell, which the page shows.
//
// The packaged app launched with `--no-update-check` doesn't check either: the smoke tests launch the
// artifact under test so (test/smoke.test.ts), and a check there could download a newer release and
// install it over the artifact as it quits.

/** The command-line switch that turns the app's update checks off. */
export const noUpdateCheck = 'no-update-check'

/** How often the app checks for an update while it runs, after its check at launch. */
export const checkInterval = 6 * 60 * 60 * 1000

/** Which updater a build updates itself with, or none. */
export type UpdateChannel = Data.TaggedEnum<{
  /** Squirrel.Mac, from the release's zip. */
  Mac: {}
  /** The release's NSIS installer. */
  Nsis: {}
  /** The release's AppImage, put in place of the running one. */
  AppImage: {}
  /** No update of its own: a development build, a deb or rpm, or updates turned off. */
  None: {}
}>
export const UpdateChannel = Data.taggedEnum<UpdateChannel>()

/** What the channel is decided from, read by main. */
export interface BuildFacts {
  readonly platform: NodeJS.Platform
  readonly packaged: boolean
  /** The AppImage's own path, which its runtime sets as `APPIMAGE`: none for a deb or rpm. */
  readonly appImage: Option.Option<string>
  /** Whether the app was launched with `--no-update-check`. */
  readonly checksOff: boolean
}

/** The updater the build updates itself with. */
export const updateChannel = (facts: BuildFacts): UpdateChannel => {
  if (!facts.packaged || facts.checksOff) {
    return UpdateChannel.None()
  }
  switch (facts.platform) {
    case 'darwin':
      return UpdateChannel.Mac()
    case 'win32':
      return UpdateChannel.Nsis()
    case 'linux':
      return Option.isSome(facts.appImage)
        ? UpdateChannel.AppImage()
        : UpdateChannel.None()
    default:
      return UpdateChannel.None()
  }
}

/** What the app follows of an updater's events; their values are decoded before they are trusted. */
export interface UpdaterListeners {
  readonly checking: () => void
  readonly available: (info: unknown) => void
  readonly notAvailable: () => void
  readonly progress: (progress: unknown) => void
  readonly downloaded: (info: unknown) => void
  readonly error: (error: unknown) => void
}

/** An updater as the app uses it: one that downloads an update it finds and installs it as the app quits. */
export interface Updater {
  readonly listen: (listeners: UpdaterListeners) => void
  readonly checkForUpdates: () => Promise<unknown>
}

/** electron-updater's `AppUpdater`, downloading what it finds and installing it as the app quits. */
export const fromAppUpdater = (updater: AppUpdater): Updater => {
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  return {
    listen: listeners => {
      updater.on('checking-for-update', listeners.checking)
      updater.on('update-available', listeners.available)
      updater.on('update-not-available', listeners.notAvailable)
      updater.on('download-progress', listeners.progress)
      updater.on('update-downloaded', listeners.downloaded)
      updater.on('error', listeners.error)
    },
    checkForUpdates: () => updater.checkForUpdates(),
  }
}

/** Squirrel.Mac, Electron's own `autoUpdater`, as the macOS app follows it. */
export interface Squirrel {
  /** Calls `listener` each time Squirrel.Mac has fetched an update and staged it to install. */
  readonly onDownloaded: (listener: () => void) => void
}

/**
 * The macOS updater, whose update is ready only once Squirrel.Mac has it: electron-updater's MacUpdater
 * says its update is downloaded once it has the zip, and only then has Squirrel.Mac fetch it from its
 * local proxy; an app quit before Squirrel.Mac has it installs nothing. Until then the download shows
 * whole. Squirrel.Mac's errors are MacUpdater's own `error` events already.
 */
export const readyWithSquirrel = (
  updater: Updater,
  squirrel: Squirrel,
): Updater => ({
  listen: listeners => {
    // What electron-updater said of the update it downloaded, which Squirrel.Mac's event doesn't name.
    let downloaded: Option.Option<unknown> = Option.none()
    squirrel.onDownloaded(() => {
      Option.map(downloaded, listeners.downloaded)
    })
    updater.listen({
      ...listeners,
      downloaded: info => {
        downloaded = Option.some(info)
        listeners.progress({ percent: 100 })
      },
    })
  },
  checkForUpdates: updater.checkForUpdates,
})

const decodeVersion = Schema.decodeUnknownOption(ReleaseVersion)

const UpdateInfo = Schema.Struct({ version: Schema.String })
const decodeInfo = Schema.decodeUnknownOption(UpdateInfo)

const Progress = Schema.Struct({ percent: Schema.Number })
const decodeProgress = Schema.decodeUnknownOption(Progress)

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** The status an update event's release makes, or Failed where it names no release version. */
const withVersion = (
  info: unknown,
  make: (version: ReleaseVersion) => UpdateStatus,
): UpdateStatus =>
  Option.match(
    Option.flatMap(decodeInfo(info), ({ version }) => decodeVersion(version)),
    {
      onNone: () =>
        UpdateStatus.cases.Failed.make({
          reason: 'the release found names no version',
        }),
      onSome: make,
    },
  )

/**
 * Follows `updater`'s events into `status`, and checks for an update now and every `every` after: an
 * update found is downloaded, and installed as the app quits. The function returned stops the checks.
 */
export const followUpdates = (options: {
  readonly updater: Updater
  readonly status: UpdateStatusCell
  /** Runs `check` every `interval` ms; the function returned stops it. */
  readonly every: (interval: number, check: () => void) => () => void
}): (() => void) => {
  const { updater, status } = options
  // The version being downloaded, which electron-updater's progress events don't name.
  let downloading: Option.Option<ReleaseVersion> = Option.none()
  updater.listen({
    checking: () => status.set(UpdateStatus.cases.Checking.make({})),
    notAvailable: () => status.set(UpdateStatus.cases.UpToDate.make({})),
    available: info =>
      status.set(
        withVersion(info, version => {
          downloading = Option.some(version)
          return UpdateStatus.cases.Downloading.make({ version, percent: 0 })
        }),
      ),
    progress: progress => {
      Option.map(
        Option.all({
          version: downloading,
          progress: decodeProgress(progress),
        }),
        ({ version, progress }) =>
          status.set(
            UpdateStatus.cases.Downloading.make({
              version,
              percent: Math.min(100, Math.max(0, progress.percent)),
            }),
          ),
      )
    },
    downloaded: info =>
      status.set(
        withVersion(info, version =>
          UpdateStatus.cases.Ready.make({ version }),
        ),
      ),
    error: error =>
      status.set(UpdateStatus.cases.Failed.make({ reason: reasonOf(error) })),
  })
  const check = (): void => {
    // A failed check is told by the updater's `error` event, which sets the status.
    updater.checkForUpdates().catch(() => undefined)
  }
  status.set(UpdateStatus.cases.Idle.make({}))
  check()
  return options.every(checkInterval, check)
}
