import { Result } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import { UnsupportedPlatform, userConfigFolder } from '../src/engine'

// The folder of what the user keeps for the `fabrica` command (spec §19): where each platform keeps a
// user's own settings, whichever engine the command talks to.

describe('userConfigFolder', () => {
  it('is under Application Support on macOS', () => {
    expect(
      userConfigFolder({
        platform: 'darwin',
        home: '/Users/u',
        environment: { XDG_CONFIG_HOME: '/elsewhere' },
      }),
    ).toStrictEqual(
      Result.succeed('/Users/u/Library/Application Support/fabrica'),
    )
  })

  it('is under $XDG_CONFIG_HOME on Linux', () => {
    expect(
      userConfigFolder({
        platform: 'linux',
        home: '/home/u',
        environment: { XDG_CONFIG_HOME: '/custom/config' },
      }),
    ).toStrictEqual(Result.succeed('/custom/config/fabrica'))
  })

  it.each(['', 'relative/config'])(
    'is under ~/.config on Linux where $XDG_CONFIG_HOME is %j, which the specification ignores',
    value => {
      expect(
        userConfigFolder({
          platform: 'linux',
          home: '/home/u',
          environment: { XDG_CONFIG_HOME: value },
        }),
      ).toStrictEqual(Result.succeed('/home/u/.config/fabrica'))
    },
  )

  it('is under ~/.config on Linux where $XDG_CONFIG_HOME isn’t set', () => {
    expect(
      userConfigFolder({
        platform: 'linux',
        home: '/home/u',
        environment: {},
      }),
    ).toStrictEqual(Result.succeed('/home/u/.config/fabrica'))
  })

  it('has none on a platform the CLI doesn’t run on', () => {
    expect(
      userConfigFolder({ platform: 'win32', home: 'C:\\u', environment: {} }),
    ).toStrictEqual(Result.fail(new UnsupportedPlatform({ platform: 'win32' })))
  })
})
