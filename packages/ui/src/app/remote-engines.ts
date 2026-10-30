import {
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Ref,
  Schema,
  type Scope,
  Semaphore,
  Stream,
} from 'effect'
import { Command } from 'foldkit'

import {
  type ClientOptions,
  EngineAddress,
  EngineName,
  KeepAnswer,
  KnownEngine,
  KnownEnginesAnswer,
  Link,
  type SshDestination,
  WslDistro,
  wslEngineName,
} from '@fabrica/client'
import { EngineId, ProtocolVersion } from '@fabrica/contracts'

import {
  AttemptFailure,
  Connection,
  type EngineSession,
  attemptFailure,
  connect,
  isLive,
  localEngineName,
  retryAfter,
} from './connection'
import { AppHost } from './host'
import { Message } from './message'

// The app's known engines on other hosts (spec §9.1), each reached through its own connection: the
// app's state keeps them (a name, how to reach it, the engine's ID and protocol version), and an engine
// Add engine installed, or found up to date, joins them, kept once its first hello comes. Each is
// connected to over a port of its own, asked of main at each attempt; an attempt that fails is tried
// again after a pause, inside the engine's stream, and each engine's stream runs in a fiber of its own,
// so another engine's attempts, or its joining, leave its connection be.
// One refused (its protocol too old or too new) or stopped (ssh refused its host) waits for the user:
// an update over SSH, or trying again. Its project rows join the sidebar's under its name, and while it
// is connected its session is held by its name, so each request and stream for one of its projects goes
// through it (engine-route.ts).
// The engine in WSL2 is the app's own connection's (§7.6): main reaches the one Add engine installed or
// found up to date there, every page given a new port to it, and the app's connection's next hello
// keeps it, so main reaches it again at the next start.

/** A known engine on another host, as the app connects to it. */
export const RemoteEngine = Schema.Struct({
  name: EngineName,
  address: EngineAddress,
  /** The engine and protocol the app's state keeps for it: none until its first hello is kept. */
  kept: Schema.Option(
    Schema.Struct({ engine: EngineId, protocol: ProtocolVersion }),
  ),
  /** The user's attempts: one more each time they try again, or the engine was updated. */
  attempt: Schema.Int,
  connection: Connection,
})
export type RemoteEngine = typeof RemoteEngine.Type

export const Model = Schema.Struct({
  /** The known engines on other hosts, in the order they became known. */
  engines: Schema.Array(RemoteEngine),
  /** What reading the known engines, or keeping one, last said where it failed. */
  problem: Schema.Option(Schema.String),
  /** The WSL2 distribution whose engine Add engine installed or found up to date, until its hello is kept. */
  wsl: Schema.Option(WslDistro),
})
export type Model = typeof Model.Type

export const init = (): Model => ({
  engines: [],
  problem: Option.none(),
  wsl: Option.none(),
})

/** The engine named `name`, if the app knows it. */
export const named = (
  model: Model,
  name: EngineName,
): Option.Option<RemoteEngine> =>
  Option.fromUndefinedOr(model.engines.find(engine => engine.name === name))

/** Whether the engine named `engine` is connected: this machine's through the app's connection, another's through its own. */
export const isEngineLive = (
  model: {
    readonly connection: Connection
    readonly remotes: Model
  },
  engine: string,
): boolean =>
  engine === localEngineName
    ? isLive(model.connection)
    : Option.exists(named(model.remotes, engine), remote =>
        isLive(remote.connection),
      )

/** The names of the engines connected now: this machine's, then the known engines', in their order. */
export const liveEngines = (model: {
  readonly connection: Connection
  readonly remotes: Model
}): ReadonlyArray<string> =>
  [localEngineName, ...model.remotes.engines.map(remote => remote.name)].filter(
    engine => isEngineLive(model, engine),
  )

/** The known engine reached at `destination` over SSH, if any. */
export const atDestination = (
  model: Model,
  destination: SshDestination,
): Option.Option<RemoteEngine> =>
  Option.fromUndefinedOr(
    model.engines.find(
      engine =>
        EngineAddress.guards.Ssh(engine.address) &&
        engine.address.destination === destination,
    ),
  )

