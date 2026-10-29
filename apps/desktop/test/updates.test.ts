import { Option, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { ReleaseVersion } from '@fabrica/contracts'

import { makeUpdateStatusCell } from '../src/main/updateStatus'
import {
  type BuildFacts,
  UpdateChannel,
  type Updater,
  type UpdaterListeners,
  checkInterval,
  followUpdates,
  updateChannel,
} from '../src/main/updates'
import { UpdateStatus } from '../src/preload/api'

// The app's own updates (spec §22.2): which builds update themselves, and how the updater's events
// show in the update status. The updater is a fake standing for electron-updater's: its events are
// played as electron-updater sends them, and its checks counted.

const packaged: BuildFacts = {
  platform: 'darwin',
  packaged: true,
  appImage: Option.none(),
  checksOff: false,
}

const version = Schema.decodeUnknownSync(ReleaseVersion)

/** An updater whose events the test plays, and the checks it was asked for. */
const fakeUpdater = (check: () => Promise<unknown> = async () => undefined) => {
  let listeners: Option.Option<UpdaterListeners> = Option.none()
  let checks = 0
  const updater: Updater = {
    listen: given => {
      listeners = Option.some(given)
    },
    checkForUpdates: () => {
      checks += 1
      return check()
    },
  }
  const play = (event: (listeners: UpdaterListeners) => void): void =>
    Option.match(listeners, {
      onNone: () => {
        throw new Error('nothing listens to the updater')
      },
      onSome: event,
    })
  return { updater, play, checks: () => checks }
}

/** Follows `updater` into a fresh status cell, its periodic checks held for the test to run. */
const follow = (updater: Updater) => {
  const status = makeUpdateStatusCell(UpdateStatus.cases.Unavailable.make({}))
  const seen: Array<UpdateStatus> = []
  status.subscribe(next => seen.push(next))
  const every: Array<{ interval: number; check: () => void }> = []
  let stopped = false
  const stop = followUpdates({
    updater,
    status,
    every: (interval, check) => {
      every.push({ interval, check })
      return () => {
        stopped = true
      }
    },
  })
  return { status, seen, every, stop, stopped: () => stopped }
}

describe('which builds update themselves', () => {
  it('the packaged macOS and Windows apps, and the AppImage', () => {
    expect(updateChannel(packaged)).toEqual(UpdateChannel.Mac())
    expect(updateChannel({ ...packaged, platform: 'win32' })).toEqual(
      UpdateChannel.Nsis(),
    )
    expect(
      updateChannel({
        ...packaged,
        platform: 'linux',
        appImage: Option.some('/home/me/Fabrica.AppImage'),
      }),
    ).toEqual(UpdateChannel.AppImage())
  })

  it('not a deb or rpm, a development build, or one launched with its checks off', () => {
    expect(updateChannel({ ...packaged, platform: 'linux' })).toEqual(
      UpdateChannel.None(),
    )
    expect(updateChannel({ ...packaged, packaged: false })).toEqual(
      UpdateChannel.None(),
    )
    expect(updateChannel({ ...packaged, checksOff: true })).toEqual(
      UpdateChannel.None(),
    )
    expect(updateChannel({ ...packaged, platform: 'freebsd' })).toEqual(
      UpdateChannel.None(),
    )
  })
})

describe('following the updater', () => {
  it('checks at once, then every six hours until stopped', () => {
    const fake = fakeUpdater()
    const followed = follow(fake.updater)
    expect(fake.checks()).toBe(1)
    expect(followed.every.map(({ interval }) => interval)).toEqual([
      6 * 60 * 60 * 1000,
    ])
    expect(checkInterval).toBe(6 * 60 * 60 * 1000)
    followed.every[0]?.check()
    expect(fake.checks()).toBe(2)
    followed.stop()
    expect(followed.stopped()).toBe(true)
  })

  it('shows a check, a download as it goes, and the update ready to install', () => {
    const fake = fakeUpdater()
    const followed = follow(fake.updater)
    fake.play(on => on.checking())
    fake.play(on => on.available({ version: '1.2.0', files: [] }))
    fake.play(on => on.progress({ percent: 41.5, bytesPerSecond: 1 }))
    fake.play(on => on.progress({ percent: 100.2 }))
    fake.play(on => on.downloaded({ version: '1.2.0' }))
    expect(followed.seen).toEqual([
      UpdateStatus.cases.Idle.make({}),
      UpdateStatus.cases.Checking.make({}),
      UpdateStatus.cases.Downloading.make({
        version: version('1.2.0'),
        percent: 0,
      }),
      UpdateStatus.cases.Downloading.make({
        version: version('1.2.0'),
        percent: 41.5,
      }),
      UpdateStatus.cases.Downloading.make({
        version: version('1.2.0'),
        percent: 100,
      }),
      UpdateStatus.cases.Ready.make({ version: version('1.2.0') }),
    ])
  })

  it('shows none found, and a failure with what the updater said', () => {
    const fake = fakeUpdater()
    const followed = follow(fake.updater)
    fake.play(on => on.notAvailable())
    expect(followed.status.get()).toEqual(UpdateStatus.cases.UpToDate.make({}))
    fake.play(on => on.error(new Error('net::ERR_INTERNET_DISCONNECTED')))
    expect(followed.status.get()).toEqual(
      UpdateStatus.cases.Failed.make({
        reason: 'net::ERR_INTERNET_DISCONNECTED',
      }),
    )
  })

  it('takes no release that names no version, and no progress before a download', () => {
    const fake = fakeUpdater()
    const followed = follow(fake.updater)
    fake.play(on => on.progress({ percent: 10 }))
    expect(followed.status.get()).toEqual(UpdateStatus.cases.Idle.make({}))
    fake.play(on => on.available({ version: 'latest' }))
    expect(followed.status.get()).toEqual(
      UpdateStatus.cases.Failed.make({
        reason: 'the release found names no version',
      }),
    )
    fake.play(on => on.progress({ percent: 10 }))
    expect(followed.status.get()).toEqual(
      UpdateStatus.cases.Failed.make({
        reason: 'the release found names no version',
      }),
    )
  })

  it('leaves a check that fails to the updater’s error event', async () => {
    const fake = fakeUpdater(() => Promise.reject(new Error('offline')))
    const followed = follow(fake.updater)
    await Promise.resolve()
    expect(followed.status.get()).toEqual(UpdateStatus.cases.Idle.make({}))
  })
})
