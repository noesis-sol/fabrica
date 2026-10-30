import { Effect, Option, Schema } from 'effect'
import {
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  MessageChannelMain,
  type MessagePortMain,
  Notification,
  type OpenDialogOptions,
  type WebContents,
  app,
  autoUpdater,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell,
  utilityProcess,
} from 'electron'
import { AppImageUpdater, MacUpdater, NsisUpdater } from 'electron-updater'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  type CheckAnswer,
  type EngineHost,
  type InstallAnswer,
  type InstallConsent,
  type UbuntuInstall,
  type WslDistro,
  type WslSearch,
  checkedDistro,
  installedDistro,
} from '@fabrica/client'
import { findDistribution } from '@fabrica/client/node'
import { ReleaseVersion } from '@fabrica/contracts'
import { ServiceInstall } from '@fabrica/ui/host'
import type { EnginePortRequest } from '@fabrica/ui/port'
import { type Theme, defaultTheme } from '@fabrica/ui/theme'
import { windowColours } from '@fabrica/ui/window-colours'

import { askpassArguments } from '../connection/askpass'
import { definedOf } from '../connection/env'
import { ConnectionTarget, encodeTarget } from '../connection/target'
import { FolderPick, UpdateStatus, channels } from '../preload/api'
import { appDataFolder } from './dataFolder'
import { checkEngineOn, engineSource, installEngineOn } from './engine-install'
import {
  type MainIpc,
  registerIpc,
  sendEnginePort,
  sendRemoteEnginePort,
  sendSshPrompt,
} from './ipc'
import { keptTheme, makeThemeKeeper } from './keptTheme'
import { knownEnginesOf } from './known-engines'
import {
  bundledLauncher,
  ensureLocalEngine,
  installLoginService,
} from './local-engine'
import { AppPage, isAppUrl } from './navigation'
import { makeNotifications } from './notifications'
import { makeFingerprintDesk, makePairings } from './pairing'
import { type BrokeredPage, localTarget, makeBroker } from './ports'
import { guardPermissions, guardWebContents } from './security'
import { askpassNode, makePromptDesk } from './ssh-prompts'
import { makeAppState, safeStorageBox } from './state'
import { makeUpdateStatusCell } from './updateStatus'
import {
  UpdateChannel,
  type Updater,
  followUpdates,
  fromAppUpdater,
  noUpdateCheck,
  readyWithSquirrel,
  updateChannel,
} from './updates'
import {
  WindowClose,
  titleBarOverlay,
  windowClose,
  windowOptions,
} from './window'
import { installUbuntu, launchDistro, reachWslEngine } from './wsl'

// Electron main (spec §5): the window, its title bar and its confinement, the preload's API, the
// connection process, to which it brokers each page's engine port, and a port to each known engine the
// page asks for, and whose ssh prompts it asks the page (§9.1), the app's state with its known engines,
// the pairings with engines over TLS, whose certificates the connection process reads (§9.3), and the
// local engine, started at launch when none answers (§7.1); on Windows, where none runs, the
// engine in WSL2, kept running (§7.6). It runs no orchestration and stays out of the data path.

const preload = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))
const connectionProcess = fileURLToPath(
  new URL('./connection.js', import.meta.url),
)

// The app's data folder, set before anything reads it: the single-instance lock and the kept theme are in it.
Option.map(
  appDataFolder({
    platform: process.platform,
    packaged: app.isPackaged,
    appData: app.getPath('appData'),
  }),
  folder => app.setPath('userData', folder),
)

/** How long main waits before starting a connection process that exited again. */
const connectionRestartPause = 1_000

// The home folder as the engine the app starts and the CLI read it (node:os, which follows HOME), so all
// three find one socket: Electron's own on macOS ignores HOME.
const target = localTarget({
  platform: process.platform,
  home: homedir(),
  environment: process.env,
})

/** The engine distribution the app bundles: a packaged app's only; a development build starts none. */
const localEngine = {
  launcher: app.isPackaged
    ? Option.some(bundledLauncher(process.resourcesPath))
    : Option.none(),
  env: process.env,
}

