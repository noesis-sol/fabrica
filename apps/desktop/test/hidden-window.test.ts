import { Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { WindowClose, windowClose, windowOptions } from '../src/main/window'

// The macOS app outlives its window (spec §18.5): closing the window hides it until the app quits,
// so its page goes on deciding the notifications to tell, its timers unthrottled while hidden.

describe('closing the app’s window', () => {
  it('on macOS, hides it while the app goes on', () => {
    expect(windowClose({ platform: 'darwin', quitting: false })).toEqual(
      WindowClose.Hide(),
    )
  })

  it('on macOS, closes it as the app quits', () => {
    expect(windowClose({ platform: 'darwin', quitting: true })).toEqual(
      WindowClose.Close(),
    )
  })

  it('on Windows and Linux, closes it, the app quitting with it', () => {
    for (const platform of ['win32', 'linux'] as const) {
      for (const quitting of [false, true]) {
        expect(windowClose({ platform, quitting })).toEqual(WindowClose.Close())
      }
    }
  })

  it('keeps a hidden or minimized page’s timers running', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const options = windowOptions({
        platform,
        colours: Option.none(),
        preload: '/p.cjs',
      })
      expect(options.webPreferences?.backgroundThrottling).toBe(false)
    }
  })
})
