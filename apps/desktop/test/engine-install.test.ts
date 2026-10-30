import { Effect, Option } from 'effect'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { describe, expect, it, layer } from '@effect/vitest'
import {
  CheckAnswer,
  EngineHost,
  InstallAnswer,
  InstallConsent,
} from '@fabrica/client'
import { DistributionSource } from '@fabrica/client/install'
import { RELEASES, RELEASE_KEYS } from '@fabrica/engine/update'
import { Toolbox, layerToolbox, shStub, tempFolder } from '@fabrica/testkit'

import {
  checkEngineOn,
  engineSource,
  installEngineOn,
} from '../src/main/engine-install'
import { type MainActions, registerIpc } from '../src/main/ipc'
import { type PreloadIpc, channels, makeApi } from '../src/preload/api'

// Add engine and the update offer at connect, through the preload and main (spec §9.2, §20.1): the
// page's host and consent decoded by the preload and again by main, the answers decoded before the page
// sees them; where the engine comes from (the packaged app's signed release folder, else Fabrica's
// releases); and the install's steps run on the host's shell, ssh to its destination asking nothing, or
// this machine's, against a stub `ssh` that refuses the key and a stub `sh` that can't tell the system.

const server = EngineHost.cases.Ssh.make({ destination: 'me@server-1' })
const local = EngineHost.cases.Local.make({})
const consent = InstallConsent.cases.Install.make({ to: '1.2.0' })
const checked = CheckAnswer.cases.Checked.make({
  check: {
    host: 'Linux x86_64, glibc 2.39',
    target: 'linux-x64',
    plan: { _tag: 'Install', to: '1.2.0' },
    notes: [],
  },
})
const installed = InstallAnswer.cases.Installed.make({
  installed: {
    version: '1.2.0',
    launcher: '/home/me/.local/share/fabrica/engine/1.2.0/bin/fabrica',
    service: 'installed the systemd user unit fabrica.service',
  },
})

/** A stand-in ipcRenderer answering each channel's request with `answers`', recording what it is asked. */
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

/** The page's call, made with what its types don't allow: the page is untrusted. */
const callWith = (
  method: (...args: never) => Promise<unknown>,
  args: ReadonlyArray<unknown>,
): Promise<unknown> => Reflect.apply(method, undefined, args)

describe('the preload’s engine install', () => {
  it('asks main to check or install with the host and consent, and gives the page main’s answers', async () => {
    const { ipc, asked } = rendererIpc({
      [channels.checkEngine]: checked,
      [channels.installEngine]: installed,
    })
    const api = makeApi(ipc)
    expect(await api.checkEngine(server)).toEqual(checked)
    expect(await api.installEngine(local, consent)).toEqual(installed)
    expect(asked).toEqual([
      [channels.checkEngine, server],
      [channels.installEngine, local, consent],
    ])
  })

  it('rejects a host or consent that doesn’t decode without asking main, and an answer that doesn’t', async () => {
    const { ipc, asked } = rendererIpc({
      [channels.checkEngine]: { _tag: 'Checked', check: {} },
      [channels.installEngine]: { _tag: 'Installed' },
    })
    const api = makeApi(ipc)
    await expect(
      callWith(api.checkEngine, [
        { _tag: 'Ssh', destination: '-oProxyCommand=evil' },
      ]),
    ).rejects.toThrow()
    await expect(
      callWith(api.installEngine, [server, { _tag: 'Update', to: '1.2.0' }]),
    ).rejects.toThrow()
    expect(asked).toEqual([])
    await expect(api.checkEngine(server)).rejects.toThrow()
    await expect(api.installEngine(server, consent)).rejects.toThrow()
  })
})

describe('main’s engine install', () => {
  const app = 'file:///app/index.html'
  const setUp = () => {
    const handlers = new Map<
      string,
      (
        sender: string | undefined,
        values: ReadonlyArray<unknown>,
      ) => Promise<unknown>
    >()
    const asked: Array<unknown> = []
    const unused = () => Promise.reject(new Error('not this test’s'))
    const actions: MainActions = {
      minimize: () => undefined,
      toggleMaximize: () => undefined,
      close: () => undefined,
      setTheme: () => undefined,
      notify: () => undefined,
      pickFolder: unused,
      version: '1.0.0',
      updateStatus: () => ({ _tag: 'Unavailable' }),
      installLoginService: unused,
      answerSshPrompt: () => undefined,
      checkEngine: host => {
        asked.push(host)
        return Promise.resolve(checked)
      },
      installEngine: request => {
        asked.push(request)
        return Promise.resolve(installed)
      },
      findWsl: unused,
      installUbuntu: unused,
    }
    registerIpc({
      ipc: {
        on: () => undefined,
        handle: (channel, handler) => handlers.set(channel, handler),
      },
      trusted: url => url === app,
      actions,
    })
    const invoke = (
      channel: string,
      sender: string | undefined,
      ...values: Array<unknown>
    ) =>
      handlers.get(channel)?.(sender, values) ??
      Promise.reject(new Error(`no handler for ${channel}`))
    return { invoke, asked }
  }

  it('checks and installs as the app’s page asks, its host and consent decoded again', async () => {
    const { invoke, asked } = setUp()
    expect(await invoke(channels.checkEngine, app, server)).toEqual(checked)
    expect(await invoke(channels.installEngine, app, local, consent)).toEqual(
      installed,
    )
    expect(asked).toEqual([server, { host: local, consent }])
  })

  it('refuses another page, a frame gone, and a host or consent that doesn’t decode', async () => {
    const { invoke, asked } = setUp()
    const refused = [
      invoke(channels.checkEngine, 'https://example.com/', server),
      invoke(channels.checkEngine, undefined, server),
      invoke(channels.checkEngine, app),
      invoke(channels.checkEngine, app, server, consent),
      invoke(channels.checkEngine, app, {
        _tag: 'Ssh',
        destination: '-oProxyCommand=evil',
      }),
      invoke(channels.installEngine, app, server),
      invoke(channels.installEngine, app, server, { _tag: 'Current' }),
      invoke(channels.installEngine, 'https://example.com/', server, consent),
    ]
    for (const request of refused) {
      await expect(request).rejects.toThrow(/refused/)
    }
    expect(asked).toEqual([])
  })
})

