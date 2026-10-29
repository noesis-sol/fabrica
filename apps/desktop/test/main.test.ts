import { Option } from 'effect'
import { readFileSync } from 'node:fs'
import { MessageChannel } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'

import { FuseV1Options } from '@electron/fuses'
import { ServiceInstall } from '@fabrica/ui/host'

import { appFuses, packedElectron } from '../build/fuses'
import { type MainActions, type MainIpc, registerIpc } from '../src/main/ipc'
import {
  AppPage,
  NavigationDecision,
  decideNavigation,
  decideWindowOpen,
  isAppUrl,
} from '../src/main/navigation'
import { makeUpdateStatusCell } from '../src/main/updateStatus'
import {
  referenceSize,
  titleBarHeight,
  trafficLightPosition,
  windowOptions,
} from '../src/main/window'
import {
  FolderPick,
  type PreloadIpc,
  UpdateStatus,
  channels,
  forwardEnginePorts,
  makeApi,
} from '../src/preload/api'

// Electron main and the preload (spec §18.3, §20.1): the window and its title bar per platform, the
// navigation guard, the preload's API validated with Schema on both sides, and the fuses the
// packaged app is built with.

const filePage = AppPage.File({
  url: 'file:///Applications/Fabrica.app/Contents/Resources/app.asar/out/renderer/index.html',
})
const devPage = AppPage.DevServer({ url: 'http://localhost:5173/' })

describe('the navigation guard', () => {
  it('keeps the window on the app’s own page', () => {
    expect(decideNavigation(filePage, filePage.url)).toEqual(
      NavigationDecision.Stay(),
    )
    expect(decideNavigation(filePage, `${filePage.url}#/backlog`)).toEqual(
      NavigationDecision.Stay(),
    )
    expect(decideNavigation(devPage, 'http://localhost:5173/x?y=1')).toEqual(
      NavigationDecision.Stay(),
    )
  })

  it('opens a web page in the system browser', () => {
    expect(decideNavigation(filePage, 'https://example.com/a?b#c')).toEqual(
      NavigationDecision.OpenExternal({ url: 'https://example.com/a?b#c' }),
    )
    expect(decideNavigation(devPage, 'http://localhost:5174/')).toEqual(
      NavigationDecision.OpenExternal({ url: 'http://localhost:5174/' }),
    )
  })

  it('goes nowhere else', () => {
    for (const url of [
      'file:///etc/passwd',
      'file:///Applications/Fabrica.app/Contents/Resources/app.asar/out/renderer/other.html',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'about:blank',
      'vscode://file/etc/passwd',
      'ftp://example.com/',
      'https://user:secret@example.com/',
      'not a url',
      '',
    ]) {
      expect(decideNavigation(filePage, url)).toEqual(
        NavigationDecision.Refuse(),
      )
    }
  })

  it('opens no window of the app’s: a web page goes to the browser, nothing else anywhere', () => {
    expect(decideWindowOpen(filePage, filePage.url)).toEqual(
      NavigationDecision.Refuse(),
    )
    expect(decideWindowOpen(filePage, 'https://example.com/')).toEqual(
      NavigationDecision.OpenExternal({ url: 'https://example.com/' }),
    )
    expect(decideWindowOpen(filePage, 'file:///etc/passwd')).toEqual(
      NavigationDecision.Refuse(),
    )
  })

  it('trusts IPC only from the app’s page', () => {
    expect(isAppUrl(filePage, filePage.url)).toBe(true)
    expect(isAppUrl(filePage, 'https://example.com/')).toBe(false)
    expect(isAppUrl(devPage, 'http://localhost:5173/index.html')).toBe(true)
    expect(isAppUrl(devPage, 'http://127.0.0.1:5173/')).toBe(false)
  })
})

const colours = Option.some({
  background: '#101010',
  titleBar: '#202020',
  symbols: '#f0f0f0',
})