/** Starts the local engine where none answers; the connection reaches it once it does. */
const reachLocalEngine = ConnectionTarget.match(target, {
  LocalSocket: ({ path }) =>
    ensureLocalEngine({ socket: path, ...localEngine }).pipe(
      Effect.asVoid,
      Effect.catch(error =>
        Effect.logWarning(`the local engine: ${error.message}`),
      ),
    ),
  Ssh: () => Effect.void,
  Wsl: () => Effect.void,
  Tls: () => Effect.void,
  Unavailable: () => Effect.void,
  Refused: () => Effect.void,
})

const installService = (): Promise<ServiceInstall> =>
  Effect.runPromise(
    installLoginService(localEngine).pipe(
      Effect.as(ServiceInstall.cases.Installed.make({})),
      Effect.catch(error =>
        Effect.succeed(
          ServiceInstall.cases.Failed.make({ reason: error.reason }),
        ),
      ),
    ),
  )

const version = Schema.decodeUnknownSync(ReleaseVersion)(app.getVersion())

/**
 * The engine Add engine installs: a packaged app's own version, from its signed release folder where it
 * carries one, else from Fabrica's releases; a development build's, the latest release.
 */
const installSource = () =>
  engineSource({
    resources: app.isPackaged
      ? Option.some(process.resourcesPath)
      : Option.none(),
    stage: app.getPath('temp'),
    release: app.isPackaged ? Option.some(version) : Option.none(),
  })

/** wsl.exe as the app runs it: the user's environment, `wsl.exe` found on its PATH. */
const wslRunner = { env: definedOf(process.env) }

/** Has every page reach the engine in `distro`, the distribution kept running while it answers. */
const reachWsl = (distro: WslDistro) =>
  Effect.map(reachWslEngine({ ...wslRunner, distro }), ({ target }) =>
    broker.retarget(target),
  )

/** The app's own state, in its data folder: the known engines, and pairing tokens in safeStorage. */
const appState = Effect.runSync(
  makeAppState({
    folder: app.getPath('userData'),
    secrets: safeStorageBox(safeStorage, process.platform),
  }),
)

/** The app's engine in WSL2 at launch, where this machine runs none: the first known one. */
const reachKnownWslEngine = appState.engines.pipe(
  Effect.flatMap(known =>
    Option.match(launchDistro({ local: target, known }), {
      onNone: () => Effect.void,
      onSome: reachWsl,
    }),
  ),
  Effect.catch(error =>
    Effect.logWarning(`the known engines: ${error.reason}`),
  ),
)

/** Checks the engine on a host; one found up to date in WSL2 is the engine the app reaches then. */
const checkEngine = (host: EngineHost): Promise<CheckAnswer> =>
  Effect.runPromise(
    installSource().pipe(
      Effect.flatMap(source =>
        checkEngineOn({ host, source, env: definedOf(process.env) }),
      ),
      Effect.tap(answer =>
        Option.match(checkedDistro({ host, answer }), {
          onNone: () => Effect.void,
          onSome: reachWsl,
        }),
      ),
    ),
  )

const findWsl = (): Promise<WslSearch> =>
  Effect.runPromise(findDistribution(wslRunner))

const installUbuntuInWsl = (): Promise<UbuntuInstall> =>
  Effect.runPromise(installUbuntu(wslRunner))

/** Installs or updates the engine on a host; one installed in WSL2 is the engine the app reaches then. */
const installEngine = (request: {
  readonly host: EngineHost
  readonly consent: InstallConsent
}): Promise<InstallAnswer> =>
  Effect.runPromise(
    installSource().pipe(
      Effect.flatMap(source =>
        installEngineOn({ ...request, source, env: definedOf(process.env) }),
      ),
      Effect.tap(answer =>
        Option.match(installedDistro({ host: request.host, answer }), {
          onNone: () => Effect.void,
          onSome: reachWsl,
        }),
      ),
    ),
  )

const promptDesk = makePromptDesk({
  // The broker and the window are made below; the desk reaches them once the connection process asks.
  toPage: event =>
    Option.map(Option.fromUndefinedOr(appWindow.current()), window =>
      sendSshPrompt(window.webContents, event),
    ),
  toConnection: answer => broker.post(answer),
})

