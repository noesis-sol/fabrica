import { Effect, Option } from 'effect'
import { Runtime } from 'foldkit'

import type { Platform } from '@fabrica/contracts'

import { defaultTheme } from '../theme/theme'
import { localTicks } from './clock'
import { holdEnginePorts } from './engine-ports'
import { documentKeys } from './features/keys/keys'
import { nextAnimationFrame } from './frame'
import { appHostOf } from './host'
import { Message } from './message'
import { type NotifierShape, silentNotifier } from './notifier'
import { onEnginePorts, onRemoteEnginePorts } from './port'
import { program } from './program'
import { sshPromptHostOf } from './ssh-prompts'
import { themeHostOf } from './theme-host'

// Starting the renderer in a window, the one way both entries do (the app's and the renderer alone in
// a browser): the theme the install kept on the root, the program with the window's frames, keys, engine port and the
// app around it, and the host's facts as its flags. The app's entry passes the preload's
// notifications; the renderer alone shows none.

/** The app's release, said in its hello to the engine. */
export const appRelease = '0.0.0'

/** The platform a user agent names. */
export const platformOf = (userAgent: string): Platform =>
  /Mac/u.test(userAgent)
    ? 'darwin'
    : /Windows/u.test(userAgent)
      ? 'win32'
      : 'linux'

export const start = (
  target: Window,
  notifier: NotifierShape = silentNotifier,
): void => {
  const themeHost = themeHostOf(target)
  const theme = Effect.runSync(themeHost.kept)
  Effect.runSync(themeHost.show(Option.getOrElse(theme, () => defaultTheme)))
  const enginePorts = holdEnginePorts<MessagePort>(listener =>
    onEnginePorts(target, listener),
  )
  const application = Runtime.makeApplication({
    ...program({
      enginePort: enginePorts.take,
      replacedEnginePorts: enginePorts.replaced,
      nextFrame: nextAnimationFrame,
      keys: documentKeys(target.document),
      ticks: localTicks,
      notifier,
      host: appHostOf(
        target,
        Option.some(listener => onRemoteEnginePorts(target, listener)),
      ),
      sshPrompts: sshPromptHostOf(target),
      themeHost,
    }),
    container: target.document.getElementById('root'),
    devTools: { Message },
  })
  Runtime.run(application, {
    flags: Effect.succeed({
      platform: platformOf(target.navigator.userAgent),
      release: appRelease,
      ...Option.match(theme, {
        onNone: () => ({}),
        onSome: kept => ({ theme: kept }),
      }),
    }),
  })
}