/** Whether `a` and `b` reach an engine the same way: over TLS, at one endpoint with one pinned certificate. */
export const sameAddress = (a: EngineAddress, b: EngineAddress): boolean =>
  EngineAddress.match(a, {
    Local: () => EngineAddress.guards.Local(b),
    Ssh: ({ destination }) =>
      EngineAddress.guards.Ssh(b) && b.destination === destination,
    Wsl: ({ distro }) => EngineAddress.guards.Wsl(b) && b.distro === distro,
    Tls: ({ host, port, fingerprint }) =>
      EngineAddress.guards.Tls(b) &&
      b.host === host &&
      b.port === port &&
      b.fingerprint === fingerprint,
  })

const changeEngine = (
  model: Model,
  name: EngineName,
  change: (engine: RemoteEngine) => RemoteEngine,
): Model => ({
  ...model,
  engines: model.engines.map(engine =>
    engine.name === name ? change(engine) : engine,
  ),
})

/**
 * The engines the app's state knows joined to those held: those on this machine, and those in WSL2,
 * whose first main reaches through the app's own connection (§7.6), left to it; those held already kept
 * as they are.
 */
export const loaded = (
  model: Model,
  engines: ReadonlyArray<KnownEngine>,
): Model => ({
  ...model,
  problem: Option.none(),
  engines: [
    ...model.engines,
    ...engines
      .filter(
        known =>
          !EngineAddress.guards.Local(known.address) &&
          !EngineAddress.guards.Wsl(known.address) &&
          Option.isNone(named(model, known.name)),
      )
      .map((known): RemoteEngine => ({
        name: known.name,
        address: known.address,
        kept: Option.some({ engine: known.engine, protocol: known.protocol }),
        attempt: 1,
        connection: Connection.Connecting(),
      })),
  ],
})

/**
 * The engine named `name` at `address` joined to the known engines, to be kept once its first hello
 * comes; one of that name already known is connected to again, at `address`, kept again where it moved
 * (an engine over TLS paired again, with its new certificate).
 */
export const added = (
  model: Model,
  {
    name,
    address,
  }: { readonly name: EngineName; readonly address: EngineAddress },
): Model =>
  Option.isSome(named(model, name))
    ? reconnected(
        changeEngine(model, name, engine =>
          sameAddress(engine.address, address)
            ? engine
            : { ...engine, address, kept: Option.none() },
        ),
        name,
      )
    : {
        ...model,
        engines: [
          ...model.engines,
          {
            name,
            address,
            kept: Option.none(),
            attempt: 1,
            connection: Connection.Connecting(),
          },
        ],
      }

/** The engine named `name`'s connection now `connection`. */
export const connectionChanged = (
  model: Model,
  name: EngineName,
  connection: Connection,
): Model => changeEngine(model, name, engine => ({ ...engine, connection }))

/** The engine named `name` connected to again: the user tried again, or its engine was updated. */
export const reconnected = (model: Model, name: EngineName): Model =>
  changeEngine(model, name, engine => ({
    ...engine,
    attempt: engine.attempt + 1,
    connection: Connection.Connecting(),
  }))

/**
 * The engine named `name` connected, its hello saying `engine` and `protocol`; the known engine to keep
 * where the app's state doesn't hold it so yet (first reached, or updated since), taken as kept.
 */
export const connected = (
  model: Model,
  {
    name,
    hello,
  }: {
    readonly name: EngineName
    readonly hello: Extract<Connection, { readonly _tag: 'Up' }>
  },
): { readonly model: Model; readonly keep: Option.Option<KnownEngine> } => {
  const keep = Option.flatMap(named(model, name), engine =>
    Option.exists(
      engine.kept,
      kept => kept.engine === hello.engine && kept.protocol === hello.protocol,
    )
      ? Option.none()
      : Option.some(
          KnownEngine.make({
            name,
            address: engine.address,
            engine: hello.engine,
            protocol: hello.protocol,
          }),
        ),
  )
  return {
    model: changeEngine(model, name, engine => ({
      ...engine,
      connection: hello,
      kept: Option.isSome(keep)
        ? Option.some({ engine: hello.engine, protocol: hello.protocol })
        : engine.kept,
    })),
    keep,
  }
}

/** The engine in `distro` reached by the app's own connection, Add engine having installed or found it there. */
export const reachedInWsl = (model: Model, distro: WslDistro): Model => ({
  ...model,
  wsl: Option.some(distro),
})

