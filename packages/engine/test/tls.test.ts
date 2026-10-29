import { Effect, Exit, Layer, Option, Redacted, Stream } from 'effect'
import type { RpcClientError } from 'effect/rpc'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { SqlClient } from 'effect/sql'
import { X509Certificate } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { NodeSocket } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { make } from '@fabrica/client'
import {
  CertificateChanged,
  type TlsEngine,
  TokenRefused,
  layerTls,
  presentedFingerprint,
} from '@fabrica/client/node'
import {
  EngineHost,
  FabricaRpcs,
  type ListenAddress,
  parseListenAddress,
  protocolVersion,
} from '@fabrica/contracts'

import {
  type EnginePaths,
  type ListenSettings,
  engineDatabaseLayer,
  pathsIn,
  startEngine,
} from '../src/engine'
import { makeSelfSigned } from '../src/rpc'

// The TLS listener and pairing tokens (spec §9.3, §8.2, §20.2): an engine started in a temporary data
// folder, listening on a free port of the loopback, reached through the client's TLS transport with a
// token made over its local socket; and the tokens themselves, made, listed and revoked.

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'test-host',
  cores: 8,
})
const release = '1.2.3'

/** A temporary folder for one test, removed when the test ends; short, as a socket's path must be. */
const scratch = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(NodePath.join(tmpdir(), 'fab-t-'))),
  folder => Effect.promise(() => rm(folder, { recursive: true, force: true })),
)

const scratchPaths = Effect.map(scratch, root =>
  pathsIn({
    data: NodePath.join(root, 'data'),
    socketFolder: NodePath.join(root, 'data'),
  }),
)

/** A free port of the loopback, which the system picks. */
const loopback: ListenAddress = Option.getOrThrow(
  parseListenAddress('127.0.0.1:0'),
)

const listenOn = (settings: Partial<ListenSettings> = {}): ListenSettings => ({
  listen: Option.some(loopback),
  listen_certificate: Option.none(),
  listen_key: Option.none(),
  ...settings,
})

/** An engine listening over TLS as `listen` says, for the current scope, and where it listens. */
const startListening = (paths: EnginePaths, listen = listenOn()) =>
  Effect.gen(function* () {
    const engine = yield* startEngine({ paths, host, release, listen })
    if (Option.isNone(engine.listening))
      return yield* Effect.die('the engine doesn’t listen over TLS')
    return engine.listening.value
  })

/** A protocol client on the engine's local socket. */
const localClient = (paths: EnginePaths) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide([
          NodeSocket.layerNet({ path: paths.socket }),
          RpcSerialization.layerNdjson,
        ]),
      ),
    )
    return yield* RpcClient.make(FabricaRpcs).pipe(Effect.provide(protocol))
  })

/** The engine client over TLS, as the CLI and the app make it. */
const tlsClient = (engine: TlsEngine) =>
  make({ name: 'tls test', kind: 'cli', release }).pipe(
    Effect.provide(layerTls(engine)),
  )

/** What a connection the engine refused failed with: the cause of its socket's open error. */
const refusal = (error: RpcClientError.RpcClientError | { _tag: string }) =>
  'reason' in error &&
  error.reason._tag === 'SocketOpenError' &&
  'cause' in error.reason
    ? error.reason.cause
    : error

const engineAt = (port: number) => ({ host: '127.0.0.1', port })

