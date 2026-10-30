import { Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { appDataFolder } from '../src/main/dataFolder'

// The data folder `--user-data-dir` names (spec §7.2, §24): kept by a packaged app and a development build
// alike, so the smoke tests can keep the app under test from the user's own on macOS.

describe('a data folder --user-data-dir names', () => {
  it('is the packaged app’s, on every platform', () => {
    for (const [platform, appData] of [
      ['darwin', '/Users/ada/Library/Application Support'],
      ['linux', '/home/ada/.config'],
      ['win32', 'C:\\Users\\ada\\AppData\\Roaming'],
    ] as const) {
      expect(
        appDataFolder({
          platform,
          packaged: true,
          appData,
          given: Option.some('/tmp/fabrica-smoke-1/app'),
        }),
      ).toEqual(Option.some('/tmp/fabrica-smoke-1/app'))
    }
  })

  it('is a development build’s', () => {
    expect(
      appDataFolder({
        platform: 'darwin',
        packaged: false,
        appData: '/Users/ada/Library/Application Support',
        given: Option.some('/tmp/fabrica-dev'),
      }),
    ).toEqual(Option.some('/tmp/fabrica-dev'))
  })
})
