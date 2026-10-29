import { Effect } from 'effect'
import { Runtime } from 'foldkit'

import type { Platform } from '@fabrica/contracts'

import { applyTheme, defaultTheme } from '../theme/theme'
import { localTicks } from './clock'
import { nextAnimationFrame } from './frame'
import { Message } from './message'
import { receiveEnginePort } from './port'
import { program } from './program'
import { documentKeys } from './subscriptions'

// Starting the renderer in a window, the one way both entries do (the app's and the renderer alone in
// a browser): the theme on the root, the program with the window's frames, keys and engine port, and
// the host's facts as its flags.

/** The app's release, said in its hello to the engine. */
export const appRelease = '0.0.0'

/** The platform a user agent names. */
export const platformOf = (userAgent: string): Platform =>
  /Mac/u.test(userAgent)
    ? 'darwin'
    : /Windows/u.test(userAgent)
      ? 'win32'
      : 'linux'

export const start = (target: Window): void => {
  applyTheme(target.document.documentElement, defaultTheme)
  const enginePort = receiveEnginePort(target)
  const application = Runtime.makeApplication({
    ...program({
      enginePort: Effect.promise(() => enginePort),
      nextFrame: nextAnimationFrame,
      keys: documentKeys(target.document),
      ticks: localTicks,
    }),
    container: target.document.getElementById('root'),
    devTools: { Message },
  })
  Runtime.run(application, {
    flags: Effect.succeed({
      platform: platformOf(target.navigator.userAgent),
      release: appRelease,
    }),
  })
}