describe('the TLS listener', () => {
  it.live('serves the protocol to a client with a token', () =>
    Effect.gen(function* () {
      const paths = yield* scratchPaths
      const endpoint = yield* startListening(paths)
      expect(endpoint.address.port).toBeGreaterThan(0)

      const local = yield* localClient(paths)
      const created = yield* local['tokens.create']({ name: 'laptop' })
      // The first pairing: the fingerprint the engine presents is the one it says it listens with.
      const fingerprint = yield* presentedFingerprint(
        engineAt(endpoint.address.port),
      )
      expect(fingerprint).toBe(endpoint.fingerprint)

      const client = yield* tlsClient({
        ...engineAt(endpoint.address.port),
        fingerprint,
        token: created.token,
      })
      const hello = yield* client.link
      expect(hello._tag).toBe('Up')
      const version = yield* client.rpc['engine.version']()
      expect(version.release).toBe(release)
      expect(version.protocol).toBe(protocolVersion)
      // Both clients are the one server's: the local socket's and the listener's.
      expect((yield* client.rpc['engine.status']()).clients).toBe(2)

      const listed = yield* local['tokens.list']()
      expect(
        listed.map(token => [token.name, Option.isSome(token.lastUsedAt)]),
      ).toStrictEqual([['laptop', true]])
    }),
  )

  it.live('refuses a wrong token, and none', () =>
    Effect.gen(function* () {
      const paths = yield* scratchPaths
      const endpoint = yield* startListening(paths)
      const local = yield* localClient(paths)
      yield* local['tokens.create']({ name: 'laptop' })

      const error = yield* tlsClient({
        ...engineAt(endpoint.address.port),
        fingerprint: endpoint.fingerprint,
        token: Redacted.make('fabrica_not-a-token'),
      }).pipe(Effect.flip)
      expect(refusal(error)).toBeInstanceOf(TokenRefused)

      // An upgrade with no token at all is answered 401, before it reaches the protocol.
      const status = yield* Effect.callback<number>(resume => {
        const asked = request({
          host: '127.0.0.1',
          port: endpoint.address.port,
          path: '/rpc',
          rejectUnauthorized: false,
          headers: {
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-version': '13',
            'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          },
        })
        asked.on('response', response => {
          response.resume()
          resume(Effect.succeed(response.statusCode ?? 0))
        })
        asked.on('error', () => resume(Effect.succeed(0)))
        asked.end()
      })
      expect(status).toBe(401)
    }),
  )

  it.live('refuses a revoked token, and closes its connections', () =>
    Effect.gen(function* () {
      const paths = yield* scratchPaths
      const endpoint = yield* startListening(paths)
      const local = yield* localClient(paths)
      const created = yield* local['tokens.create']({ name: 'laptop' })
      const engine: TlsEngine = {
        ...engineAt(endpoint.address.port),
        fingerprint: endpoint.fingerprint,
        token: created.token,
      }
      const client = yield* tlsClient(engine)
      expect((yield* client.rpc['engine.version']()).release).toBe(release)

      yield* local['tokens.revoke']({ name: 'laptop' })
      // The open connection is closed: its link goes down.
      const down = yield* client.links.pipe(
        Stream.filter(link => link._tag === 'Down'),
        Stream.runHead,
      )
      expect(Option.isSome(down)).toBe(true)
      expect(yield* local['tokens.list']()).toStrictEqual([])

      const error = yield* tlsClient(engine).pipe(Effect.flip)
      expect(refusal(error)).toBeInstanceOf(TokenRefused)
    }),
  )

  it.live('refuses an engine whose certificate changed after pairing', () =>
    Effect.gen(function* () {
      const [first, second] = yield* Effect.all([scratchPaths, scratchPaths])
      const paired = yield* startListening(first)
      // Another engine at another address, presenting its own certificate: as the paired engine's
      // would be, replaced.
      const other = yield* startListening(second)
      expect(other.fingerprint).not.toBe(paired.fingerprint)
      const local = yield* localClient(second)
      const created = yield* local['tokens.create']({ name: 'laptop' })

      const error = yield* tlsClient({
        ...engineAt(other.address.port),
        fingerprint: paired.fingerprint,
        token: created.token,
      }).pipe(Effect.flip)
      const changed = refusal(error)
      expect(changed).toBeInstanceOf(CertificateChanged)
      expect(changed).toMatchObject({
        pinned: paired.fingerprint,
        presented: other.fingerprint,
      })
      // Refused before the token was sent: the engine never saw it used.
      const listed = yield* local['tokens.list']()
      expect(
        listed.map(token => Option.isNone(token.lastUsedAt)),
      ).toStrictEqual([true])
    }),
  )

  it.live('keeps its own certificate from one start to the next', () =>
    Effect.gen(function* () {
      const paths = yield* scratchPaths
      const once = Effect.scoped(
        Effect.map(startListening(paths), ({ fingerprint }) => fingerprint),
      )
      const fingerprint = yield* once
      expect(yield* once).toBe(fingerprint)
      const mode = (yield* Effect.promise(() => lstat(paths.certificateKey)))
        .mode
      expect(mode & 0o777).toBe(0o600)
      const certificate = new X509Certificate(
        yield* Effect.promise(() => readFile(paths.certificate, 'utf8')),
      )
      expect(certificate.fingerprint256).toBe(fingerprint)
    }),
  )

  it.live('listens with the certificate the user gives', () =>
    Effect.gen(function* () {
      const paths = yield* scratchPaths
      const folder = yield* scratch
      const made = makeSelfSigned({ name: 'my engine', now: Date.now() })
      const certificate = NodePath.join(folder, 'cert.pem')
      const key = NodePath.join(folder, 'key.pem')
      yield* Effect.promise(() =>
        Promise.all([
          writeFile(certificate, made.certificate),
          writeFile(key, made.key),
        ]),
      )
      const endpoint = yield* startListening(
        paths,
        listenOn({
          listen_certificate: Option.some(certificate),
          listen_key: Option.some(key),
        }),
      )
      expect(endpoint.fingerprint).toBe(
        new X509Certificate(made.certificate).fingerprint256,
      )
      expect(yield* presentedFingerprint(engineAt(endpoint.address.port))).toBe(
        endpoint.fingerprint,
      )
    }),
  )

  it.live('refuses to start with only one of the certificate’s files', () =>
    Effect.gen(function* () {
      const paths = yield* scratchPaths
      const exit = yield* startListening(
        paths,
        listenOn({ listen_certificate: Option.some('/nowhere/cert.pem') }),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.live('listens where the engine’s settings say, without a flag', () =>
    Effect.gen(function* () {
      const paths = yield* scratchPaths
      // The settings stored before the engine starts, as `engine.settings` reads them.
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            mkdir(paths.data, { recursive: true, mode: 0o700 }),
          )
          const context = yield* Layer.build(
            engineDatabaseLayer(paths.database),
          )
          const sql = yield* Effect.provide(SqlClient.SqlClient, context)
          yield* sql`INSERT INTO settings (singleton, document) VALUES (1, ${JSON.stringify({ listen: '127.0.0.1:0' })})`
        }),
      )
      const engine = yield* startEngine({ paths, host, release })
      expect(Option.isSome(engine.listening)).toBe(true)
    }),
  )

  it.live('listens only on its local socket where nothing says to', () =>
    Effect.gen(function* () {
      const paths = yield* scratchPaths
      const engine = yield* startEngine({ paths, host, release })
      expect(Option.isNone(engine.listening)).toBe(true)
    }),
  )
})

describe('the pairing tokens', () => {
  it.live(
    'are made once by name, listed without their secret, and revoked by name',
    () =>
      Effect.gen(function* () {
        const paths = yield* scratchPaths
        yield* startEngine({ paths, host, release })
        const local = yield* localClient(paths)

        const laptop = yield* local['tokens.create']({ name: 'laptop' })
        const desk = yield* local['tokens.create']({ name: 'desk' })
        expect(Redacted.value(laptop.token)).toMatch(/^fabrica_[0-9a-f]{64}$/u)
        expect(Redacted.value(desk.token)).not.toBe(
          Redacted.value(laptop.token),
        )

        const taken = yield* local['tokens.create']({ name: 'laptop' }).pipe(
          Effect.flip,
        )
        expect(taken._tag).toBe('TokenExists')

        const listed = yield* local['tokens.list']()
        expect(listed.map(token => token.name)).toStrictEqual([
          'desk',
          'laptop',
        ])
        expect(JSON.stringify(listed)).not.toContain(
          Redacted.value(laptop.token),
        )

        yield* local['tokens.revoke']({ name: 'laptop' })
        expect(
          (yield* local['tokens.list']()).map(token => token.name),
        ).toStrictEqual(['desk'])
        const gone = yield* local['tokens.revoke']({ name: 'laptop' }).pipe(
          Effect.flip,
        )
        expect(gone._tag).toBe('TokenNotFound')
      }),
  )

  it.live('keep only each token’s hash', () =>
    Effect.gen(function* () {
      const paths = yield* scratchPaths
      yield* startEngine({ paths, host, release })
      const local = yield* localClient(paths)
      const created = yield* local['tokens.create']({ name: 'laptop' })
      const database = yield* Effect.promise(() => readFile(paths.database))
      expect(database.includes(Redacted.value(created.token))).toBe(false)
    }),
  )
})
