import { Effect, Exit, Option, Schema } from 'effect'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import { presentedFingerprint } from '@fabrica/client/node'
import {
  EngineHost,
  EngineStatus,
  parseListenAddress,
} from '@fabrica/contracts'
import { Daemon } from '@fabrica/engine'
import { tempFolder } from '@fabrica/testkit'

import { fabrica, onlyJson } from './tickets-engine'

// `fabrica engine status` names the TLS listener (spec §9.3): where the engine listens over TLS and
// its certificate's SHA-256 fingerprint, the one a client is presented at its first pairing, so the
// user reads it on the host. An engine that listens on its local socket only says so.

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'test',
  cores: 4,
})

/** An engine started in a temporary data folder, listening over TLS where `listen` says. */
const testEngine = (listen: Option.Option<string>) =>
  Effect.gen(function* () {
    const root = yield* tempFolder('status-tls')
    const paths = Daemon.pathsIn({
      data: NodePath.join(root, 'd'),
      socketFolder: NodePath.join(root, 'd'),
    })
    const engine = yield* Daemon.startEngine({
      paths,
      host,
      release: '1.2.3',
      listen: {
        listen: Option.flatMap(listen, parseListenAddress),
        listen_certificate: Option.none(),
        listen_key: Option.none(),
      },
    })
    return { socket: paths.socket, engine }
  })

const fingerprintPattern = /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/u

describe('fabrica engine status, listening over TLS', () => {
  it.live(
    'prints the listener’s address and the fingerprint a client is presented',
    () =>
      Effect.gen(function* () {
        const { socket, engine } = yield* testEngine(Option.some('127.0.0.1:0'))
        if (Option.isNone(engine.listening))
          return yield* Effect.die('the engine doesn’t listen over TLS')
        const { port } = engine.listening.value.address
        const presented = yield* presentedFingerprint({
          host: '127.0.0.1',
          port,
        })
        expect(presented).toMatch(fingerprintPattern)

        const text = yield* fabrica(socket, 'engine', 'status')
        expect(text.exit).toStrictEqual(Exit.void)
        const lines = text.out.join('\n').split('\n')
        expect(lines).toContain(`listens   127.0.0.1:${port} over TLS`)
        expect(lines).toContain(`          certificate SHA-256 ${presented}`)

        const json = yield* fabrica(socket, 'engine', 'status', '--json')
        expect(json.exit).toStrictEqual(Exit.void)
        const encoded = onlyJson(json.out)
        expect(encoded).toMatchObject({
          listening: {
            address: `127.0.0.1:${port}`,
            fingerprint: presented,
          },
        })
        const status = Schema.decodeUnknownSync(EngineStatus)(encoded)
        expect(
          Option.map(status.listening, ({ address }) => address.port),
        ).toStrictEqual(Option.some(port))
      }).pipe(Effect.scoped),
  )

  it.live('says the engine listens on its local socket only', () =>
    Effect.gen(function* () {
      const { socket } = yield* testEngine(Option.none())

      const text = yield* fabrica(socket, 'engine', 'status')
      expect(text.exit).toStrictEqual(Exit.void)
      expect(text.out.join('\n').split('\n')).toContain(
        'listens   on its local socket only',
      )

      const json = yield* fabrica(socket, 'engine', 'status', '--json')
      expect(onlyJson(json.out)).toMatchObject({ listening: null })
    }).pipe(Effect.scoped),
  )
})
