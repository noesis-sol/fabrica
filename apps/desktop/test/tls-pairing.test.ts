import { Effect, Fiber, Option, Redacted, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { X509Certificate } from 'node:crypto'
import {
  type Server,
  type Socket,
  createServer as createNetServer,
} from 'node:net'
import { createServer as createTlsServer } from 'node:tls'

import { describe, expect, it } from '@effect/vitest'
import {
  EngineAddress,
  FingerprintAnswer,
  KeepAnswer,
  KnownEngine,
  PairAnswer,
  PairRequest,
  type TlsEndpoint,
  connectionRefused,
  portSocket,
  webPortEnd,
} from '@fabrica/client'
import { EngineId } from '@fabrica/contracts'
import { makeSelfSigned } from '@fabrica/engine/certificate'
import { tempFolder } from '@fabrica/testkit'
import { appHostOf } from '@fabrica/ui/host'

import {
  FingerprintRead,
  FingerprintRequest,
  fingerprintTimeout,
  readFingerprint,
} from '../src/connection/fingerprint'
import { relay } from '../src/connection/relay'
import { ConnectionTarget, encodeTarget } from '../src/connection/target'
import { engineSocket, refusalOf } from '../src/connection/transports'
import { type MainActions, registerIpc } from '../src/main/ipc'
import { makeFingerprintDesk, makePairings } from '../src/main/pairing'
import { type SecretBox, makeAppState } from '../src/main/state'
import { type PreloadIpc, channels, makeApi } from '../src/preload/api'

// Pairing with an engine over TLS (spec §9.1, §9.3, §8.2): the connection process reads the fingerprint
// of the certificate an engine presents, as main asks it; main pairs only with the fingerprint read,
// keeps the known engine with it pinned and the token in the app's secret storage once the engine is
// kept, and reaches it with its own records' fingerprint and token; a changed certificate or a refused
// token is a refusal the page is told, in words. The engines here are TLS servers on the loopback.

const fingerprintOf = (certificate: string): string =>
  new X509Certificate(certificate).fingerprint256

const other = Array.from({ length: 32 }, () => 'AB').join(':')

/** A stand-in for safeStorage: reversible, and recognisably sealed. */
const fakeSecrets = (
  unavailable: Option.Option<string> = Option.none(),
): SecretBox => ({
  unavailable: () => unavailable,
  encrypt: text => Buffer.from(`sealed:${text}`),
  decrypt: bytes => Buffer.from(bytes).toString('utf8').slice('sealed:'.length),
})

/** A server listening on a free port of the loopback for the scope, and its endpoint. */
const listening = (server: Server) =>
  Effect.acquireRelease(
    Effect.callback<TlsEndpoint>(resume => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resume(
          typeof address === 'object' && address !== null
            ? Effect.succeed({ host: '127.0.0.1', port: address.port })
            : Effect.die('the server has no port'),
        )
      })
    }),
    () =>
      Effect.callback<void>(resume => {
        server.close(() => resume(Effect.void))
      }),
  )

/**
 * An engine's TLS listener that refuses every token: its certificate's handshake done, each WebSocket
 * upgrade answered 401, as the engine answers a token it doesn't know.
 */
const refusingEngine = Effect.gen(function* () {
  const { certificate, key } = makeSelfSigned({ name: 'engine', now: 0 })
  const server = createTlsServer({ cert: certificate, key }, socket => {
    socket.once('data', () =>
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      ),
    )
    socket.on('error', () => undefined)
  })
  const endpoint = yield* listening(server)
  return { endpoint, fingerprint: fingerprintOf(certificate) }
})

/** What a connection to `target` says the page, through the relay: the refusal, in words. */
const refusalSaid = (target: ConnectionTarget) =>
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
        engine: engineSocket(target, { env: {}, askpass: Option.none() }),
        refusal: refusalOf,
      }),
    )
    const socket = yield* portSocket(webPortEnd(channel.port1))
    const reader = yield* socket.reader
    const failed = yield* Effect.flip(reader.pull)
    return Option.map(connectionRefused(failed), ({ reason }) => reason)
  })

