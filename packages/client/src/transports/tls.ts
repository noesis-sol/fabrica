import {
  Data,
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  type Scope,
} from 'effect'
import type { RpcClientError } from 'effect/rpc'
import { Socket } from 'effect/socket'
import { isIPv6 } from 'node:net'
import { type TLSSocket, connect } from 'node:tls'

import { NodeSocket } from '@effect/platform-node'
import { bearerAuthorization, pairingPath } from '@fabrica/contracts'

// The TLS transport (spec §8.2, §9.3): the protocol as a WebSocket over TLS to an engine's listener,
// for an engine not reached through SSH. The engine's certificate is its own, self-signed, or the
// user's: the client trusts it by its SHA-256 fingerprint, pinned at the first pairing, where the user
// is shown the fingerprint the engine presents (`presentedFingerprint`) and accepts it. From then on a
// connection checks the fingerprint once the TLS handshake is done, before anything is sent, and one
// to an engine presenting another certificate fails with `CertificateChanged`. The pairing token goes
// in the upgrade request's `Authorization` header; one the engine refuses fails with `TokenRefused`.
// Each open of the `Socket` is a new connection; either refusal is the cause of its `SocketOpenError`,
// which `tlsRefused` finds: trying again would end the same way.

/** Where an engine's TLS listener is. */
export interface TlsAddress {
  readonly host: string
  readonly port: number
}

/** An engine paired over TLS: where it is, its certificate's pinned fingerprint and the client's token. */
export interface TlsEngine extends TlsAddress {
  /** As Node writes it: upper-case hex pairs joined by colons. */
  readonly fingerprint: string
  readonly token: Redacted.Redacted<string>
}

/** The engine presented a certificate other than the one pinned at its pairing. */
export class CertificateChanged extends Data.TaggedError('CertificateChanged')<{
  readonly pinned: string
  readonly presented: string
}> {
  override get message() {
    return `the engine's certificate changed since it was paired: it presented ${this.presented}, not the ${this.pinned} it was paired with; pair it again only once you know the new certificate is the engine's`
  }
}

/** The engine refused the client's pairing token: wrong, or revoked. */
export class TokenRefused extends Data.TaggedError('TokenRefused')<{
  readonly status: number
}> {
  override get message() {
    return `the engine refused the pairing token (HTTP ${this.status}): it is wrong, or was revoked; pair the engine again with a new token`
  }
}

/** The refusal a connection's error carries, if the engine refused it: its certificate or the token. */
export const tlsRefused = (
  error: Socket.SocketError | RpcClientError.RpcClientError,
): Option.Option<CertificateChanged | TokenRefused> => {
  const { reason } = error
  return Predicate.hasProperty(reason, 'cause') &&
    (reason.cause instanceof CertificateChanged ||
      reason.cause instanceof TokenRefused)
    ? Option.some(reason.cause)
    : Option.none()
}

const openFailed = (cause: unknown) =>
  new Socket.SocketError({
    reason: new Socket.SocketOpenError({ kind: 'Unknown', cause }),
  })

/** A TLS connection to `address`, its handshake done, whatever certificate the engine presents. */
const connectTls = (
  address: TlsAddress,
): Effect.Effect<TLSSocket, Socket.SocketError> =>
  Effect.callback<TLSSocket, Socket.SocketError>(resume => {
    const socket = connect({
      host: address.host,
      port: address.port,
      // Checked by its fingerprint instead.
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    })
    const failed = (cause: Error) => resume(Effect.fail(openFailed(cause)))
    socket.once('error', failed)
    socket.once('secureConnect', () => {
      socket.off('error', failed)
      resume(Effect.succeed(socket))
    })
    return Effect.sync(() => socket.destroy())
  })

/** The fingerprint of the certificate a connected socket's engine presented. */
const fingerprintOf = (socket: TLSSocket): string =>
  socket.getPeerCertificate().fingerprint256.toUpperCase()

/** The fingerprint of the certificate the engine at `address` presents: what a first pairing shows the user. */
export const presentedFingerprint = (
  address: TlsAddress,
): Effect.Effect<string, Socket.SocketError> =>
  Effect.acquireRelease(
    connectTls(address),
    socket => Effect.sync(() => socket.destroy()),
    // A connection that hangs is given up by interrupting it, which destroys its socket.
    { interruptible: true },
  ).pipe(Effect.map(fingerprintOf), Effect.scoped)

/** A host as a URL writes it. */
const urlHost = (host: string): string => (isIPv6(host) ? `[${host}]` : host)

type WebSocket = InstanceType<typeof NodeSocket.NodeWS.WebSocket>

/** The WebSocket over `socket`, upgraded with the engine's token; closed with the scope. */
const upgrade = (
  engine: TlsEngine,
  socket: TLSSocket,
): Effect.Effect<WebSocket, Socket.SocketError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<WebSocket, Socket.SocketError>(resume => {
      const ws = new NodeSocket.NodeWS.WebSocket(
        `wss://${urlHost(engine.host)}:${engine.port}${pairingPath}`,
        {
          headers: {
            authorization: bearerAuthorization(Redacted.value(engine.token)),
          },
          createConnection: () => socket,
        },
      )
      const stop = () => {
        ws.removeAllListeners('open')
        ws.removeAllListeners('unexpected-response')
        ws.removeAllListeners('error')
      }
      ws.once('open', () => {
        stop()
        resume(Effect.succeed(ws))
      })
      ws.once('unexpected-response', (request, response) => {
        stop()
        const status = response.statusCode ?? 0
        request.destroy()
        socket.destroy()
        resume(
          Effect.fail(
            openFailed(
              status === 401
                ? new TokenRefused({ status })
                : new Error(`the engine answered HTTP ${status}`),
            ),
          ),
        )
      })
      ws.once('error', cause => {
        stop()
        socket.destroy()
        resume(Effect.fail(openFailed(cause)))
      })
      return Effect.sync(() => ws.terminate())
    }),
    ws => Effect.sync(() => ws.close()),
  )

/** A new connection to `engine`: TLS, its certificate checked against the pin, then the upgrade. */
const open = (engine: TlsEngine) =>
  Effect.gen(function* () {
    const socket = yield* Effect.acquireRelease(
      connectTls(engine),
      socket =>
        Effect.sync(() => {
          if (!socket.destroyed) socket.end()
        }),
      { interruptible: true },
    )
    const presented = fingerprintOf(socket)
    if (presented !== engine.fingerprint.toUpperCase())
      return yield* Effect.fail(
        openFailed(
          new CertificateChanged({ pinned: engine.fingerprint, presented }),
        ),
      )
    return yield* upgrade(engine, socket)
  })

/** The engine paired over TLS, as a `Socket`: each open is a new connection. */
export const layerTls = (engine: TlsEngine): Layer.Layer<Socket.Socket> =>
  Layer.effect(Socket.Socket, Socket.fromWebSocket(open(engine)))
