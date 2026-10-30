import { Effect, Option } from 'effect'
import { writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import {
  EngineAddress,
  KeepAnswer,
  KnownEngine,
  KnownEnginesAnswer,
} from '@fabrica/client'
import { EngineId } from '@fabrica/contracts'
import { tempFolder } from '@fabrica/testkit'
import { appHostOf } from '@fabrica/ui/host'
import {
  type EnginePortRequest,
  remoteEnginePortMessage,
} from '@fabrica/ui/port'

import { ConnectionTarget } from '../src/connection/target'
import { type MainActions, registerIpc } from '../src/main/ipc'
import { keepEngineIn, knownEnginesOf } from '../src/main/known-engines'
import {
  type ConnectionProcess,
  knownTarget,
  makeBroker,
} from '../src/main/ports'
import { type SecretBox, makeAppState, stateFileName } from '../src/main/state'
import {
  type PreloadIpc,
  channels,
  forwardRemoteEnginePorts,
  makeApi,
} from '../src/preload/api'

// The engines the app knows (spec §9.1), through the preload and main: the page reads them from the
// app's state, has one kept once it reached it, and asks for a port to each, which main relays to the
// engine's target through the connection process and hands back with the request's number; what
// crosses is decoded on each side, and only the app's page is answered.

const server = KnownEngine.make({
  name: 'build-box',
  address: EngineAddress.cases.Ssh.make({ destination: 'me@build-box' }),
  engine: EngineId.make('e-build-box'),
  protocol: 1,
})
const encoded = {
  name: 'build-box',
  address: { _tag: 'Ssh', destination: 'me@build-box' },
  engine: 'e-build-box',
  protocol: 1,
}
const read = KnownEnginesAnswer.cases.Read.make({ engines: [server] })
const kept = KeepAnswer.cases.Kept.make({})
const request: EnginePortRequest = { request: 3, address: server.address }

/** A stand-in ipcRenderer answering each channel's request with `answers`', recording what it is sent. */
const rendererIpc = (answers: Readonly<Record<string, unknown>>) => {
  const sent: Array<ReadonlyArray<unknown>> = []
  const listeners = new Map<
    string,
    (value: unknown, ports: ReadonlyArray<unknown>) => void
  >()
  const ipc: PreloadIpc = {
    send: (channel, ...values) => {
      sent.push([channel, ...values])
    },
    invoke: (channel, ...values) => {
      sent.push([channel, ...values])
      return Promise.resolve(answers[channel])
    },
    on: (channel, listener) => {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    },
  }
  return { ipc, sent, listeners }
}

/** The page's call, made with what its types don't allow: the page is untrusted. */
const callWith = (
  method: (...args: never) => unknown,
  args: ReadonlyArray<unknown>,
): unknown => Reflect.apply(method, undefined, args)

describe('the preload’s known engines', () => {
  it('reads them, keeps one, and asks for a port, encoded, and gives the page main’s answers decoded', async () => {
    const { ipc, sent } = rendererIpc({
      [channels.knownEngines]: { _tag: 'Read', engines: [encoded] },
      [channels.keepEngine]: kept,
    })
    const api = makeApi(ipc)
    expect(await api.knownEngines()).toEqual(read)
    expect(await api.keepEngine(server)).toEqual(kept)
    api.connectEngine(request)
    expect(sent).toEqual([
      [channels.knownEngines],
      [channels.keepEngine, encoded],
      [channels.connectEngine, request],
    ])
  })

  it('refuses what doesn’t decode, from the page or from main', async () => {
    const { ipc, sent } = rendererIpc({
      [channels.knownEngines]: { _tag: 'Read', engines: [{ name: '' }] },
    })
    const api = makeApi(ipc)
    await expect(api.knownEngines()).rejects.toThrow()
    await expect(
      callWith(api.keepEngine, [{ ...encoded, name: '' }]),
    ).rejects.toThrow()
    expect(() =>
      callWith(api.connectEngine, [
        {
          request: 1,
          address: { _tag: 'Ssh', destination: '-oProxyCommand=evil' },
        },
      ]),
    ).toThrow()
    expect(sent).toEqual([[channels.knownEngines]])
  })

  it('hands the page each known engine’s port with the number of its request, and nothing else', () => {
    const { ipc, listeners } = rendererIpc({})
    const posted: Array<[unknown, ReadonlyArray<MessagePort>]> = []
    forwardRemoteEnginePorts(ipc, (message, ports) =>
      posted.push([message, ports]),
    )
    const deliver = listeners.get(channels.remoteEnginePort)
    const { port1, port2 } = new MessageChannel()
    deliver?.({ request: 3 }, [port1])
    deliver?.({ request: 'three' }, [port1])
    deliver?.({ request: 4 }, [port1, port2])
    deliver?.({ request: 5 }, ['not a port'])
    expect(posted).toEqual([
      [{ type: remoteEnginePortMessage, request: 3 }, [port1]],
    ])
    port1.close()
    port2.close()
  })
})

describe('main’s known engines', () => {
  const app = 'file:///app/index.html'
  const setUp = () => {
    const handlers = new Map<
      string,
      (
        sender: string | undefined,
        values: ReadonlyArray<unknown>,
      ) => Promise<unknown>
    >()
    const listeners = new Map<
      string,
      (sender: string | undefined, values: ReadonlyArray<unknown>) => void
    >()
    const done: Array<unknown> = []
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
      checkEngine: unused,
      installEngine: unused,
      findWsl: unused,
      installUbuntu: unused,
      answerSshPrompt: () => undefined,
      knownEngines: () => Promise.resolve(read),
      keepEngine: engine => {
        done.push(engine)
        return Promise.resolve(kept)
      },
      connectEngine: asked => {
        done.push(asked)
      },
    }
    registerIpc({
      ipc: {
        on: (channel, listener) => listeners.set(channel, listener),
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
    const send = (
      channel: string,
      sender: string | undefined,
      ...values: Array<unknown>
    ) => listeners.get(channel)?.(sender, values)
    return { invoke, send, done }
  }

  it('answers the app’s page, what it passes decoded again', async () => {
    const { invoke, send, done } = setUp()
    expect(await invoke(channels.knownEngines, app)).toEqual(read)
    expect(await invoke(channels.keepEngine, app, encoded)).toEqual(kept)
    send(channels.connectEngine, app, request)
    expect(done).toEqual([server, request])
  })

  it('refuses another page, and what doesn’t decode', async () => {
    const { invoke, send, done } = setUp()
    for (const refused of [
      invoke(channels.knownEngines, 'https://example.com/'),
      invoke(channels.knownEngines, app, 'more'),
      invoke(channels.keepEngine, 'https://example.com/', encoded),
      invoke(channels.keepEngine, app, { ...encoded, protocol: 'one' }),
    ]) {
      await expect(refused).rejects.toThrow(/refused/)
    }
    send(channels.connectEngine, 'https://example.com/', request)
    send(channels.connectEngine, undefined, request)
    send(channels.connectEngine, app, { request: 1.5, address: server.address })
    send(channels.connectEngine, app, {
      request: 1,
      address: { _tag: 'Ssh', destination: '-oProxyCommand=evil' },
    })
    expect(done).toEqual([])
  })
})

/** A stand-in for safeStorage, which the known engines never reach. */
const secrets: SecretBox = {
  unavailable: () => Option.none(),
  encrypt: text => Buffer.from(text),
  decrypt: bytes => Buffer.from(bytes).toString('utf8'),
}

describe('the known engines in the app’s state', () => {
  it.effect('are kept and read back, as main answers the page', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folder = yield* tempFolder('known-engines')
        const state = yield* makeAppState({ folder, secrets })
        expect(yield* knownEnginesOf(state)).toEqual(
          KnownEnginesAnswer.cases.Read.make({ engines: [] }),
        )
        expect(yield* keepEngineIn(state, server)).toEqual(kept)
        const again = yield* makeAppState({ folder, secrets })
        expect(yield* knownEnginesOf(again)).toEqual(read)
      }),
    ),
  )

  it.effect('that can’t be read, or kept, are said so in words', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folder = yield* tempFolder('known-engines')
        yield* Effect.promise(() =>
          writeFile(NodePath.join(folder, stateFileName), '{"version": 9}'),
        )
        const state = yield* makeAppState({ folder, secrets })
        const answer = yield* knownEnginesOf(state)
        expect(KnownEnginesAnswer.guards.Failed(answer)).toBe(true)
        expect(
          KnownEnginesAnswer.guards.Failed(answer) && answer.reason,
        ).toMatch(/^couldn't read state\.json: /u)
        const keep = yield* keepEngineIn(state, server)
        expect(KeepAnswer.guards.Failed(keep)).toBe(true)
      }),
    ),
  )
})