describe('the connection process over TLS', () => {
  it.live('reads the fingerprint of the certificate the engine presents', () =>
    Effect.gen(function* () {
      const engine = yield* refusingEngine
      expect(yield* readFingerprint(engine.endpoint)).toEqual(
        FingerprintAnswer.cases.Presented.make({
          fingerprint: engine.fingerprint,
        }),
      )
    }).pipe(Effect.scoped),
  )

  it.live('says why no fingerprint could be read where nothing listens', () =>
    Effect.gen(function* () {
      // A port just freed: nothing listens on it.
      const endpoint = yield* Effect.scoped(
        listening(createNetServer(() => undefined)),
      )
      const answer = yield* readFingerprint(endpoint)
      expect(FingerprintAnswer.guards.Failed(answer)).toBe(true)
      expect(answer).toMatchObject({
        reason: expect.stringContaining(
          `couldn't reach an engine over TLS at 127.0.0.1:${endpoint.port}`,
        ),
      })
    }),
  )

  it.effect('gives up on an engine that never finishes its handshake', () =>
    Effect.gen(function* () {
      // A listener that takes the connection and says nothing; its connections ended with the test.
      const taken: Array<Socket> = []
      let connected = () => {}
      const reached = new Promise<void>(resolve => {
        connected = resolve
      })
      const endpoint = yield* listening(
        createNetServer(socket => {
          taken.push(socket)
          connected()
        }),
      )
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => taken.forEach(socket => socket.destroy())),
      )
      const read = yield* Effect.forkChild(readFingerprint(endpoint))
      yield* Effect.promise(() => reached)
      yield* TestClock.adjust(fingerprintTimeout)
      expect(yield* Fiber.join(read)).toEqual(
        FingerprintAnswer.cases.Failed.make({
          reason: `no engine answered at 127.0.0.1:${endpoint.port} within 15s`,
        }),
      )
    }).pipe(Effect.scoped),
  )

  it.live(
    'says a refused token to the page as refused, and a changed certificate as changed',
    () =>
      Effect.gen(function* () {
        const engine = yield* refusingEngine
        const target = (fingerprint: string) =>
          ConnectionTarget.cases.Tls.make({
            ...engine.endpoint,
            fingerprint,
            token: Redacted.make('fab_wrong'),
          })
        expect(yield* refusalSaid(target(engine.fingerprint))).toEqual(
          Option.some(
            'the engine refused the pairing token (HTTP 401): it is wrong, or was revoked; pair the engine again with a new token',
          ),
        )
        expect(yield* refusalSaid(target(other))).toEqual(
          Option.some(
            `the engine's certificate changed since it was paired: it presented ${engine.fingerprint}, not the ${other} it was paired with; pair it again only once you know the new certificate is the engine's`,
          ),
        )
      }).pipe(Effect.scoped),
  )

  it.effect('says a target main refused to the page, trying nothing', () =>
    Effect.gen(function* () {
      expect(
        yield* refusalSaid(
          ConnectionTarget.cases.Refused.make({
            reason: 'no pairing token is kept for build-box',
          }),
        ),
      ).toEqual(Option.some('no pairing token is kept for build-box'))
    }).pipe(Effect.scoped),
  )

  it('takes its target encoded, the token as text', () => {
    const target = ConnectionTarget.cases.Tls.make({
      host: '::1',
      port: 8443,
      fingerprint: other,
      token: Redacted.make('fab_secret'),
    })
    const encoded = encodeTarget(target)
    expect(encoded).toEqual({
      _tag: 'Tls',
      host: '::1',
      port: 8443,
      fingerprint: other,
      token: 'fab_secret',
    })
    const decoded = Schema.decodeUnknownSync(ConnectionTarget)(
      structuredClone(encoded),
    )
    expect(
      ConnectionTarget.guards.Tls(decoded) && Redacted.value(decoded.token),
    ).toBe('fab_secret')
  })
})

describe('the fingerprint desk', () => {
  it.effect('asks the connection process, numbered, and takes its answer', () =>
    Effect.gen(function* () {
      const posted: Array<unknown> = []
      const desk = makeFingerprintDesk(request => posted.push(request))
      const endpoint = { host: 'build-box', port: 8443 }
      const read = yield* Effect.forkChild(desk.read(endpoint))
      yield* Effect.yieldNow
      expect(posted).toEqual([
        Schema.encodeSync(FingerprintRequest)(
          FingerprintRequest.make({ id: 1, endpoint }),
        ),
      ])
      const presented = FingerprintAnswer.cases.Presented.make({
        fingerprint: other,
      })
      // What isn't a read, or answers no request, is dropped.
      desk.fromConnection({ _tag: 'Asked', id: 1 })
      desk.fromConnection(
        Schema.encodeSync(FingerprintRead)(
          FingerprintRead.make({ id: 2, answer: presented }),
        ),
      )
      desk.fromConnection(
        Schema.encodeSync(FingerprintRead)(
          FingerprintRead.make({ id: 1, answer: presented }),
        ),
      )
      expect(yield* Fiber.join(read)).toEqual(presented)
    }),
  )

  it.effect('fails the reads a connection process that exited held', () =>
    Effect.gen(function* () {
      const desk = makeFingerprintDesk(() => undefined)
      const read = yield* Effect.forkChild(
        desk.read({ host: 'build-box', port: 8443 }),
      )
      yield* Effect.yieldNow
      desk.connectionGone()
      expect(FingerprintAnswer.guards.Failed(yield* Fiber.join(read))).toBe(
        true,
      )
    }),
  )
})

