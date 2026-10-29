import { Data, Deferred, Effect, Option, PubSub, Queue, Redacted } from 'effect'
import { HttpServerRequest, HttpServerResponse } from 'effect/http'
import { type Socket, SocketServer } from 'effect/socket'
import { createServer } from 'node:https'

import { NodeHttpServer } from '@effect/platform-node'
import {
  type ListenAddress,
  type TokenName,
  bearerToken,
  formatListenAddress,
  pairingPath,
} from '@fabrica/contracts'

import type { TlsCertificate } from './certificate'
import { PairingTokens } from './tokens'

// The TLS listener (spec §8.2, §9.3, §20.2): the protocol as a WebSocket over TLS, on the address the
// engine is told to listen on, for clients that don't reach the engine through SSH. A client presents a
// pairing token in its upgrade request's `Authorization` header (`Bearer <token>`); one that presents
// none, or one the engine doesn't hold, is answered 401 and never reaches the protocol. A connection's
// token revoked later closes it. Connections that pass are handed to the RPC server as sockets, as the
// local socket's are, so one server, one set of handlers, serves both. The listener's certificate is
// the user's or the engine's own (`certificate.ts`); clients pin its fingerprint at their first pairing.

/** Where the listener listens, the port it was given (0: one the system chose), and its certificate's fingerprint. */
export interface TlsEndpoint {
  readonly address: ListenAddress
  readonly fingerprint: string
}

/** The listener, bound: its connections as a socket server, and where it listens. */
export interface TlsListener {
  readonly server: SocketServer.SocketServer['Service']
  readonly endpoint: TlsEndpoint
}

/** The listener couldn't listen on its address. */
export class ListenFailed extends Data.TaggedError('ListenFailed')<{
  readonly address: string
  readonly reason: string
}> {
  override get message() {
    return `the engine couldn't listen on ${this.address}: ${this.reason}`
  }
}

/**
 * A connection that passed, waiting for the RPC server: its socket, `revoked` once its token is, and
 * `done` once the server has finished with it.
 */
interface Arrival {
  readonly socket: Socket.Socket
  readonly revoked: Effect.Effect<void>
  readonly done: Deferred.Deferred<void>
}

/** Waits until `name` is revoked. */
const revokedOf = (
  revocations: PubSub.Subscription<TokenName>,
  name: TokenName,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    while ((yield* PubSub.take(revocations)) !== name) {
      // Another token's revocation: this connection stays.
    }
  })

/** The URL's path, without its query. */
const pathOf = (url: string): string => new URL(url, 'https://engine').pathname

/** Listens on `address` with `certificate`, for the current scope; its connections wait until the server runs. */
export const listenTls = Effect.fn('TlsListener.listen')(function* (options: {
  readonly address: ListenAddress
  readonly certificate: TlsCertificate
}) {
  const tokens = yield* PairingTokens
  const incoming = yield* Queue.unbounded<Arrival>()
  const http = yield* NodeHttpServer.make(
    () =>
      createServer({
        cert: options.certificate.certificate,
        key: Redacted.value(options.certificate.key),
        minVersion: 'TLSv1.2',
      }),
    {
      host: Option.getOrUndefined(options.address.host),
      port: options.address.port,
      disablePreemptiveShutdown: true,
    },
  ).pipe(
    Effect.mapError(
      error =>
        new ListenFailed({
          address: formatListenAddress(options.address),
          reason:
            error.cause instanceof Error
              ? error.cause.message
              : String(error.cause),
        }),
    ),
  )

  const answer = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (pathOf(request.url) !== pairingPath)
      return HttpServerResponse.empty({ status: 404 })
    // Taken before the token is checked, so a revocation in between still closes the connection.
    const revocations = yield* tokens.revocations
    const name = yield* Option.match(
      bearerToken(request.headers['authorization']),
      {
        onNone: () => Effect.succeedNone,
        onSome: tokens.verify,
      },
    ).pipe(Effect.orDie)
    if (Option.isNone(name))
      return HttpServerResponse.empty({
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
      })
    const upgraded = yield* Effect.option(request.upgrade)
    if (Option.isNone(upgraded))
      return HttpServerResponse.empty({ status: 426 })
    const done = yield* Deferred.make<void>()
    yield* Queue.offer(incoming, {
      socket: upgraded.value,
      revoked: revokedOf(revocations, name.value),
      done,
    })
    // The request holds the subscription until the server has finished with its connection.
    yield* Deferred.await(done)
    return HttpServerResponse.empty()
  })
  yield* http.serve(answer)

  const server = SocketServer.SocketServer.of({
    address: http.address,
    run: handler =>
      Effect.forever(
        Effect.flatMap(Queue.take(incoming), ({ socket, revoked, done }) =>
          Effect.forkScoped(
            // The socket's WebSocket is the handler's: it closes as the handler ends.
            handler(socket).pipe(
              Effect.raceFirst(revoked),
              Effect.ignoreCause,
              Effect.ensuring(Deferred.succeed(done, undefined)),
            ),
          ),
        ),
      ).pipe(Effect.scoped),
  })
  const endpoint: TlsEndpoint = {
    address: {
      host: options.address.host,
      port: 'port' in http.address ? http.address.port : options.address.port,
    },
    fingerprint: options.certificate.fingerprint,
  }
  return { server, endpoint } satisfies TlsListener
})