describe('the window', () => {
  it('opens at the handoff’s 1280 × 800, shown once painted, in the theme’s background', () => {
    const options = windowOptions({
      platform: 'darwin',
      colours,
      preload: '/p.cjs',
    })
    expect(referenceSize).toEqual({ width: 1280, height: 800 })
    expect(options).toMatchObject({
      width: 1280,
      height: 800,
      show: false,
      backgroundColor: '#101010',
    })
  })

  it('on macOS, has the traffic lights inset, centred on the 38px bar', () => {
    const options = windowOptions({
      platform: 'darwin',
      colours,
      preload: '/p.cjs',
    })
    expect(options.titleBarStyle).toBe('hiddenInset')
    expect(options.titleBarOverlay).toBeUndefined()
    expect(options.trafficLightPosition).toEqual(trafficLightPosition)
    expect(titleBarHeight).toBe(38)
    expect(trafficLightPosition.y * 2 + 14).toBe(titleBarHeight)
  })

  it('on Windows and Linux, has the system’s buttons on the bar, drawn on --side in --fg', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const options = windowOptions({ platform, colours, preload: '/p.cjs' })
      expect(options.titleBarStyle).toBe('hidden')
      expect(options.titleBarOverlay).toEqual({
        color: '#202020',
        symbolColor: '#f0f0f0',
        height: 38,
      })
      expect(options.trafficLightPosition).toBeUndefined()
    }
    expect(
      windowOptions({
        platform: 'linux',
        colours: Option.none(),
        preload: '/p.cjs',
      }).titleBarOverlay,
    ).toEqual({ height: 38 })
  })

  it('isolates and sandboxes its page, with no Node, no webview and web security on', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(
        windowOptions({ platform, colours, preload: '/p.cjs' }).webPreferences,
      ).toMatchObject({
        preload: '/p.cjs',
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
      })
    }
  })
})

/** A stand-in ipcRenderer: what was sent, main's answers, and messages to deliver. */
const fakeRendererIpc = (answers: Record<string, unknown>) => {
  const sent: Array<ReadonlyArray<unknown>> = []
  const listeners = new Map<
    string,
    Set<(value: unknown, ports: ReadonlyArray<unknown>) => void>
  >()
  const ipc: PreloadIpc = {
    send: (channel, ...values) => sent.push([channel, ...values]),
    invoke: (channel, ...values) => {
      sent.push([channel, ...values])
      return Promise.resolve(answers[channel])
    },
    on: (channel, listener) => {
      const forChannel = listeners.get(channel) ?? new Set()
      forChannel.add(listener)
      listeners.set(channel, forChannel)
      return () => {
        forChannel.delete(listener)
      }
    },
  }
  const deliver = (
    channel: string,
    value: unknown,
    ports: ReadonlyArray<unknown> = [],
  ) => {
    for (const listener of listeners.get(channel) ?? []) {
      listener(value, ports)
    }
  }
  return { ipc, sent, deliver }
}

describe('the preload’s API', () => {
  it('sends the window controls, and a theme only when it is one', () => {
    const { ipc, sent } = fakeRendererIpc({})
    const api = makeApi(ipc)
    api.window.minimize()
    api.window.toggleMaximize()
    api.window.close()
    api.window.setTheme('classic')
    // The page is untrusted: what it passes is checked whatever its types say.
    const setTheme = (theme: unknown) =>
      Reflect.apply(api.window.setTheme, undefined, [theme])
    expect(() => setTheme('solarized')).toThrow()
    expect(() => setTheme({ toString: () => 'classic' })).toThrow()
    expect(sent).toEqual([
      [channels.minimize],
      [channels.toggleMaximize],
      [channels.close],
      [channels.setTheme, 'classic'],
    ])
  })

  it('gives the page main’s answers once they decode, and rejects those that don’t', async () => {
    const good = makeApi(
      fakeRendererIpc({
        [channels.pickFolder]: { _tag: 'Picked', path: '/Users/me/repo' },
        [channels.version]: '1.2.3',
        [channels.updateStatus]: {
          _tag: 'Downloading',
          version: '1.3.0',
          percent: 40,
        },
      }).ipc,
    )
    expect(await good.pickFolder()).toEqual(
      FolderPick.cases.Picked.make({ path: '/Users/me/repo' }),
    )
    expect(await good.version()).toBe('1.2.3')
    expect(await good.updateStatus()).toEqual(
      UpdateStatus.cases.Downloading.make({ version: '1.3.0', percent: 40 }),
    )

    const bad = makeApi(
      fakeRendererIpc({
        [channels.pickFolder]: { _tag: 'Picked', path: '' },
        [channels.version]: 'one',
        [channels.updateStatus]: {
          _tag: 'Downloading',
          version: '1.3.0',
          percent: 140,
        },
      }).ipc,
    )
    await expect(bad.pickFolder()).rejects.toThrow()
    await expect(bad.version()).rejects.toThrow()
    await expect(bad.updateStatus()).rejects.toThrow()
  })

  it('passes on each update status that decodes, until stopped', () => {
    const { ipc, deliver } = fakeRendererIpc({})
    const seen: Array<UpdateStatus> = []
    const stop = makeApi(ipc).onUpdateStatus(status => seen.push(status))
    deliver(channels.updateStatusChanged, { _tag: 'Checking' })
    deliver(channels.updateStatusChanged, { _tag: 'Exploded' })
    deliver(channels.updateStatusChanged, { _tag: 'Ready', version: '2.0.0' })
    stop()
    deliver(channels.updateStatusChanged, { _tag: 'UpToDate' })
    expect(seen).toEqual([
      UpdateStatus.cases.Checking.make({}),
      UpdateStatus.cases.Ready.make({ version: '2.0.0' }),
    ])
  })

  it('hands the page the engine port as a fabrica:engine-port message, and nothing else', () => {
    const { ipc, deliver } = fakeRendererIpc({})
    const posted: Array<[unknown, ReadonlyArray<unknown>]> = []
    forwardEnginePorts(ipc, (message, ports) => posted.push([message, ports]))
    const { port1, port2 } = new MessageChannel()
    deliver(channels.enginePort, null, [])
    deliver(channels.enginePort, null, [port1, port2])
    deliver(channels.enginePort, null, ['not a port'])
    deliver(channels.enginePort, null, [port1])
    expect(posted).toEqual([[{ type: 'fabrica:engine-port' }, [port1]]])
    port1.close()
    port2.close()
  })
})