const endpoint = { host: 'build-box', port: 8443 }
const presented = Array.from({ length: 32 }, () => '0F').join(':')
const local = ConnectionTarget.cases.LocalSocket.make({
  path: '/home/ada/.local/share/fabrica/engine.sock',
})
const paired = KnownEngine.make({
  name: 'build-box',
  address: EngineAddress.cases.Tls.make({
    ...endpoint,
    fingerprint: presented,
  }),
  engine: EngineId.make('e-build-box'),
  protocol: 1,
})
const request = (changes: Partial<PairRequest> = {}): PairRequest => ({
  name: 'build-box',
  endpoint,
  fingerprint: presented,
  token: Redacted.make('fab_token'),
  ...changes,
})

/** Main's pairings over an app state in a temporary folder, the engine at `endpoint` presenting `presented`. */
const pairingsIn = (secrets: SecretBox = fakeSecrets()) =>
  Effect.gen(function* () {
    const folder = yield* tempFolder('pairing')
    const state = yield* makeAppState({ folder, secrets })
    const pairings = makePairings({
      state,
      read: () =>
        Effect.succeed(
          FingerprintAnswer.cases.Presented.make({ fingerprint: presented }),
        ),
    })
    return { state, pairings }
  })

const tokenOf = (target: ConnectionTarget) =>
  ConnectionTarget.guards.Tls(target)
    ? Option.some(Redacted.value(target.token))
    : Option.none()

describe('main’s pairings', () => {
  it.effect(
    'pair with the fingerprint read, reach the engine with the token, and keep both once the engine is kept',
    () =>
      Effect.gen(function* () {
        const { state, pairings } = yield* pairingsIn()
        yield* pairings.readFingerprint(endpoint)
        expect(yield* pairings.pair(request())).toEqual(
          PairAnswer.cases.Paired.make({}),
        )
        // Held until the engine is kept: reached with the token, nothing in the state yet.
        const held = yield* pairings.target(paired.address, local)
        expect(held).toEqual(
          ConnectionTarget.cases.Tls.make({
            ...endpoint,
            fingerprint: presented,
            token: Redacted.make('fab_token'),
          }),
        )
        expect(tokenOf(held)).toEqual(Option.some('fab_token'))
        expect(yield* state.engines).toEqual([])

        expect(yield* pairings.keep(paired)).toEqual(
          KeepAnswer.cases.Kept.make({}),
        )
        expect(yield* state.engines).toEqual([paired])
        expect(
          Option.map(yield* state.token('build-box'), Redacted.value),
        ).toEqual(Option.some('fab_token'))
        expect(tokenOf(yield* pairings.target(paired.address, local))).toEqual(
          Option.some('fab_token'),
        )
        // Its engine updated since: kept again, as the state knows it.
        expect(
          yield* pairings.keep(KnownEngine.make({ ...paired, protocol: 2 })),
        ).toEqual(KeepAnswer.cases.Kept.make({}))
      }).pipe(Effect.scoped),
  )

  it.effect(
    'refuse a pairing whose fingerprint isn’t the one read, or whose token can’t be kept',
    () =>
      Effect.gen(function* () {
        const { pairings } = yield* pairingsIn()
        // Nothing read at that endpoint yet.
        expect(PairAnswer.guards.Failed(yield* pairings.pair(request()))).toBe(
          true,
        )
        yield* pairings.readFingerprint(endpoint)
        expect(yield* pairings.pair(request({ fingerprint: other }))).toEqual(
          PairAnswer.cases.Failed.make({
            reason: `${other} isn't the fingerprint the engine at build-box:8443 presented: read its certificate again`,
          }),
        )

        const noKeyring = yield* pairingsIn(
          fakeSecrets(Option.some('no keyring is running')),
        )
        yield* noKeyring.pairings.readFingerprint(endpoint)
        expect(yield* noKeyring.pairings.pair(request())).toEqual(
          PairAnswer.cases.Failed.make({
            reason:
              "the app can't keep the pairing token: no keyring is running",
          }),
        )
      }).pipe(Effect.scoped),
  )

  it.effect(
    'keep no engine over TLS, and reach none, that wasn’t paired with that certificate',
    () =>
      Effect.gen(function* () {
        const { state, pairings } = yield* pairingsIn()
        const unpairedWords =
          "the app hasn't paired with the engine at build-box:8443: add it again with a pairing token"
        expect(yield* pairings.keep(paired)).toEqual(
          KeepAnswer.cases.Failed.make({ reason: unpairedWords }),
        )
        expect(yield* pairings.target(paired.address, local)).toEqual(
          ConnectionTarget.cases.Refused.make({ reason: unpairedWords }),
        )

        yield* pairings.readFingerprint(endpoint)
        yield* pairings.pair(request())
        yield* pairings.keep(paired)
        // The page names another certificate at that endpoint: main's own records decide.
        const forged = EngineAddress.cases.Tls.make({
          ...endpoint,
          fingerprint: other,
        })
        expect(yield* pairings.target(forged, local)).toEqual(
          ConnectionTarget.cases.Refused.make({ reason: unpairedWords }),
        )
        expect(
          yield* pairings.keep(
            KnownEngine.make({ ...paired, address: forged }),
          ),
        ).toEqual(KeepAnswer.cases.Failed.make({ reason: unpairedWords }))
        expect(yield* state.engines).toEqual([paired])
      }).pipe(Effect.scoped),
  )

  it.effect('reach the other known engines as their addresses name them', () =>
    Effect.gen(function* () {
      const { pairings } = yield* pairingsIn()
      expect(
        yield* pairings.target(EngineAddress.cases.Local.make({}), local),
      ).toBe(local)
      expect(
        yield* pairings.target(
          EngineAddress.cases.Ssh.make({ destination: 'me@build-box' }),
          local,
        ),
      ).toEqual(
        ConnectionTarget.cases.Ssh.make({ destination: 'me@build-box' }),
      )
    }).pipe(Effect.scoped),
  )
})

