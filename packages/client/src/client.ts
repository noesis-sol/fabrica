import {
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Ref,
  type Schedule,
  Stream,
  SubscriptionRef,
} from 'effect'
import { RpcClient, RpcClientError, RpcSerialization } from 'effect/rpc'
import type { Socket } from 'effect/socket'

import {
  ClientHello,
  type EngineHello,
  FabricaRpcs,
  type ProtocolVersion,
  type Resume,
  type VersionMismatch,
  protocolVersion,
} from '@fabrica/contracts'

import { type StreamItem, resumable } from './resume'

// The engine client (spec §8): Effect RPC over a transport's `Socket`, its frames NDJSON. The client
// says hello at every connection (§8.4): the first at its start, which fails when the engine can't be
// reached or the two share no version, then again each time the socket protocol reconnects after a
// lost connection, since the engine on the other end may be another (restarted, updated). Its streams
// resume after a reconnect from the last sequence number they took (§8.3, `resume.ts`). The CLI and
// the app's connection process each run one per engine, over the transport that reaches it.

/** The client's link to its engine. `connection` counts the connections the transport has opened. */
export type Link = Data.TaggedEnum<{
  /** Connection `connection` is open and the engine took the client's hello. */
  Up: { readonly connection: number; readonly hello: EngineHello }
  /** The connection was lost; the client is reconnecting. */
  Down: { readonly connection: number }
  /** The engine on connection `connection` shares no version with the client: one must be updated. */
  Refused: {
    readonly connection: number
    readonly mismatch: VersionMismatch
  }
}>
export const Link = Data.taggedEnum<Link>()

/** Every request and stream of the protocol, as the client calls them. */
export type FabricaClient = RpcClient.FromGroup<
  FabricaRpcs,
  RpcClientError.RpcClientError
>

/** How the client names itself to the engine, what it is and its release: its hello, less the protocol. */
export interface ClientOptions extends Pick<
  ClientHello,
  'name' | 'kind' | 'release'
> {
  /** The protocol version the client speaks: this package's, `protocolVersion`, unless a test says. */
  readonly protocol?: ProtocolVersion
  /** When to try the engine again after a lost connection: Effect's back-off (0.5 s, up to 5 s) unless given. */
  readonly reconnect?: Schedule.Schedule<unknown, Socket.SocketError>
}

export interface EngineClientShape {
  /** Every request and stream, called as they are; a request fails with `RpcClientError` while the link is down. */
  readonly rpc: FabricaClient
  /** The link now. */
  readonly link: Effect.Effect<Link>
  /** The link now, then each change of it. */
  readonly links: Stream.Stream<Link>
  /**
   * A stream subscribed through `subscribe`, resumed after each lost connection from the last
   * sequence number it took; it fails when the engine it reconnects to refuses the client's version.
   */
  readonly watch: <S, P, E, R>(
    subscribe: (
      resume: Option.Option<Resume>,
    ) => Stream.Stream<StreamItem<S, P>, E | RpcClientError.RpcClientError, R>,
  ) => Stream.Stream<
    StreamItem<S, P>,
    Exclude<E, RpcClientError.RpcClientError> | VersionMismatch,
    R
  >
}

export class EngineClient extends Context.Service<
  EngineClient,
  EngineClientShape
>()('@fabrica/client/EngineClient') {}

/** The first link after `connection` that is up or refused: the client may subscribe again, or never. */
const linkAfter = (
  links: SubscriptionRef.SubscriptionRef<Link>,
  connection: number,
): Effect.Effect<void, VersionMismatch> =>
  SubscriptionRef.changes(links).pipe(
    Stream.filter(
      link => link.connection > connection && !Link.$is('Down')(link),
    ),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        // The link's changes end only as the client closes.
        onNone: () => Effect.interrupt,
        onSome: Link.$match({
          Up: () => Effect.void,
          Down: () => Effect.void,
          Refused: ({ mismatch }) => Effect.fail(mismatch),
        }),
      }),
    ),
  )

/** A client over the transport's `Socket`, its first hello said: closed with its scope. */
export const make = Effect.fn('EngineClient.make')(function* (
  options: ClientOptions,
) {
  const hello = new ClientHello({
    name: options.name,
    kind: options.kind,
    release: options.release,
    protocol: options.protocol ?? protocolVersion,
  })
  const opened = yield* SubscriptionRef.make(0)
  const links = yield* SubscriptionRef.make<Link>(Link.Down({ connection: 0 }))
  const hooks = RpcClient.ConnectionHooks.of({
    onConnect: SubscriptionRef.update(opened, count => count + 1),
    onDisconnect: SubscriptionRef.update(links, link =>
      Link.$is('Up')(link) ? Link.Down({ connection: link.connection }) : link,
    ),
  })
  const protocol = yield* RpcClient.makeProtocolSocket({
    retryPolicy: options.reconnect,
  }).pipe(
    Effect.provideService(RpcClient.ConnectionHooks, hooks),
    Effect.provideService(
      RpcSerialization.RpcSerialization,
      RpcSerialization.ndjson,
    ),
  )
  const rpc = yield* RpcClient.make(FabricaRpcs).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  )
  const sayHello = rpc['engine.connect'](hello)

  const first = yield* sayHello
  const handshaken = yield* Ref.make(yield* SubscriptionRef.get(opened))
  yield* SubscriptionRef.set(
    links,
    Link.Up({ connection: yield* Ref.get(handshaken), hello: first }),
  )

  // Each connection the protocol opens after the first gets its own hello.
  yield* SubscriptionRef.changes(opened).pipe(
    Stream.runForEach(connection =>
      Effect.gen(function* () {
        if (connection <= (yield* Ref.get(handshaken))) {
          return
        }
        yield* Ref.set(handshaken, connection)
        yield* sayHello.pipe(
          Effect.flatMap(engine =>
            SubscriptionRef.set(links, Link.Up({ connection, hello: engine })),
          ),
          Effect.catchTags({
            VersionMismatch: mismatch =>
              SubscriptionRef.set(
                links,
                Link.Refused({ connection, mismatch }),
              ),
            // Lost again before the engine answered: the next connection says hello.
            RpcClientError: () => Effect.void,
          }),
        )
      }),
    ),
    Effect.forkScoped,
  )

  return EngineClient.of({
    rpc,
    link: SubscriptionRef.get(links),
    links: SubscriptionRef.changes(links),
    watch: subscribe =>
      resumable({
        subscribe,
        reconnected: Effect.map(SubscriptionRef.get(links), link =>
          linkAfter(links, link.connection),
        ),
      }),
  })
})

/** The engine client, over the transport's `Socket`. */
export const layer = (
  options: ClientOptions,
): Layer.Layer<
  EngineClient,
  RpcClientError.RpcClientError | VersionMismatch,
  Socket.Socket
> => Layer.effect(EngineClient, make(options))
