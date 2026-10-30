import { Effect, Option } from 'effect'
import { readFile, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { describe, expect, it, layer } from '@effect/vitest'
import {
  EngineHost,
  InstallAnswer,
  InstallConsent,
  UbuntuInstall,
  WslSearch,
  installedDistro,
} from '@fabrica/client'
import { DistributionSource } from '@fabrica/client/install'
import { RELEASE_KEYS } from '@fabrica/engine/update'
import { Toolbox, layerToolbox, shStub, tempFolder } from '@fabrica/testkit'

import { ConnectionTarget } from '../src/connection/target'
import {
  checkEngineOn,
  installEngineOn,
  loginServiceOn,
} from '../src/main/engine-install'
import { addEngineChannels } from '../src/main/features/add-engine'
import { makeIpcRegistrar } from '../src/main/ipc'
import {
  type BrokeredPage,
  type ConnectionProcess,
  makeBroker,
} from '../src/main/ports'
import { launchDistro } from '../src/main/wsl'
import { type PreloadIpc, channels, makeApi } from '../src/preload/api'

// Adding and reaching an engine in WSL2 from the Windows app (spec §7.6, H31): the search for a
// distribution and Ubuntu's install asked through the preload and main, their answers decoded on the
// way; the engine checked and installed in the distribution through `wsl.exe -d <distro> --exec`, its
// login service only where systemd runs there; and the engine the app reaches, the known one in WSL2
// kept last at launch where this machine runs none, and the one Add engine installed, every page given a
// new port to it.

const found = WslSearch.cases.Found.make({ distro: 'Ubuntu' })
const ready = UbuntuInstall.cases.Ready.make({ distro: 'Ubuntu' })
const ubuntu = EngineHost.cases.Wsl.make({ distro: 'Ubuntu' })
const consent = InstallConsent.cases.Install.make({ to: '1.2.0' })
const installed = InstallAnswer.cases.Installed.make({
  installed: {
    version: '1.2.0',
    launcher: '/home/me/.local/share/fabrica/engine/1.2.0/bin/fabrica',
    service: 'installed the systemd user unit fabrica.service',
  },
})

describe('the preload’s WSL2 search and Ubuntu install', () => {
  const rendererIpc = (answers: Readonly<Record<string, unknown>>) => {
    const asked: Array<ReadonlyArray<unknown>> = []
    const ipc: PreloadIpc = {
      send: () => undefined,
      invoke: (channel, ...values) => {
        asked.push([channel, ...values])
        return Promise.resolve(answers[channel])
      },
      on: () => () => undefined,
    }
    return { ipc, asked }
  }

  it('asks main, and gives the page main’s answers', async () => {
    const { ipc, asked } = rendererIpc({
      [channels.findWsl]: found,
      [channels.installUbuntu]: ready,
    })
    const api = makeApi(ipc)
    expect(await api.findWsl()).toEqual(found)
    expect(await api.installUbuntu()).toEqual(ready)
    expect(asked).toEqual([[channels.findWsl], [channels.installUbuntu]])
  })

  it('rejects an answer that doesn’t decode, and a distribution wsl.exe would read as an option', async () => {
    const { ipc, asked } = rendererIpc({
      [channels.findWsl]: { _tag: 'Found', distro: '--exec' },
      [channels.installUbuntu]: { _tag: 'Ready' },
    })
    const api = makeApi(ipc)
    await expect(api.findWsl()).rejects.toThrow()
    await expect(api.installUbuntu()).rejects.toThrow()
    await expect(
      Reflect.apply(api.checkEngine, undefined, [
        { _tag: 'Wsl', distro: '--exec' },
      ]),
    ).rejects.toThrow()
    expect(asked).toEqual([[channels.findWsl], [channels.installUbuntu]])
  })
})

describe('main’s WSL2 search and Ubuntu install', () => {
  const app = 'file:///app/index.html'
  const setUp = () => {
    const handlers = new Map<
      string,
      (
        sender: string | undefined,
        values: ReadonlyArray<unknown>,
      ) => Promise<unknown>
    >()
    const asked: Array<string> = []
    const unused = () => Promise.reject(new Error('not this test’s'))
    addEngineChannels(
      makeIpcRegistrar({
        ipc: {
          on: () => undefined,
          handle: (channel, handler) => handlers.set(channel, handler),
        },
        trusted: url => url === app,
      }),
      {
        checkEngine: host => {
          asked.push(`check ${host._tag}`)
          return Promise.resolve({ _tag: 'Failed', reason: 'not this test’s' })
        },
        installEngine: unused,
        findWsl: () => {
          asked.push('find')
          return Promise.resolve(found)
        },
        installUbuntu: () => {
          asked.push('install Ubuntu')
          return Promise.resolve(ready)
        },
      },
    )
    const invoke = (
      channel: string,
      sender: string | undefined,
      ...values: Array<unknown>
    ) =>
      handlers.get(channel)?.(sender, values) ??
      Promise.reject(new Error(`no handler for ${channel}`))
    return { invoke, asked }
  }

  it('answers the app’s page, and checks a distribution as a host', async () => {
    const { invoke, asked } = setUp()
    expect(await invoke(channels.findWsl, app)).toEqual(found)
    expect(await invoke(channels.installUbuntu, app)).toEqual(ready)
    await invoke(channels.checkEngine, app, ubuntu)
    expect(asked).toEqual(['find', 'install Ubuntu', 'check Wsl'])
  })

  it('refuses another page, a frame gone, values it takes none of, and a distribution that is an option', async () => {
    const { invoke, asked } = setUp()
    const refused = [
      invoke(channels.findWsl, 'https://example.com/'),
      invoke(channels.findWsl, undefined),
      invoke(channels.findWsl, app, 'Ubuntu'),
      invoke(channels.installUbuntu, 'https://example.com/'),
      invoke(channels.installUbuntu, app, 'Debian'),
      invoke(channels.checkEngine, app, { _tag: 'Wsl', distro: '-d' }),
    ]
    for (const request of refused) {
      await expect(request).rejects.toThrow(/refused/)
    }
    expect(asked).toEqual([])
  })
})

describe('the engine the app reaches in WSL2', () => {
  const unavailable = ConnectionTarget.cases.Unavailable.make({
    reason: 'no local engine on Windows',
  })
  const socket = ConnectionTarget.cases.LocalSocket.make({
    path: '/home/ada/.local/share/fabrica/engine.sock',
  })

  it('is at launch the known one in WSL2 kept last, only where this machine runs no engine', () => {
    expect(
      launchDistro({ local: unavailable, kept: Option.some('Debian') }),
    ).toEqual(Option.some('Debian'))
    expect(launchDistro({ local: unavailable, kept: Option.none() })).toEqual(
      Option.none(),
    )
    expect(
      launchDistro({ local: socket, kept: Option.some('Debian') }),
    ).toEqual(Option.none())
  })

  it('is the one Add engine installed in a distribution, and no other host’s', () => {
    expect(installedDistro({ host: ubuntu, answer: installed })).toEqual(
      Option.some('Ubuntu'),
    )
    expect(
      installedDistro({
        host: ubuntu,
        answer: InstallAnswer.cases.Failed.make({ reason: 'no space left' }),
      }),
    ).toEqual(Option.none())
    expect(
      installedDistro({
        host: EngineHost.cases.Ssh.make({ destination: 'me@server-1' }),
        answer: installed,
      }),
    ).toEqual(Option.none())
  })

  it('is reached by every page through a new port once the app retargets, and by every page loaded after', () => {
    let pairs = 0
    const relayed: Array<[ConnectionTarget, string]> = []
    const broker = makeBroker<string>({
      spawn: () => {
        const child: ConnectionProcess<string> = {
          relay: (to, port) => relayed.push([to, port]),
          post: () => undefined,
        }
        return child
      },
      afterExit: () => undefined,
      channel: () => {
        pairs += 1
        return { page: `page-${pairs}`, relay: `relay-${pairs}` }
      },
      target: unavailable,
    })
    const loads: Array<() => void> = []
    const gone: Array<() => void> = []
    const received: Array<string> = []
    const page: BrokeredPage<string> = {
      onLoad: listener => loads.push(listener),
      onGone: listener => gone.push(listener),
      send: port => received.push(port),
    }
    broker.attach(page)
    loads.forEach(load => load())
    const wsl = ConnectionTarget.cases.Wsl.make({ distro: 'Ubuntu' })
    broker.retarget(wsl)
    loads.forEach(load => load())
    gone.forEach(go => go())
    broker.retarget(unavailable)
    expect(received).toEqual(['page-1', 'page-2', 'page-3'])
    expect(relayed).toEqual([
      [unavailable, 'relay-1'],
      [wsl, 'relay-2'],
      [wsl, 'relay-3'],
    ])
  })
})

describe('the engine’s login service', () => {
  it('runs on every host, but in WSL2 only where the distribution’s systemd runs', () => {
    expect(loginServiceOn(EngineHost.cases.Local.make({}))).toBe('always')
    expect(
      loginServiceOn(EngineHost.cases.Ssh.make({ destination: 'me@server-1' })),
    ).toBe('always')
    expect(loginServiceOn(ubuntu)).toBe('where-systemd-runs')
  })
})

/** The stub wsl.exe logs its arguments and the UTF-8 switch, and finds no uname in the distribution. */
const toolbox = layerToolbox({
  stubs: {
    'wsl.exe': shStub(
      [
        `printf 'wsl.exe %s %s\\n' "\${WSL_UTF8:-}" "$*" >> "$STUB_LOG"`,
        "echo 'uname: not found' >&2",
        'exit 127',
      ].join('\n'),
    ),
  },
})

layer(toolbox)('the install’s steps in a WSL2 distribution', it => {
  it.effect(
    'run through wsl.exe in the distribution, in UTF-8, and say why they failed',
    () =>
      Effect.gen(function* () {
        const tools = yield* Toolbox
        const log = NodePath.join(yield* tempFolder('wsl-engine'), 'runs.log')
        yield* Effect.promise(() => writeFile(log, ''))
        const env = tools.env({ STUB_LOG: log })
        const source = DistributionSource.Folder({
          folder: '/nowhere',
          keys: RELEASE_KEYS,
        })
        const check = yield* checkEngineOn({ host: ubuntu, source, env })
        const install = yield* installEngineOn({
          host: ubuntu,
          consent,
          source,
          env,
        })
        for (const answer of [check, install]) {
          expect(answer).toMatchObject({ _tag: 'Failed' })
        }
        const ran = yield* Effect.promise(() => readFile(log, 'utf8'))
        const runs = ran.split('\n').filter(line => line !== '')
        expect(runs).toHaveLength(2)
        for (const run of runs) {
          expect(run).toMatch(/^wsl\.exe 1 -d Ubuntu --exec sh /)
        }
      }),
  )
})
