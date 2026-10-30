import { Option, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { ReleaseVersion } from '@fabrica/contracts'

import { makeUpdateStatusCell } from '../src/main/updateStatus'
import {
  type Squirrel,
  type Updater,
  type UpdaterListeners,
  followUpdates,
  readyWithSquirrel,
} from '../src/main/updates'
import { UpdateStatus } from '../src/preload/api'

// The macOS app's update is ready only once Squirrel.Mac has it: electron-updater's MacUpdater says it
// downloaded the update before Squirrel.Mac has fetched it from MacUpdater's proxy. The updater and
// Squirrel.Mac are fakes whose events the test plays in the order MacUpdater sends them.

const version = Schema.decodeUnknownSync(ReleaseVersion)

/** electron-updater's MacUpdater and Electron's autoUpdater, their events played by the test. */
const fakeMac = () => {
  let listeners: Option.Option<UpdaterListeners> = Option.none()
  const squirrelListeners: Array<() => void> = []
  const updater: Updater = {
    listen: given => {
      listeners = Option.some(given)
    },
    checkForUpdates: async () => undefined,
  }
  const squirrel: Squirrel = {
    onDownloaded: listener => {
      squirrelListeners.push(listener)
    },
  }
  const play = (event: (listeners: UpdaterListeners) => void): void =>
    Option.match(listeners, {
      onNone: () => {
        throw new Error('nothing listens to the updater')
      },
      onSome: event,
    })
  const squirrelHasIt = (): void => {
    for (const listener of squirrelListeners) {
      listener()
    }
  }
  return { updater: readyWithSquirrel(updater, squirrel), play, squirrelHasIt }
}

const follow = (updater: Updater) => {
  const status = makeUpdateStatusCell(UpdateStatus.cases.Unavailable.make({}))
  followUpdates({ updater, status, every: () => () => undefined })
  return status
}

describe('the macOS update, ready once Squirrel.Mac has it', () => {
  it('shows the download whole, not ready, until Squirrel.Mac has fetched it', () => {
    const mac = fakeMac()
    const status = follow(mac.updater)
    mac.play(on => on.available({ version: '1.2.0' }))
    mac.play(on => on.progress({ percent: 63 }))
    mac.play(on => on.downloaded({ version: '1.2.0' }))
    expect(status.get()).toEqual(
      UpdateStatus.cases.Downloading.make({
        version: version('1.2.0'),
        percent: 100,
      }),
    )
    mac.squirrelHasIt()
    expect(status.get()).toEqual(
      UpdateStatus.cases.Ready.make({ version: version('1.2.0') }),
    )
  })

  it('shows Squirrel.Mac failing to fetch it, which MacUpdater tells as its own error', () => {
    const mac = fakeMac()
    const status = follow(mac.updater)
    mac.play(on => on.available({ version: '1.2.0' }))
    mac.play(on => on.downloaded({ version: '1.2.0' }))
    mac.play(on => on.error(new Error('Code signature did not pass')))
    expect(status.get()).toEqual(
      UpdateStatus.cases.Failed.make({ reason: 'Code signature did not pass' }),
    )
  })

  it('takes nothing from Squirrel.Mac before electron-updater has downloaded an update', () => {
    const mac = fakeMac()
    const status = follow(mac.updater)
    mac.play(on => on.checking())
    mac.squirrelHasIt()
    expect(status.get()).toEqual(UpdateStatus.cases.Checking.make({}))
  })

  it('names the version electron-updater downloaded last when Squirrel.Mac has it', () => {
    const mac = fakeMac()
    const status = follow(mac.updater)
    mac.play(on => on.available({ version: '1.2.0' }))
    mac.play(on => on.downloaded({ version: '1.2.0' }))
    mac.squirrelHasIt()
    mac.play(on => on.available({ version: '1.3.0' }))
    mac.play(on => on.downloaded({ version: '1.3.0' }))
    expect(status.get()).toEqual(
      UpdateStatus.cases.Downloading.make({
        version: version('1.3.0'),
        percent: 100,
      }),
    )
    mac.squirrelHasIt()
    expect(status.get()).toEqual(
      UpdateStatus.cases.Ready.make({ version: version('1.3.0') }),
    )
  })
})
