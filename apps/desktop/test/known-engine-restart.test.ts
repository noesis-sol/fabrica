import { Effect, Option, Stream } from 'effect'

import { describe, expect, it } from '@effect/vitest'
import { EngineAddress } from '@fabrica/client'
import { appHostOf } from '@fabrica/ui/host'

import { ConnectionTarget } from '../src/connection/target'
import {
  type BrokeredPage,
  type ConnectionProcess,
  addressKey,
  makeBroker,
} from '../src/main/ports'

// A known engine's port as the connection process starts anew (spec §8.2, §9.1): the ports main
// relayed to known engines die with the process, so main relays the newest it handed each page for
// each engine again, through the process started anew, handed to the page under the request it
// answered; and the page takes it as that request's newest port.

const local = ConnectionTarget.cases.LocalSocket.make({
  path: '/home/ada/.local/share/fabrica/engine.sock',
})
const buildBox = EngineAddress.cases.Ssh.make({ destination: 'me@build-box' })
const toBuildBox = ConnectionTarget.cases.Ssh.make({
  destination: 'me@build-box',
})
const lab = EngineAddress.cases.Ssh.make({ destination: 'me@lab' })
const toLab = ConnectionTarget.cases.Ssh.make({ destination: 'me@lab' })

const makeHost = () => {
  let pairs = 0
  const spawned: Array<{
    readonly relayed: Array<[ConnectionTarget, string]>
    readonly exit: () => void
  }> = []
  const restarts: Array<() => void> = []
  const broker = makeBroker<string>({
    spawn: onExit => {
      const relayed: Array<[ConnectionTarget, string]> = []
      spawned.push({ relayed, exit: onExit })
      const child: ConnectionProcess<string> = {
        relay: (to, port) => relayed.push([to, port]),
        post: () => undefined,
      }
      return child
    },
    afterExit: restart => restarts.push(restart),
    channel: () => {
      pairs += 1
      return { page: `page-${pairs}`, relay: `relay-${pairs}` }
    },
    target: local,
  })
  /** Exits the newest connection process; `restart` runs the pauses that followed. */
  const exit = () => spawned.at(-1)?.exit()
  const restart = () => restarts.splice(0).forEach(run => run())
  return { broker, spawned, exit, restart }
}

/** A page whose loads, navigations and going a test triggers, recording the ports it is handed. */
const fakePage = (id: number) => {
  const loads: Array<() => void> = []
  const navigations: Array<() => void> = []
  const gone: Array<() => void> = []
  const page: BrokeredPage<string> = {
    id,
    onLoad: listener => loads.push(listener),
    onNavigate: listener => navigations.push(listener),
    onGone: listener => gone.push(listener),
    send: () => undefined,
  }
  return {
    page,
    load: () => loads.forEach(listener => listener()),
    navigate: () => navigations.forEach(listener => listener()),
    go: () => gone.forEach(listener => listener()),
  }
}

/** A page's ask for a port to a known engine, recording the ports handed for it under its request. */
const ask = (
  handed: Array<string>,
  {
    page,
    request,
    address,
    target,
  }: {
    readonly page: number
    readonly request: number
    readonly address: EngineAddress
    readonly target: ConnectionTarget
  },
) => ({
  page,
  engine: addressKey(address),
  target,
  send: (port: string) => handed.push(`#${request} ${port}`),
})

describe('a known engine’s port, the connection process started anew', () => {
  it('is relayed again through the new process, the newest for each page and engine, under its request', () => {
    const { broker, spawned, exit, restart } = makeHost()
    const handed: Array<string> = []
    const window = fakePage(7)
    broker.attach(window.page)
    window.load()
    broker.connect(
      ask(handed, {
        page: 7,
        request: 1,
        address: buildBox,
        target: toBuildBox,
      }),
    )
    // The page's next attempt for the build box replaces its first.
    broker.connect(
      ask(handed, {
        page: 7,
        request: 2,
        address: buildBox,
        target: toBuildBox,
      }),
    )
    broker.connect(
      ask(handed, { page: 7, request: 3, address: lab, target: toLab }),
    )
    expect(handed).toEqual(['#1 page-2', '#2 page-3', '#3 page-4'])
    exit()
    restart()
    expect(spawned.length).toBe(2)
    expect(spawned[1]?.relayed).toEqual([
      [local, 'relay-5'],
      [toBuildBox, 'relay-6'],
      [toLab, 'relay-7'],
    ])
    expect(handed.slice(3)).toEqual(['#2 page-6', '#3 page-7'])
    // And again at the next restart.
    exit()
    restart()
    expect(spawned[2]?.relayed).toEqual([
      [local, 'relay-8'],
      [toBuildBox, 'relay-9'],
      [toLab, 'relay-10'],
    ])
  })

  it('is not relayed again where it went through the process started since the exit', () => {
    const { broker, spawned, exit, restart } = makeHost()
    const handed: Array<string> = []
    broker.connect(
      ask(handed, {
        page: 7,
        request: 1,
        address: buildBox,
        target: toBuildBox,
      }),
    )
    exit()
    // The page's next attempt, during the pause, starts the connection process anew itself.
    broker.connect(
      ask(handed, {
        page: 7,
        request: 2,
        address: buildBox,
        target: toBuildBox,
      }),
    )
    restart()
    expect(spawned.length).toBe(2)
    expect(spawned[1]?.relayed).toEqual([[toBuildBox, 'relay-2']])
    expect(handed).toEqual(['#1 page-1', '#2 page-2'])
  })

  it('is forgotten as its page moves to a new document or goes', () => {
    const { broker, spawned, exit, restart } = makeHost()
    const handed: Array<string> = []
    const reloaded = fakePage(7)
    const closed = fakePage(8)
    broker.attach(reloaded.page)
    broker.attach(closed.page)
    broker.connect(
      ask(handed, {
        page: 7,
        request: 1,
        address: buildBox,
        target: toBuildBox,
      }),
    )
    broker.connect(
      ask(handed, { page: 8, request: 1, address: lab, target: toLab }),
    )
    reloaded.navigate()
    closed.go()
    exit()
    restart()
    expect(spawned.length).toBe(1)
    expect(handed).toEqual(['#1 page-1', '#1 page-2'])
  })

  it.effect('is taken by the page as its request’s newest port', () =>
    Effect.gen(function* () {
      const listeners = new Set<(request: number, port: MessagePort) => void>()
      const first = new MessageChannel()
      const again = new MessageChannel()
      const host = appHostOf(
        {
          fabrica: {
            connectEngine: () => {
              for (const listener of listeners) listener(1, first.port1)
              // Another request's port, then this one's, handed over again.
              for (const listener of listeners) listener(2, first.port2)
              for (const listener of listeners) listener(1, again.port1)
            },
          },
        },
        Option.some(listener => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }),
      )
      const ports = Option.getOrThrow(host.enginePorts)
      expect(yield* Stream.runCollect(Stream.take(ports(buildBox), 2))).toEqual(
        [first.port1, again.port1],
      )
      expect(listeners.size).toBe(0)
      first.port1.close()
      again.port1.close()
    }),
  )
})