const broker = makeBroker<MessagePortMain>({
  spawn: onExit => {
    const child = utilityProcess.fork(
      connectionProcess,
      askpassArguments(
        askpassNode({
          platform: process.platform,
          packaged: app.isPackaged,
          resources: process.resourcesPath,
        }),
      ),
    )
    child.on('message', promptDesk.fromConnection)
    child.on('message', fingerprintDesk.fromConnection)
    child.once('exit', () => {
      promptDesk.connectionGone()
      fingerprintDesk.connectionGone()
      onExit()
    })
    return {
      relay: (target, port) => child.postMessage(encodeTarget(target), [port]),
      post: message => child.postMessage(message),
    }
  },
  afterExit: restart => {
    setTimeout(restart, connectionRestartPause)
  },
  channel: () => {
    const { port1, port2 } = new MessageChannelMain()
    return { page: port1, relay: port2 }
  },
  target,
})

// The connection process is started for a fingerprint asked of it, as for a port.
const fingerprintDesk = makeFingerprintDesk(request => broker.ask(request))

const pairings = makePairings({ state: appState, read: fingerprintDesk.read })

/** Relays a port to the known engine at `address`, for the page's request numbered `request`. */
const connectEngine = ({ request, address }: EnginePortRequest): void => {
  void Effect.runPromise(pairings.target(address, target)).then(to =>
    Option.map(Option.fromUndefinedOr(appWindow.current()), window =>
      broker.connect(to, port =>
        sendRemoteEnginePort(window.webContents, { request, port }),
      ),
    ),
  )
}

const brokeredPage = (
  contents: WebContents,
): BrokeredPage<MessagePortMain> => ({
  onLoad: listener => contents.on('did-finish-load', listener),
  onGone: listener => contents.once('destroyed', listener),
  send: port => sendEnginePort(contents, port),
})

// The dev server only in a development build: a packaged app never loads a page from a variable.
const devServer = process.env['ELECTRON_RENDERER_URL']
const page: AppPage =
  !app.isPackaged && devServer !== undefined
    ? AppPage.DevServer({ url: devServer })
    : AppPage.File({
        url: pathToFileURL(
          fileURLToPath(new URL('../renderer/index.html', import.meta.url)),
        ).href,
      })

const updateStatus = makeUpdateStatusCell(
  UpdateStatus.cases.Unavailable.make({}),
)

/** The updater this build updates itself with, made once the app is ready: none leaves the status Unavailable. */
const makeUpdater = (): Option.Option<Updater> =>
  UpdateChannel.$match(
    updateChannel({
      platform: process.platform,
      packaged: app.isPackaged,
      appImage: Option.fromUndefinedOr(process.env['APPIMAGE']),
      checksOff: app.commandLine.hasSwitch(noUpdateCheck),
    }),
    {
      Mac: () =>
        Option.some(
          readyWithSquirrel(fromAppUpdater(new MacUpdater()), {
            onDownloaded: listener =>
              autoUpdater.on('update-downloaded', listener),
          }),
        ),
      Nsis: () => Option.some(fromAppUpdater(new NsisUpdater())),
      AppImage: () => Option.some(fromAppUpdater(new AppImageUpdater())),
      None: () => Option.none(),
    },
  )

const openExternal = (url: string): void => {
  void shell.openExternal(url)
}

/** The app's one window: made when first shown, again after it closes; on macOS hidden when closed. */
const makeAppWindow = () => {
  let current: BrowserWindow | undefined
  let theme: Theme = defaultTheme
  let quitting = false

  /** Hides `window`, out of full screen first: a full-screen window hidden leaves its space black. */
  const hide = (window: BrowserWindow): void => {
    if (window.isFullScreen()) {
      window.once('leave-full-screen', () => window.hide())
      window.setFullScreen(false)
    } else {
      window.hide()
    }
  }

  const create = (): BrowserWindow => {
    const window = new BrowserWindow(
      windowOptions({
        platform: process.platform,
        colours: windowColours(theme),
        preload,
      }),
    )
    window.once('ready-to-show', () => window.show())
    window.webContents.on('did-finish-load', promptDesk.pageLoaded)
    broker.attach(brokeredPage(window.webContents))
    const stopUpdates = updateStatus.subscribe(status =>
      window.webContents.send(channels.updateStatusChanged, status),
    )
    window.on('close', event =>
      WindowClose.$match(
        windowClose({ platform: process.platform, quitting }),
        {
          Hide: () => {
            event.preventDefault()
            hide(window)
          },
          Close: () => undefined,
        },
      ),
    )
    window.on('closed', () => {
      stopUpdates()
      if (current === window) {
        current = undefined
      }
    })
    void window.loadURL(page.url)
    return window
  }

  return {
    current: (): BrowserWindow | undefined => current,
    show: (): void => {
      if (current === undefined) {
        current = create()
      } else {
        if (current.isMinimized()) {
          current.restore()
        }
        if (!current.isVisible()) {
          current.show()
        }
        current.focus()
      }
    },
    /** Lets the window close as the app quits, rather than hide. */
    quit: (): void => {
      quitting = true
    },
    /** The theme the window is made in, and coloured in. */
    theme: (): Theme => theme,
    /** Colours the window and its title bar for the theme the page shows, now and when next made. */
    setTheme: (next: Theme): void => {
      theme = next
      if (current !== undefined) {
        const colours = windowColours(next)
        Option.map(colours, ({ background }) =>
          current?.setBackgroundColor(background),
        )
        if (process.platform !== 'darwin') {
          current.setTitleBarOverlay(titleBarOverlay(colours))
        }
      }
    },
  }
}

