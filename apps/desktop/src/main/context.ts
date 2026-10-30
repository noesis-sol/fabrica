import { Effect, Option, Schema } from 'effect'
import {
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  MessageChannelMain,
  type MessagePortMain,
  Notification,
  type WebContents,
  app,
  autoUpdater,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  utilityProcess,
} from 'electron'
import { AppImageUpdater, MacUpdater, NsisUpdater } from 'electron-updater'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { WslDistro } from '@fabrica/client'
import { ReleaseVersion } from '@fabrica/contracts'
import { type Theme, defaultTheme } from '@fabrica/ui/theme'
import { windowColours } from '@fabrica/ui/window-colours'

import { askpassArguments } from '../connection/askpass'
import { definedOf } from '../connection/env'
import { LocalEngineReach } from '../connection/local-engine'
import { ConnectionTarget, encodeTarget } from '../connection/target'
import { UpdateStatus, channels } from '../preload/api'
import { appDataFolder, userDataSwitch } from './dataFolder'
import { type MainIpc, sendEnginePort, sendSshPrompt } from './ipc'
import {
  bundledEngine,
  ensureLocalEngine,
  makeLocalEngineDesk,
} from './local-engine'
import { AppPage } from './navigation'
import { makeFingerprintDesk, makePairings } from './pairing'
import { type BrokeredPage, localTarget, makeBroker } from './ports'
import { askpassNode, makePromptDesk } from './ssh-prompts'
import { makeAppState, safeStorageBox } from './state'
import { makeUpdateStatusCell } from './updateStatus'
import {
  UpdateChannel,
  type Updater,
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
import { launchDistro, reachWslEngine } from './wsl'

// Electron main's shared parts (spec §5), made once as the process starts, in the app's data folder
// set first: the window, its page and the connection process, to which it brokers each page's engine
// port, and a port to each known engine, and whose ssh prompts it asks the page (§9.1); the app's
// state with its known engines, the pairings with engines over TLS (§9.3), the local engine, started
// when none answers, at launch and before each connection the connection process makes to it (§7.1)
// and the engine in WSL2 (§7.6), and the update status. The features under ./features take them as
// `MainContext`, and index.ts starts them; only index.ts imports this module, the rest its types.

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
    given: Option.liftPredicate(
      app.commandLine.getSwitchValue(userDataSwitch),
      folder => folder !== '',
    ),
  }),
  folder => app.setPath('userData', folder),
)

/** The app's data folder, as set above. */
const userData = app.getPath('userData')

/** How long main waits before starting a connection process that exited again. */
const connectionRestartPause = 1_000

// The home folder as the engine the app starts and the CLI read it (node:os, which follows HOME), so all
// three find one socket, and one engine's copy: Electron's own on macOS ignores HOME.
const home = homedir()

const target = localTarget({
  platform: process.platform,
  home,
  environment: process.env,
})

const version = Schema.decodeUnknownSync(ReleaseVersion)(app.getVersion())

/**
 * The engine distribution the app bundles, run from its copy under the home folder the engine reads: a
 * packaged app's only; a development build starts none.
 */
const localEngine = {
  bundled: app.isPackaged
    ? Option.some(
        bundledEngine({
          resources: process.resourcesPath,
          version,
          home,
        }),
      )
    : Option.none(),
  env: process.env,
}

/** Starts the local engine where none answers, at launch and as the connection process asks. */
const localEngineDesk = makeLocalEngineDesk(
  ConnectionTarget.match(target, {
    LocalSocket: ({ path }) =>
      Effect.asVoid(ensureLocalEngine({ socket: path, ...localEngine })),
    Ssh: () => Effect.void,
    Wsl: () => Effect.void,
    Tls: () => Effect.void,
    Unavailable: () => Effect.void,
    Refused: () => Effect.void,
  }),
)

/** The local engine at launch; the connection reaches it once it answers, and says to the page why not. */
export const reachLocalEngine = localEngineDesk.reach.pipe(
  Effect.flatMap(
    LocalEngineReach.match({
      Reached: () => Effect.void,
      Failed: ({ reason }) => Effect.logWarning(`the local engine: ${reason}`),
    }),
  ),
)

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
    folder: userData,
    secrets: safeStorageBox(safeStorage, process.platform),
  }),
)

/** The app's engine in WSL2 at launch, where this machine runs none: the known one kept last. */
export const reachKnownWslEngine = appState.keptWslDistro.pipe(
  Effect.flatMap(kept =>
    Option.match(launchDistro({ local: target, kept }), {
      onNone: () => Effect.void,
      onSome: reachWsl,
    }),
  ),
  Effect.catch(error =>
    Effect.logWarning(`the known engines: ${error.reason}`),
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
    let running = true
    child.on('message', promptDesk.fromConnection)
    child.on('message', fingerprintDesk.fromConnection)
    // Each ask is answered to the connection process that asked, while it runs.
    child.on('message', message =>
      localEngineDesk.fromConnection(message, answer => {
        if (running) {
          child.postMessage(answer)
        }
      }),
    )
    child.once('exit', () => {
      running = false
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

const brokeredPage = (
  contents: WebContents,
): BrokeredPage<MessagePortMain> => ({
  onLoad: listener => contents.on('did-finish-load', listener),
  onGone: listener => contents.once('destroyed', listener),
  send: port => sendEnginePort(contents, port),
})

// The dev server only in a development build: a packaged app never loads a page from a variable.
const devServer = process.env['ELECTRON_RENDERER_URL']

/** The app's page: the renderer's files, or a development build's dev server. */
export const page: AppPage =
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
export const makeUpdater = (): Option.Option<Updater> =>
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

/** Opens `url` in the user's browser. */
export const openExternal = (url: string): void => {
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

/** `ipcMain`, each listener told the sending frame's URL. */
export const mainIpc: MainIpc = {
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

/** What the features act with: the shared parts above, and the Electron modules they use. */
export const context = {
  app,
  dialog,
  Notification,
  userData,
  version,
  target,
  localEngine,
  wslRunner,
  reachWsl,
  appState,
  promptDesk,
  broker,
  pairings,
  updateStatus,
  appWindow,
}

/** The main process's shared parts, as each feature takes them. */
export type MainContext = typeof context