/**
 * The app's own connection up, its hello saying `engine` and `protocol`: the engine in WSL2 Add engine
 * reached, to keep under its distribution's name, where one waits for its hello.
 */
export const connectedInWsl = (
  model: Model,
  hello: Extract<Connection, { readonly _tag: 'Up' }>,
): { readonly model: Model; readonly keep: Option.Option<KnownEngine> } => ({
  model: { ...model, wsl: Option.none() },
  keep: Option.map(model.wsl, distro =>
    KnownEngine.make({
      name: wslEngineName(distro),
      address: EngineAddress.cases.Wsl.make({ distro }),
      engine: hello.engine,
      protocol: hello.protocol,
    }),
  ),
})

/** What each engine's connection depends on: its address and the user's attempts. */
export const Attempts = Schema.Array(
  Schema.Struct({
    name: EngineName,
    address: EngineAddress,
    attempt: Schema.Int,
  }),
)
export type Attempts = typeof Attempts.Type

export const attempts = (model: Model): Attempts =>
  model.engines.map(({ name, address, attempt }) => ({
    name,
    address,
    attempt,
  }))

// Commands: the known engines read from the app's state, and one kept there.

/** What the known engines say where no app is around the renderer to keep them. */
export const noAppToKeepEngines = 'only the desktop app keeps known engines'

export const LoadKnownEngines = Command.define('LoadKnownEngines', {
  messages: [Message.LoadedKnownEngines],
  execute: Effect.gen(function* () {
    const host = yield* AppHost
    const answer = yield* Option.getOrElse(host.knownEngines, () =>
      Effect.succeed(KnownEnginesAnswer.cases.Read.make({ engines: [] })),
    )
    return Message.LoadedKnownEngines({ answer })
  }),
})

export const KeepEngine = Command.define('KeepEngine', {
  args: { engine: KnownEngine },
  messages: [Message.CompletedKeepEngine],
  execute: ({ engine }) =>
    Effect.gen(function* () {
      const host = yield* AppHost
      const answer = yield* Option.match(host.keepEngine, {
        onNone: () =>
          Effect.succeed(
            KeepAnswer.cases.Failed.make({ reason: noAppToKeepEngines }),
          ),
        onSome: keep => keep(engine),
      })
      return Message.CompletedKeepEngine({ name: engine.name, answer })
    }),
})

// The connections: one stream per engine, its attempts one after another.

/** What an engine's link says, as the root's Messages for the engine named `name`. */
const linkMessage = (name: EngineName) =>
  Link.$match({
    Up: ({ hello }): Message =>
      Message.ConnectedToRemote({
        name,
        engine: hello.engine,
        release: hello.release,
        protocol: hello.protocol,
      }),
    Down: (): Message => Message.LostRemote({ name }),
    Lost: (): Message =>
      Message.FailedToConnectRemote({
        name,
        reason: 'the client stopped reconnecting',
      }),
    Refused: ({ mismatch }): Message =>
      Message.RefusedByRemote({
        name,
        client: mismatch.client,
        engine: mismatch.engine,
        update: mismatch.update,
      }),
  })

/** Whether an attempt that ended with `message` waits for the user rather than trying again. */
const waitsForUser = (message: Message): boolean =>
  Predicate.isTagged(message, 'RefusedByRemote') ||
  Predicate.isTagged(message, 'StoppedConnectingRemote')

/** What an engine's connection needs: its port, at each attempt, and the hello's facts. */
export interface RemoteConnection {
  readonly name: EngineName
  readonly port: Effect.Effect<MessagePort>
  readonly client: ClientOptions
  /** The engine's own streams while it is connected: its project rows, for the sidebar. */
  readonly streams: (session: EngineSession) => Stream.Stream<Message>
  /** Holds the attempt's session as the engine's until the scope, the attempt's, closes (engine-route.ts). */
  readonly keep: (
    session: EngineSession,
  ) => Effect.Effect<void, never, Scope.Scope>
}

/**
 * One attempt: the client over a new port, its session held as the engine's, its link's changes and its
 * streams, until its link ends.
 */