const appWindow = makeAppWindow()

const themeKeeper = makeThemeKeeper(app.getPath('userData'))

/** Colours the window in the theme the page shows, and keeps a new one for the next start's window. */
const setTheme = (theme: Theme): void => {
  if (theme === appWindow.theme()) {
    return
  }
  appWindow.setTheme(theme)
  void Effect.runPromise(
    themeKeeper
      .keep(theme)
      .pipe(
        Effect.catch(error =>
          Effect.logWarning(`keeping the theme: ${error.reason}`),
        ),
      ),
  )
}

const notifications = makeNotifications({
  system: Notification,
  window: {
    hasFocus: () => {
      const window = appWindow.current()
      return window !== undefined && window.isVisible() && window.isFocused()
    },
    reveal: () => {
      appWindow.show()
      return appWindow.current()?.webContents
    },
  },
})

const pickFolder = async (): Promise<FolderPick> => {
  const options: OpenDialogOptions = {
    properties: ['openDirectory', 'createDirectory'],
  }
  const window = appWindow.current()
  const { canceled, filePaths } =
    window === undefined
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options)
  const [path] = filePaths
  return canceled || path === undefined || path === ''
    ? FolderPick.cases.Cancelled.make({})
    : FolderPick.cases.Picked.make({ path })
}

const ipc: MainIpc = {
  on: (channel, listener) =>
    ipcMain.on(channel, (event: IpcMainEvent, ...values: Array<unknown>) =>
      listener(event.senderFrame?.url, values),
    ),
  handle: (channel, handler) =>
    ipcMain.handle(
      channel,
      (event: IpcMainInvokeEvent, ...values: Array<unknown>) =>
        handler(event.senderFrame?.url, values),
    ),
}

// One window: a second start of the app shows the first's.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', appWindow.show)

  app.on('web-contents-created', (_event, contents) =>
    guardWebContents(contents, page, openExternal),
  )

  registerIpc({
    ipc,
    trusted: url => isAppUrl(page, url),
    actions: {
      minimize: () => appWindow.current()?.minimize(),
      toggleMaximize: () => {
        const window = appWindow.current()
        if (window?.isMaximized() === true) {
          window.unmaximize()
        } else {
          window?.maximize()
        }
      },
      close: () => appWindow.current()?.close(),
      setTheme,
      notify: notifications.notify,
      pickFolder,
      version,
      updateStatus: updateStatus.get,
      installLoginService: installService,
      checkEngine,
      installEngine,
      findWsl,
      installUbuntu: installUbuntuInWsl,
      answerSshPrompt: promptDesk.answer,
      knownEngines: () => Effect.runPromise(knownEnginesOf(appState)),
      keepEngine: engine => Effect.runPromise(pairings.keep(engine)),
      readFingerprint: endpoint =>
        Effect.runPromise(pairings.readFingerprint(endpoint)),
      pairEngine: request => Effect.runPromise(pairings.pair(request)),
      connectEngine,
    },
  })

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
    Option.map(
      await Effect.runPromise(keptTheme(app.getPath('userData'))),
      appWindow.setTheme,
    )
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