describe('a known engine’s port', () => {
  const local = ConnectionTarget.cases.LocalSocket.make({
    path: '/home/ada/.local/share/fabrica/engine.sock',
  })

  it('is relayed to the target its address names', () => {
    expect(knownTarget(server.address, local)).toEqual(
      ConnectionTarget.cases.Ssh.make({ destination: 'me@build-box' }),
    )
    expect(knownTarget(EngineAddress.cases.Local.make({}), local)).toBe(local)
    expect(
      knownTarget(EngineAddress.cases.Wsl.make({ distro: 'Ubuntu' }), local),
    ).toEqual(ConnectionTarget.cases.Wsl.make({ distro: 'Ubuntu' }))
    expect(
      ConnectionTarget.guards.Unavailable(
        knownTarget(
          EngineAddress.cases.Tls.make({ address: 'build-box:7443' }),
          local,
        ),
      ),
    ).toBe(true)
  })

  it('is a new pair, one end relayed through the connection process and the other handed to the page', () => {
    const relayed: Array<[ConnectionTarget, string]> = []
    let spawns = 0
    let pairs = 0
    const broker = makeBroker<string>({
      spawn: () => {
        spawns += 1
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
      target: local,
    })
    const handed: Array<string> = []
    const target = knownTarget(server.address, local)
    broker.connect(target, port => handed.push(port))
    broker.connect(target, port => handed.push(port))
    expect(spawns).toBe(1)
    expect(relayed).toEqual([
      [target, 'relay-1'],
      [target, 'relay-2'],
    ])
    expect(handed).toEqual(['page-1', 'page-2'])
  })

  it.effect(
    'is asked for by the page with a number, and taken from the message carrying it',
    () =>
      Effect.gen(function* () {
        const asked: Array<unknown> = []
        const listeners = new Set<
          (request: number, port: MessagePort) => void
        >()
        const { port1, port2 } = new MessageChannel()
        const host = appHostOf(
          {
            fabrica: {
              connectEngine: (sent: unknown) => {
                asked.push(sent)
                // Another request's port comes first, then this one's.
                for (const listener of listeners) listener(99, port2)
                for (const listener of listeners) listener(1, port1)
              },
            },
          },
          Option.some(listener => {
            listeners.add(listener)
            return () => listeners.delete(listener)
          }),
        )
        const port = Option.getOrThrow(host.enginePort)
        expect(yield* port(server.address)).toBe(port1)
        expect(asked).toEqual([{ request: 1, address: server.address }])
        expect(listeners.size).toBe(0)
        expect(
          Option.isNone(appHostOf({ fabrica: {} }, Option.none()).enginePort),
        ).toBe(true)
        port1.close()
        port2.close()
      }),
  )
})
