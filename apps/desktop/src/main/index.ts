import { Option, Schema } from 'effect'
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
  dialog,
  ipcMain,
  session,
  shell,
  utilityProcess,
} from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { ReleaseVersion } from '@fabrica/contracts'
import { type Theme, defaultTheme } from '@fabrica/ui/theme'
import { windowColours } from '@fabrica/ui/window-colours'

import { FolderPick, UpdateStatus, channels } from '../preload/api'
import { type MainIpc, registerIpc, sendEnginePort } from './ipc'
import { AppPage, isAppUrl } from './navigation'
import { makeNotifications } from './notifications'
import { type BrokeredPage, localTarget, makeBroker } from './ports'
import { guardPermissions, guardWebContents } from './security'
import { makeUpdateStatusCell } from './updateStatus'
import { titleBarOverlay, windowOptions } from './window'

// Electron main (spec §5): the window, its title bar and its confinement, the preload's API, and the
// connection process, to which it brokers each page's engine port. It runs no orchestration and stays
// out of the data path.

const preload = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))
const connectionProcess = fileURLToPath(
  new URL('./connection.js', import.meta.url),
)

/** How long main waits before starting a connection process that exited again. */
const connectionRestartPause = 1_000

const broker = makeBroker<MessagePortMain>({
  spawn: onExit => {
    const child = utilityProcess.fork(connectionProcess)
    child.once('exit', onExit)
    return { relay: (target, port) => child.postMessage(target, [port]) }
  },
  afterExit: restart => {
    setTimeout(restart, connectionRestartPause)
  },
  channel: () => {
    const { port1, port2 } = new MessageChannelMain()
    return { page: port1, relay: port2 }
  },
  target: localTarget({
    platform: process.platform,
    home: app.getPath('home'),
    environment: process.env,
  }),
})

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

const version = Schema.decodeUnknownSync(ReleaseVersion)(app.getVersion())
const updateStatus = makeUpdateStatusCell(
  UpdateStatus.cases.Unavailable.make({}),
)

const openExternal = (url: string): void => {
  void shell.openExternal(url)
}

/** The app's one window: made when first shown, again after it closes (macOS keeps the app). */
const makeAppWindow = () => {
  let current: BrowserWindow | undefined
  let theme: Theme = defaultTheme

  const create = (): BrowserWindow => {
    const window = new BrowserWindow(
      windowOptions({
        platform: process.platform,
        colours: windowColours(theme),
        preload,
      }),
    )
    window.once('ready-to-show', () => window.show())
    broker.attach(brokeredPage(window.webContents))
    const stopUpdates = updateStatus.subscribe(status =>
      window.webContents.send(channels.updateStatusChanged, status),
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
        current.focus()
      }
    },
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
      setTheme: appWindow.setTheme,
      notify: notifications.notify,
      pickFolder,
      version,
      updateStatus: updateStatus.get,
    },
  })

  void app.whenReady().then(() => {
    guardPermissions(session.defaultSession)
    appWindow.show()
    app.on('activate', appWindow.show)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
