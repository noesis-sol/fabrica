import { Effect, Option } from 'effect'
import { app, session } from 'electron'

import {
  context,
  mainIpc,
  makeUpdater,
  openExternal,
  page,
  reachKnownWslEngine,
  reachLocalEngine,
} from './context'
import { registerAddEngine } from './features/add-engine'
import { registerAppVersion } from './features/app-version'
import { registerEngineList } from './features/engine-list'
import { registerFolderPick } from './features/folder-pick'
import { registerLoginService } from './features/login-service'
import { registerNotify } from './features/notify'
import { registerSshAnswers } from './features/ssh-answers'
import { registerTheme } from './features/theme'
import { registerTlsPairing } from './features/tls-pairing'
import { registerWindowControls } from './features/window-controls'
import { makeIpcRegistrar } from './ipc'
import { keptTheme } from './keptTheme'
import { isAppUrl } from './navigation'
import { guardPermissions, guardWebContents } from './security'
import { followUpdates } from './updates'

// Electron main (spec §5): the app's lifecycle, and the preload's API, a feature per module under
// ./features, each registering its channels with the parts ./context makes (the window, the connection
// process, the app's state, …). A feature is one line below, sorted by name, so features added side by
// side add lines apart. Main runs no orchestration and stays out of the data path.

const { appWindow, updateStatus, userData } = context

// One window: a second start of the app shows the first's.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', appWindow.show)

  app.on('web-contents-created', (_event, contents) =>
    guardWebContents(contents, page, openExternal),
  )

  const ipc = makeIpcRegistrar({
    ipc: mainIpc,
    trusted: url => isAppUrl(page, url),
  })
  registerAddEngine(ipc, context)
  registerAppVersion(ipc, context)
  registerEngineList(ipc, context)
  registerFolderPick(ipc, context)
  registerLoginService(ipc, context)
  registerNotify(ipc, context)
  registerSshAnswers(ipc, context)
  registerTheme(ipc, context)
  registerTlsPairing(ipc, context)
  registerWindowControls(ipc, context)

  void app.whenReady().then(async () => {
    void Effect.runPromise(reachLocalEngine)
    void Effect.runPromise(reachKnownWslEngine)
    Option.map(makeUpdater(), updater =>
      followUpdates({
        updater,
        status: updateStatus,
        every: (interval, check) => {
          const timer = setInterval(check, interval)
          return () => clearInterval(timer)
        },
      }),
    )
    guardPermissions(session.defaultSession)
    // The window opens in the theme the page last showed, kept in the app's data folder.
    Option.map(await Effect.runPromise(keptTheme(userData)), appWindow.setTheme)
    appWindow.show()
    app.on('activate', appWindow.show)
  })

  app.on('before-quit', appWindow.quit)

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
