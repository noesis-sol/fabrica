import { Effect, Fiber, Option, Stream } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, it, test } from '@effect/vitest'

import { Connection, connectionRequirements } from '../src/app/connection'
import { holdEnginePorts } from '../src/app/engine-ports'
import { Message } from '../src/app/message'
import { type Model, initialModel } from '../src/app/model'
import { enginePortMessage, onEnginePorts } from '../src/app/port'
import { update } from '../src/app/update'

// The engine port replaced (spec §8.2): main hands the page a new port each time the connection
// process is started again, and the renderer takes each, acquiring the connection again over the
// newest, as after any other drop.

/** Ports handed over by hand: `hand` is main's preload, `ports` the page's holder of them. */
const handOver = () => {
  const listeners: Array<(port: string) => void> = []
  const ports = holdEnginePorts<string>(listener => {
    listeners.push(listener)
  })
  const hand = (port: string) => {
    for (const listener of listeners) {
      listener(port)
    }
  }
  return { ports, hand }
}

describe('the engine ports held', () => {
  it.effect('a take waits for the first port', () =>
    Effect.gen(function* () {
      const { ports, hand } = handOver()
      const taking = yield* Effect.forkChild(ports.take)
      yield* Effect.yieldNow
      expect(taking.pollUnsafe()).toBeUndefined()
      hand('first')
      expect(yield* Fiber.join(taking)).toBe('first')
    }),
  )

  it.effect('a take gives the newest port', () =>
    Effect.gen(function* () {
      const { ports, hand } = handOver()
      hand('first')
      hand('second')
      expect(yield* ports.take).toBe('second')
    }),
  )

  it.effect('each port after the one taken replaces it', () =>
    Effect.gen(function* () {
      const { ports, hand } = handOver()
      hand('first')
      expect(yield* ports.take).toBe('first')
      const second = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(ports.replaced, 1)),
      )
      hand('second')
      expect(yield* Fiber.join(second)).toHaveLength(1)
      expect(yield* ports.take).toBe('second')
      const third = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(ports.replaced, 1)),
      )
      hand('third')
      expect(yield* Fiber.join(third)).toHaveLength(1)
      expect(yield* ports.take).toBe('third')
    }),
  )

  it.effect('the first port replaces none', () =>
    Effect.gen(function* () {
      const { ports, hand } = handOver()
      const replaced = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(ports.replaced, 1)),
      )
      yield* Effect.yieldNow
      hand('first')
      yield* ports.take
      yield* Effect.yieldNow
      expect(replaced.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(replaced)
    }),
  )

  it.effect(
    'a port that replaced the one taken before watching is told at once',
    () =>
      Effect.gen(function* () {
        const { ports, hand } = handOver()
        hand('first')
        yield* ports.take
        hand('second')
        const replaced = yield* Stream.runCollect(
          Stream.take(ports.replaced, 1),
        )
        expect(replaced).toHaveLength(1)
      }),
  )

  it.effect('a port taken already is not told again', () =>
    Effect.gen(function* () {
      const { ports, hand } = handOver()
      hand('first')
      yield* ports.take
      hand('second')
      yield* ports.take
      const replaced = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(ports.replaced, 1)),
      )
      yield* Effect.yieldNow
      expect(replaced.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(replaced)
    }),
  )
})

describe("the window's engine port messages", () => {
  test('each one hands the page its port; other messages do not', () => {
    const received: Array<MessagePort> = []
    const stop = onEnginePorts(window, port => received.push(port))
    const first = new MessageChannel()
    const second = new MessageChannel()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: enginePortMessage },
        ports: [first.port1],
      }),
    )
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'something-else' },
        ports: [second.port2],
      }),
    )
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: enginePortMessage },
        ports: [second.port1],
      }),
    )
    stop()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: enginePortMessage },
        ports: [first.port2],
      }),
    )
    expect(received).toEqual([first.port1, second.port1])
    for (const port of [first.port1, first.port2, second.port1, second.port2]) {
      port.close()
    }
  })
})

const start: Model = initialModel({ platform: 'darwin', release: '0.0.0' })

describe('a replaced engine port', () => {
  test('acquires the connection again over the new port', () => {
    const down = { ...start, connection: Connection.Down() }
    story(
      update,
      given(down),
      message(Message.ReplacedEnginePort()),
      Command.expectNone(),
      model(shown => {
        expect(shown.attempt).toBe(start.attempt + 1)
        expect(shown.connection).toEqual(Connection.Connecting())
        expect(connectionRequirements(shown)).not.toEqual(
          connectionRequirements(down),
        )
      }),
    )
  })

  test('leaves a refused connection waiting for an update', () => {
    const refused = {
      ...start,
      connection: Connection.Refused({
        client: 1,
        engine: 3,
        update: 'client',
      }),
    }
    story(
      update,
      given(refused),
      message(Message.ReplacedEnginePort()),
      Command.expectNone(),
      model(shown => {
        expect(shown).toEqual(refused)
        expect(connectionRequirements(shown)).toEqual(Option.none())
      }),
    )
  })
})