/** A stand-in ipcMain: send a message or a request as a frame at a URL. */
const fakeMainIpc = () => {
  const listeners = new Map<
    string,
    (sender: string | undefined, values: ReadonlyArray<unknown>) => void
  >()
  const handlers = new Map<
    string,
    (
      sender: string | undefined,
      values: ReadonlyArray<unknown>,
    ) => Promise<unknown>
  >()
  const ipc: MainIpc = {
    on: (channel, listener) => listeners.set(channel, listener),
    handle: (channel, handler) => handlers.set(channel, handler),
  }
  return {
    ipc,
    send: (
      channel: string,
      sender: string | undefined,
      ...values: Array<unknown>
    ) => listeners.get(channel)?.(sender, values),
    invoke: (
      channel: string,
      sender: string | undefined,
      ...values: Array<unknown>
    ) =>
      handlers.get(channel)?.(sender, values) ??
      Promise.reject(new Error(`no handler for ${channel}`)),
  }
}

const recordingActions = () => {
  const done: Array<string> = []
  const actions: MainActions = {
    minimize: () => done.push('minimize'),
    toggleMaximize: () => done.push('toggleMaximize'),
    close: () => done.push('close'),
    setTheme: theme => done.push(`setTheme ${theme}`),
    notify: ({ title }) => done.push(`notify ${title}`),
    pickFolder: () =>
      Promise.resolve(FolderPick.cases.Picked.make({ path: '/repo' })),
    version: '1.0.0',
    updateStatus: () => UpdateStatus.cases.Unavailable.make({}),
    installLoginService: () =>
      Promise.resolve(ServiceInstall.cases.Installed.make({})),
    checkEngine: () =>
      Promise.reject(new Error('the engine install’s tests answer it')),
    installEngine: () =>
      Promise.reject(new Error('the engine install’s tests answer it')),
    answerSshPrompt: ({ id }) => done.push(`answerSshPrompt ${id}`),
  }
  return { done, actions }
}

describe('main’s end of the API', () => {
  const app = 'file:///app/index.html'
  const setUp = () => {
    const fake = fakeMainIpc()
    const { done, actions } = recordingActions()
    registerIpc({ ipc: fake.ipc, trusted: url => url === app, actions })
    return { ...fake, done }
  }

  it('acts on what the app’s page sends, decoded again', () => {
    const { send, done } = setUp()
    send(channels.minimize, app)
    send(channels.toggleMaximize, app)
    send(channels.setTheme, app, 'neon-grid')
    send(channels.close, app)
    expect(done).toEqual([
      'minimize',
      'toggleMaximize',
      'setTheme neon-grid',
      'close',
    ])
  })

  it('drops a message from another page, a frame gone, or with values its channel doesn’t take', () => {
    const { send, done } = setUp()
    send(channels.minimize, 'https://example.com/')
    send(channels.close, undefined)
    send(channels.minimize, app, 'extra')
    send(channels.setTheme, app, 'solarized')
    send(channels.setTheme, app)
    send(channels.setTheme, app, 'classic', 'extra')
    expect(done).toEqual([])
  })

  it('answers the app’s page, and refuses another page or a request with values', async () => {
    const { invoke } = setUp()
    expect(await invoke(channels.pickFolder, app)).toEqual(
      FolderPick.cases.Picked.make({ path: '/repo' }),
    )
    expect(await invoke(channels.version, app)).toBe('1.0.0')
    expect(await invoke(channels.updateStatus, app)).toEqual(
      UpdateStatus.cases.Unavailable.make({}),
    )
    await expect(
      invoke(channels.pickFolder, 'https://example.com/'),
    ).rejects.toThrow(/refused/)
    await expect(invoke(channels.version, app, 'x')).rejects.toThrow(/refused/)
  })
})