describe('pairing through the preload and main', () => {
  it('carries the fingerprint read and the pairing, its token as text, only from the app’s page', async () => {
    const app = 'file:///app/index.html'
    const handlers = new Map<
      string,
      (
        sender: string | undefined,
        values: ReadonlyArray<unknown>,
      ) => Promise<unknown>
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
      knownEngines: unused,
      keepEngine: unused,
      connectEngine: () => undefined,
      readFingerprint: asked => {
        done.push(asked)
        return Promise.resolve(
          FingerprintAnswer.cases.Presented.make({ fingerprint: presented }),
        )
      },
      pairEngine: asked => {
        done.push(asked.name, Redacted.value(asked.token))
        return Promise.resolve(PairAnswer.cases.Paired.make({}))
      },
    }
    registerIpc({
      ipc: {
        on: () => undefined,
        handle: (channel, handler) => handlers.set(channel, handler),
      },
      trusted: url => url === app,
      actions,
    })
    const ipc: PreloadIpc = {
      send: () => undefined,
      invoke: (channel, ...values) =>
        handlers.get(channel)?.(app, values) ??
        Promise.reject(new Error(`no handler for ${channel}`)),
      on: () => () => undefined,
    }
    // The page's host, over the preload's API, as the renderer reaches it.
    const host = appHostOf({ fabrica: makeApi(ipc) })
    const read = Option.getOrThrow(host.readFingerprint)
    const pair = Option.getOrThrow(host.pairEngine)
    expect(await Effect.runPromise(read(endpoint))).toEqual(
      FingerprintAnswer.cases.Presented.make({ fingerprint: presented }),
    )
    expect(await Effect.runPromise(pair(request()))).toEqual(
      PairAnswer.cases.Paired.make({}),
    )
    expect(done).toEqual([endpoint, 'build-box', 'fab_token'])

    // From another page, or not a pairing: refused.
    await expect(
      handlers.get(channels.pairEngine)?.('https://example.com/', [
        Schema.encodeSync(PairRequest)(request()),
      ]),
    ).rejects.toThrow('refused fabrica:pair-engine')
    await expect(
      handlers.get(channels.pairEngine)?.(app, [
        { ...Schema.encodeSync(PairRequest)(request()), token: '' },
      ]),
    ).rejects.toThrow('refused fabrica:pair-engine')
    await expect(
      handlers.get(channels.readFingerprint)?.(app, [{ host: '', port: 1 }]),
    ).rejects.toThrow('refused fabrica:read-fingerprint')
  })
})
