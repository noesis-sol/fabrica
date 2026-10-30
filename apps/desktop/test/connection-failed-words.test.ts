import { Effect, Option, Redacted } from 'effect'
import { createServer } from 'node:net'

import { describe, expect, it, layer } from '@effect/vitest'
import {
  connectionFailed,
  connectionRefused,
  portSocket,
  webPortEnd,
} from '@fabrica/client'
import { Toolbox, layerToolbox, shStub } from '@fabrica/testkit'

import { LocalEngineReach } from '../src/connection/local-engine'
import { relay } from '../src/connection/relay'
import { ConnectionTarget } from '../src/connection/target'
import { engineSocket, saidOf } from '../src/connection/transports'

// A connection the relay couldn't open reaches the page in words (spec §8.2, §9.1, H61): ssh's lost
// link, a missing ssh, a TLS connection's error are said as failed, which a later connection may mend;
// not as a bare close.

/** The local engine answers: main's answer to every ask. */
const engineAnswers = Effect.succeed(LocalEngineReach.cases.Reached.make({}))

const toolbox = layerToolbox({
  stubs: {
    ssh: shStub(
      [
        'echo "ssh: connect to host server-1 port 22: Operation timed out" >&2',
        'exit 255',
      ].join('\n'),
    ),
  },
})

/** What a connection to `target` says the page through the relay: failed or refused, in words. */
const saidThroughRelay = (
  target: ConnectionTarget,
  env: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const channel = yield* Effect.acquireRelease(
      Effect.sync(() => new MessageChannel()),
      ({ port1, port2 }) =>
        Effect.sync(() => {
          port1.close()
          port2.close()
        }),
    )
    yield* Effect.forkScoped(
      relay({
        port: webPortEnd(channel.port2),
        engine: engineSocket(target, {
          env,
          localEngine: engineAnswers,
          askpass: Option.none(),
        }),
        said: saidOf,
      }),
    )
    const socket = yield* portSocket(webPortEnd(channel.port1))
    const failed = yield* Effect.flip(
      Effect.scoped(Effect.flatMap(socket.reader, reader => reader.pull)),
    )
    return {
      failed: Option.map(connectionFailed(failed), ({ reason }) => reason),
      refused: Option.map(connectionRefused(failed), ({ reason }) => reason),
    }
  })

/** A local TCP port nothing listens on: one a server was given, then closed. */
const closedPort = Effect.promise(
  () =>
    new Promise<number>((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port =
          typeof address === 'object' && address !== null ? address.port : 0
        server.close(() => resolve(port))
      })
    }),
)

describe('a connection the relay couldn’t open', () => {
  layer(toolbox, { excludeTestServices: true })(it => {
    it.effect('says ssh’s lost link, in its words', () =>
      Effect.gen(function* () {
        const tools = yield* Toolbox
        const said = yield* saidThroughRelay(
          ConnectionTarget.cases.Ssh.make({ destination: 'u@server-1' }),
          tools.env(),
        )
        expect(said.refused).toEqual(Option.none())
        expect(
          Option.map(said.failed, reason =>
            reason.includes(
              'connect to host server-1 port 22: Operation timed out',
            ),
          ),
        ).toEqual(Option.some(true))
      }).pipe(Effect.scoped),
    )

    it.effect('says there is no ssh to run', () =>
      Effect.gen(function* () {
        const tools = yield* Toolbox
        const said = yield* saidThroughRelay(
          ConnectionTarget.cases.Ssh.make({ destination: 'u@server-1' }),
          { ...tools.env(), PATH: tools.home },
        )
        expect(
          Option.map(said.failed, reason => reason.includes('ENOENT')),
        ).toEqual(Option.some(true))
      }).pipe(Effect.scoped),
    )
  })

  it.live('says why a TLS engine couldn’t be reached', () =>
    Effect.gen(function* () {
      const port = yield* closedPort
      const said = yield* saidThroughRelay(
        ConnectionTarget.cases.Tls.make({
          host: '127.0.0.1',
          port,
          fingerprint: Array.from({ length: 32 }, () => 'AB').join(':'),
          token: Redacted.make('fab_token'),
        }),
        {},
      )
      expect(
        Option.map(said.failed, reason => reason.includes('ECONNREFUSED')),
      ).toEqual(Option.some(true))
    }).pipe(Effect.scoped),
  )
})