describe('the page’s Content Security Policy', () => {
  const html = readFileSync(
    new URL('../src/renderer/index.html', import.meta.url),
    'utf8',
  )
  const policy = new Map(
    (
      /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(
        html,
      )?.[1] ?? ''
    )
      .split(';')
      .map(directive => directive.trim().split(/\s+/))
      .map(([name = '', ...sources]) => [name, sources] as const),
  )

  it('loads only the bundled assets, with no eval and no plug-ins, frames or forms', () => {
    expect(policy.get('default-src')).toEqual(["'self'"])
    expect(policy.get('script-src')).toEqual(["'self'"])
    expect(policy.get('object-src')).toEqual(["'none'"])
    expect(policy.get('frame-src')).toEqual(["'none'"])
    expect(policy.get('base-uri')).toEqual(["'none'"])
    expect(policy.get('form-action')).toEqual(["'none'"])
    for (const sources of policy.values()) {
      for (const source of sources) {
        expect(source).toMatch(/^(?:'self'|'none'|'unsafe-inline'|data:)$/)
      }
    }
    expect(policy.get('style-src')).toContain("'unsafe-inline'")
    expect(
      [...policy.entries()]
        .filter(([, sources]) => sources.includes("'unsafe-inline'"))
        .map(([name]) => name),
    ).toEqual(['style-src'])
  })
})

describe('the update status', () => {
  it('holds the last status set and tells each listener until it stops', () => {
    const cell = makeUpdateStatusCell(UpdateStatus.cases.Unavailable.make({}))
    const seen: Array<UpdateStatus> = []
    const stop = cell.subscribe(status => seen.push(status))
    cell.set(UpdateStatus.cases.Checking.make({}))
    stop()
    cell.set(UpdateStatus.cases.UpToDate.make({}))
    expect(seen).toEqual([UpdateStatus.cases.Checking.make({})])
    expect(cell.get()).toEqual(UpdateStatus.cases.UpToDate.make({}))
  })
})

describe('the fuses', () => {
  it('turn RunAsNode off, cookie encryption and asar-only loading on, everywhere', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const fuses = appFuses(platform)
      expect(fuses.strictlyRequireAllFuses).toBe(true)
      expect(fuses[FuseV1Options.RunAsNode]).toBe(false)
      expect(fuses[FuseV1Options.EnableCookieEncryption]).toBe(true)
      expect(fuses[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true)
      // Playwright drives the packaged app through the inspector's flags.
      expect(fuses[FuseV1Options.EnableNodeCliInspectArguments]).toBe(true)
    }
  })

  it('check the asar’s integrity on macOS and Windows, where Electron can (fab-a39)', () => {
    expect(
      appFuses('darwin')[FuseV1Options.EnableEmbeddedAsarIntegrityValidation],
    ).toBe(true)
    expect(
      appFuses('win32')[FuseV1Options.EnableEmbeddedAsarIntegrityValidation],
    ).toBe(true)
    expect(
      appFuses('linux')[FuseV1Options.EnableEmbeddedAsarIntegrityValidation],
    ).toBe(false)
  })

  it('are flipped in each platform’s packed Electron binary', () => {
    const packed = (electronPlatformName: string) => ({
      appOutDir: '/out',
      electronPlatformName,
      packager: {
        appInfo: { productFilename: 'Fabrica' },
        executableName: 'fabrica',
      },
    })
    expect(packedElectron(packed('darwin'))).toBe('/out/Fabrica.app')
    expect(packedElectron(packed('win32'))).toBe('/out/Fabrica.exe')
    expect(packedElectron(packed('linux'))).toBe('/out/fabrica')
    expect(() => packedElectron(packed('mas'))).toThrow()
  })
})