describe('where the engine comes from', () => {
  it.effect(
    'is the packaged app’s release folder where it holds checksums.txt and its signature',
    () =>
      Effect.gen(function* () {
        const resources = yield* tempFolder('resources')
        const folder = NodePath.join(resources, 'engine-release')
        yield* Effect.promise(async () => {
          await mkdir(folder)
          await writeFile(NodePath.join(folder, 'checksums.txt'), '')
          await writeFile(NodePath.join(folder, 'checksums.txt.sig'), '')
        })
        expect(
          yield* engineSource({
            resources: Option.some(resources),
            stage: '/tmp',
            release: Option.some('1.2.0'),
          }),
        ).toEqual(DistributionSource.Folder({ folder, keys: RELEASE_KEYS }))
      }),
  )

  it.effect(
    'is Fabrica’s releases, staged in the app’s temp folder, where the folder isn’t signed or there is none',
    () =>
      Effect.gen(function* () {
        const resources = yield* tempFolder('resources')
        const folder = NodePath.join(resources, 'engine-release')
        yield* Effect.promise(async () => {
          await mkdir(folder)
          await writeFile(NodePath.join(folder, 'checksums.txt'), '')
        })
        const releases = (release: Option.Option<'1.2.0'>) =>
          DistributionSource.Releases({
            releases: RELEASES,
            keys: RELEASE_KEYS,
            release,
            stage: '/tmp',
          })
        expect(
          yield* engineSource({
            resources: Option.some(resources),
            stage: '/tmp',
            release: Option.some('1.2.0'),
          }),
        ).toEqual(releases(Option.some('1.2.0')))
        expect(
          yield* engineSource({
            resources: Option.none(),
            stage: '/tmp',
            release: Option.none(),
          }),
        ).toEqual(releases(Option.none()))
      }),
  )
})

/**
 * The stub ssh says it is OpenSSH 9.6 to `-V`, else logs its arguments and refuses the key; the stub sh
 * logs its own and can't tell the system.
 */
const toolbox = layerToolbox({
  stubs: {
    ssh: shStub(
      [
        'if [ "$1" = "-V" ]; then echo "OpenSSH_9.6p1, OpenSSL 3.0.13" >&2; exit 0; fi',
        `printf 'ssh %s\\n' "$*" >> "$STUB_LOG"`,
        "echo 'me@server-1: Permission denied (publickey).' >&2",
        'exit 255',
      ].join('\n'),
    ),
    sh: shStub(
      [
        `printf 'sh %s\\n' "$*" >> "$STUB_LOG"`,
        "echo 'uname: not found' >&2",
        'exit 127',
      ].join('\n'),
    ),
  },
})

layer(toolbox)('the install’s steps on the host', it => {
  const setUp = Effect.gen(function* () {
    const tools = yield* Toolbox
    const log = NodePath.join(yield* tempFolder('engine-install'), 'runs.log')
    yield* Effect.promise(() => writeFile(log, ''))
    return {
      env: tools.env({ STUB_LOG: log }),
      runs: Effect.map(
        Effect.promise(() => readFile(log, 'utf8')),
        text => text.split('\n').filter(line => line !== ''),
      ),
    }
  })
  const source = DistributionSource.Folder({
    folder: '/nowhere',
    keys: RELEASE_KEYS,
  })

  it.effect(
    'reach an SSH host through ssh to its destination, asking nothing, and say why it refused',
    () =>
      Effect.gen(function* () {
        const { env, runs } = yield* setUp
        const check = yield* checkEngineOn({ host: server, source, env })
        const install = yield* installEngineOn({
          host: server,
          consent,
          source,
          env,
        })
        for (const answer of [check, install]) {
          expect(answer).toMatchObject({ _tag: 'Failed' })
          expect(Reflect.get(answer, 'reason')).toMatch(/me@server-1/)
        }
        const ran = yield* runs
        expect(ran).toHaveLength(2)
        for (const run of ran) {
          expect(run).toMatch(/^ssh .*-o BatchMode=yes -- me@server-1 /)
        }
      }),
  )

  it.effect(
    'run this machine’s steps here, with the user’s environment, and say why they failed',
    () =>
      Effect.gen(function* () {
        const { env, runs } = yield* setUp
        const check = yield* checkEngineOn({ host: local, source, env })
        expect(check).toMatchObject({ _tag: 'Failed' })
        const ran = yield* runs
        expect(ran).toEqual([expect.stringMatching(/^sh -s --/)])
      }),
  )
})