const attemptMessages = ({
  name,
  port,
  client,
  streams,
  keep,
}: RemoteConnection): Stream.Stream<Message> =>
  Stream.unwrap(
    connect({ enginePort: port, client }).pipe(
      Effect.tap(keep),
      Effect.map(session =>
        Stream.merge(
          session.client.links.pipe(
            Stream.map(linkMessage(name)),
            Stream.takeUntil(
              message =>
                Predicate.isTagged(message, 'FailedToConnectRemote') ||
                Predicate.isTagged(message, 'RefusedByRemote'),
            ),
          ),
          streams(session),
          { haltStrategy: 'left' },
        ),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Stream.make(
            AttemptFailure.$match(attemptFailure(error), {
              Refused: ({ mismatch }): Message =>
                Message.RefusedByRemote({
                  name,
                  client: mismatch.client,
                  engine: mismatch.engine,
                  update: mismatch.update,
                }),
              Stopped: ({ reason }): Message =>
                Message.StoppedConnectingRemote({ name, reason }),
              Unreachable: ({ reason }): Message =>
                Message.FailedToConnectRemote({ name, reason }),
            }),
          ),
        ),
      ),
    ),
  )

/**
 * The engine's connection, attempt after attempt: one that fails is tried again after a pause; one
 * refused or stopped ends the stream, until the user's next attempt starts it again.
 */
export const remoteEngineMessages = (
  connection: RemoteConnection,
  pause: Effect.Effect<void> = Effect.sleep(retryAfter),
): Stream.Stream<Message> =>
  Stream.unwrap(
    Effect.map(Ref.make<Option.Option<Message>>(Option.none()), last =>
      attemptMessages(connection).pipe(
        Stream.tap(message => Ref.set(last, Option.some(message))),
        Stream.concat(
          Stream.unwrap(
            Effect.map(Ref.get(last), ended =>
              Option.exists(ended, waitsForUser)
                ? Stream.empty
                : Stream.fromEffectDrain(pause).pipe(
                    Stream.concat(
                      Stream.suspend(() =>
                        remoteEngineMessages(connection, pause),
                      ),
                    ),
                  ),
            ),
          ),
        ),
      ),
    ),
  )

// The connections held: each engine's stream runs in a fiber of its own, started and stopped one by one
// as the known engines change, so adding one, trying one again or updating one leaves the others'
// connections up. Their Messages come out of one queue, which a subscription reads.

/** An engine's connection, as the held connections key it: its name, address and the user's attempt. */
export type Attempt = Attempts[number]

/** Whether `a` and `b` are the same connection: the same engine, address and attempt. */
const sameAttempt = (a: Attempt, b: Attempt): boolean =>
  a.name === b.name &&
  a.attempt === b.attempt &&
  sameAddress(a.address, b.address)

export interface RemoteConnectionsShape {
  /** Every held connection's Messages. */
  readonly messages: Stream.Stream<Message>
  /**
   * Holds a connection for each of `engines`, made by `connect`: one already held for the same engine,
   * address and attempt is kept as it runs; the others are started, and those no longer wanted stopped.
   */
  readonly hold: (
    engines: Attempts,
    connect: (engine: Attempt) => Stream.Stream<Message>,
  ) => Effect.Effect<void>
}

export class RemoteConnections extends Context.Service<
  RemoteConnections,
  RemoteConnectionsShape
>()('@fabrica/ui/RemoteConnections') {}

/** The held connections, their fibers stopped with the scope. */
export const makeRemoteConnections = Effect.gen(function* () {
  const scope = yield* Effect.scope
  const queue = yield* Queue.unbounded<Message>()
  const lock = yield* Semaphore.make(1)
  const held = new Map<
    EngineName,
    { readonly engine: Attempt; readonly fiber: Fiber.Fiber<void> }
  >()

  const hold: RemoteConnectionsShape['hold'] = (engines, connect) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          for (const [name, running] of held) {
            const wanted = engines.find(engine => engine.name === name)
            if (wanted === undefined || !sameAttempt(wanted, running.engine)) {
              held.delete(name)
              yield* Fiber.interrupt(running.fiber)
            }
          }
          for (const engine of engines) {
            if (!held.has(engine.name)) {
              const fiber = yield* connect(engine).pipe(
                Stream.runForEach(message => Queue.offer(queue, message)),
                Effect.forkIn(scope),
              )
              held.set(engine.name, { engine, fiber })
            }
          }
        }),
      )
      .pipe(Effect.uninterruptible)

  return RemoteConnections.of({ messages: Stream.fromQueue(queue), hold })
})

export const layerRemoteConnections = Layer.effect(
  RemoteConnections,
  makeRemoteConnections,
)
