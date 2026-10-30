import {
  Cause,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Pull,
  Ref,
  Schedule,
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

import { ndjson } from './frames'
import { interruptingOnProtocolErrors } from './protocol-errors'
import { Reconnect, type StreamItem, isDefect, resumable } from './resume'

// The engine client (spec §8): Effect RPC over a transport's `Socket`, its frames NDJSON. The client
// says hello at every connection (§8.4): the first at its start, which fails when the engine can't be
// reached or the two share no version, then again each time the socket protocol reconnects after a
// lost connection, since the engine on the other end may be another (restarted, updated). Its streams
// resume after a reconnect from the last sequence number they took (§8.3, `resume.ts`). The CLI and
// the app's connection process each run one per engine, over the transport that reaches it. A request
// or stream the engine answers with a defect (one it doesn't serve yet answers `NotImplemented`) fails
// with an `RpcClientError` whose reason is an `RpcClientDefect`, a failure every caller catches; a
// stream `watch` follows ends with it rather than waiting for a reconnect that won't mend it. A
// `reconnect` schedule that ends leaves the link `Lost`, and the streams `watch` follows end then.

/** The client's link to its engine. `connection` counts the connections the transport has opened. */
export type Link = Data.TaggedEnum<{
  /** Connection `connection` is open and the engine took the client's hello. */
  Up: { readonly connection: number; readonly hello: EngineHello }
  /** The connection was lost; the client is reconnecting. */
  Down: { readonly connection: number }
  /** Connection `connection` was lost and the client stopped reconnecting: its `reconnect` ended. */
  Lost: { readonly connection: number }
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
  /**
   * When to try the engine again after a lost connection: Effect's back-off (0.5 s, up to 5 s), for
   * good, unless given. Where the schedule ends, the client stops reconnecting and its link is `Lost`.
   */
  readonly reconnect?: Schedule.Schedule<unknown, Socket.SocketError>
}

export interface EngineClientShape {
  /**
   * Every request and stream, called as they are; a request fails with `RpcClientError` while the link
   * is down, and with one whose reason is an `RpcClientDefect` where the engine answers with a defect.
   */
  readonly rpc: FabricaClient
  /** The link now. */
  readonly link: Effect.Effect<Link>
  /** The link now, then each change of it. */
  readonly links: Stream.Stream<Link>
  /**
   * A stream subscribed through `subscribe`, resumed after each lost connection from the last
   * sequence number it took; it fails when the engine it reconnects to refuses the client's version,
   * when the engine answers it with a defect (or a frame the client can't read), and with the
   * connection's loss when the client stops reconnecting after it.
   */
  readonly watch: <S, P, E, R>(
    subscribe: (
      resume: Option.Option<Resume>,
    ) => Stream.Stream<StreamItem<S, P>, E | RpcClientError.RpcClientError, R>,
  ) => Stream.Stream<
    StreamItem<S, P>,
    | Exclude<E, RpcClientError.RpcClientError>
    | VersionMismatch
    | RpcClientError.RpcClientError,
    R
  >
}

export class EngineClient extends Context.Service<
  EngineClient,
  EngineClientShape
>()('@fabrica/client/EngineClient') {}

/** The words of a defect: an `Error`'s message, or the value itself. */
const defectWords = (defect: unknown): string =>
  defect instanceof Error ? defect.message : String(defect)

/** The failure a defect of request or stream `tag` comes to. */
const defectFailure = (tag: string, defect: unknown) =>
  new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({
      message: `${tag} failed: ${defectWords(defect)}`,
      cause: defect,
    }),
  })

/** A client error in words: the defect it carries, or the connection's loss. */
export const clientErrorWords = (
  error: RpcClientError.RpcClientError,
): string =>
  isDefect(error) ? error.reason.message : 'lost the engine before it answered'

/**
 * `rpc`, its requests and streams failing with `defectFailure` where they would die: the engine's
 * defect, carried by the protocol as one, reaches the caller as a failure it catches. (A stream taken
 * `asQueue` keeps its defects; the client takes none so.) Each is made once `settled`, so that a
 * protocol error failing the requests in flight fails none made after it (`protocol-errors.ts`).
 */
const failingOnDefects = (
  rpc: FabricaClient,
  settled: Effect.Effect<void>,
): FabricaClient =>
  new Proxy(rpc, {
    get: (target, tag, receiver) => {
      const call: unknown = Reflect.get(target, tag, receiver)
      if (typeof tag !== 'string' || typeof call !== 'function') {
        return call
      }
      return (...args: ReadonlyArray<unknown>) => {
        const answer: unknown = Reflect.apply(call, target, args)
        if (Stream.isStream(answer)) {
          return Stream.unwrap(
            Effect.as(
              settled,
              Stream.catchDefect(answer, defect =>
                Stream.fail(defectFailure(tag, defect)),
              ),
            ),
          )
        }
        if (Effect.isEffect(answer)) {
          return Effect.andThen(
            settled,
            Effect.catchDefect(answer, defect =>
              Effect.fail(defectFailure(tag, defect)),
            ),
          )
        }
        return answer
      }
    },
  })

/**
 * The first link after `connection` that is up or refused, or the link lost for good: the client may
 * subscribe again, or never.
 */
const linkAfter = (
  links: SubscriptionRef.SubscriptionRef<Link>,
  connection: number,
): Effect.Effect<Reconnect, VersionMismatch> =>
  SubscriptionRef.changes(links).pipe(
    Stream.filter(
      link =>
        Link.$is('Lost')(link) ||
        (link.connection > connection && !Link.$is('Down')(link)),
    ),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        // The link's changes end only as the client closes.
        onNone: () => Effect.interrupt,
        onSome: Link.$match({
          Up: () => Effect.succeed(Reconnect.Reconnected()),
          Down: () => Effect.succeed(Reconnect.Reconnected()),
          Lost: () => Effect.succeed(Reconnect.Stopped()),
          Refused: ({ mismatch }) => Effect.fail(mismatch),
        }),
      }),
    ),
  )

/** `schedule`, running `ended` as it ends: the socket protocol stops reconnecting then. */
const endingWith = (
  schedule: Schedule.Schedule<unknown, Socket.SocketError>,
  ended: Effect.Effect<void>,
): Schedule.Schedule<unknown, Socket.SocketError> =>
  Schedule.fromStep(
    Effect.map(
      Schedule.toStep(schedule),
      step => (now: number, input: Socket.SocketError) =>
        Pull.catchDone(step(now, input), output =>
          Effect.andThen(ended, Cause.done(output)),
        ),
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
  const lost = SubscriptionRef.update(links, link =>
    Link.Lost({ connection: link.connection }),
  )
  const protocol = yield* RpcClient.makeProtocolSocket({
    retryPolicy:
      options.reconnect === undefined
        ? undefined
        : endingWith(options.reconnect, lost),
  }).pipe(
    Effect.provideService(RpcClient.ConnectionHooks, hooks),
    Effect.provideService(RpcSerialization.RpcSerialization, ndjson),
  )
  const errors = yield* interruptingOnProtocolErrors(protocol)
  const rpc = failingOnDefects(
    yield* RpcClient.make(FabricaRpcs).pipe(
      Effect.provideService(RpcClient.Protocol, errors.protocol),
    ),
    errors.settled,
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
