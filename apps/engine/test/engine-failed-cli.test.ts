import { Console, Effect, Exit, Layer, Stream } from 'effect'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { SocketServer } from 'effect/socket'
import * as NodePath from 'node:path'

import { NodeServices, NodeSocketServer } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import {
  EngineHello,
  EngineId,
  EngineRpcs,
  protocolVersion,
} from '@fabrica/contracts'
import { Rpc } from '@fabrica/engine'
import { layerHost, tempFolder } from '@fabrica/testkit'

import { LocalEngine } from '../src/cli/connect'
import { runCli } from '../src/cli/main'

// A command whose request the engine answers with a defect (fab-mgi.87): the engine's `NotImplemented`
// for a request it doesn't serve yet. The CLI says the engine couldn't answer, and why, rather than
// that the connection was lost.

/** `fabrica <args>` with the local engine at `socket`: its exit and what it printed. */
const fabrica = (socket: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const out: Array<string> = []
    const err: Array<string> = []
    const console: Console.Console = Object.assign(
      Object.create(globalThis.console),
      {
        log: (...line: ReadonlyArray<unknown>) => out.push(line.join(' ')),
        error: (...line: ReadonlyArray<unknown>) => err.push(line.join(' ')),
      },
    )
    const exit = yield* runCli(args).pipe(
      Effect.provideService(Console.Console, console),
      Effect.provide([
        NodeServices.layer,
        Layer.succeed(LocalEngine)({ socket: Effect.succeed(socket) }),
        layerHost(),
      ]),
      Effect.exit,
    )
    return { exit, out, err }
  })

/** An engine on a socket in a temporary folder that says hello and serves nothing else. */
const unservedEngine = Effect.gen(function* () {
  const root = yield* tempFolder('cli-failed')
  const socket = NodePath.join(root, 'engine.sock')
  const server = yield* NodeSocketServer.make({ path: socket })
  yield* Layer.build(
    // As the engine's server does, a defect answers its own request.
    RpcServer.layer(EngineRpcs, { disableFatalDefects: true }).pipe(
      Layer.provide(
        EngineRpcs.toLayer({
          'engine.connect': () =>
            Effect.succeed(
              new EngineHello({
                protocol: protocolVersion,
                engine: EngineId.make('e-1'),
                release: '1.2.3',
              }),
            ),
          'engine.version': Rpc.notImplemented('engine.version'),
          'engine.status': Rpc.notImplemented('engine.status'),
          'engine.settings': Rpc.notImplemented('engine.settings'),
          'engine.stop': Rpc.notImplemented('engine.stop'),
          'engine.update': Rpc.notImplemented('engine.update'),
          'engine.watchStatus': Rpc.notImplemented('engine.watchStatus'),
          'engine.watchLoad': () => Stream.never,
        }),
      ),
      Layer.provide(RpcServer.layerProtocolSocketServer),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(Layer.succeed(SocketServer.SocketServer, server)),
    ),
  )
  return socket
})

describe('a request the engine answers with a defect', () => {
  it.live('says the engine couldn’t answer, and why', () =>
    Effect.gen(function* () {
      const socket = yield* unservedEngine
      const { exit, out, err } = yield* fabrica(socket, 'engine', 'status')
      expect(Exit.isFailure(exit)).toBe(true)
      expect(out).toStrictEqual([])
      expect(err).toStrictEqual([
        `fabrica: the engine at ${socket} couldn't answer: engine.status failed: engine.status is not implemented yet`,
      ])
    }).pipe(Effect.scoped),
  )
})
