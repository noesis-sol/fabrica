import { Context, Data, Effect, Layer, Option, Result, Schema } from 'effect'
import type { RpcClientError } from 'effect/rpc'
import type { Socket } from 'effect/socket'

import {
  type ClientOptions,
  type EngineClientShape,
  SshDestination,
  make,
} from '@fabrica/client'
import {
  SshPrompting,
  layerSsh,
  layerUnixSocket,
  sshFailed,
  sshReconnect,
} from '@fabrica/client/node'
import type { VersionMismatch } from '@fabrica/contracts'
import type { Daemon } from '@fabrica/engine'

import { version } from '../version'
import { EngineName } from './flags'

// How a command reaches its engine (spec §19, §8.2): the engine `--engine <name>` names, or the local
// one. The local engine is known by the name `local`, and its socket reaches it; an engine on another
// host is named by its SSH destination, `ssh://[user@]host[:port]`, and reached through the SSH bridge
// as the app reaches it, ssh asking on the terminal for what it needs, as it always does. A command
// talks to its engine through one client, said hello as the CLI, closed as the command ends.

/** The local engine's socket, found from the host as a command needs it. */
export class LocalEngine extends Context.Service<
  LocalEngine,
  { readonly socket: Effect.Effect<string, Daemon.UnsupportedPlatform> }
>()('@fabrica/engine-app/LocalEngine') {}

/** The name `--engine` gives the local engine. */
export const localEngineName = 'local'

/** How `--engine` names an engine reached through the SSH bridge: by its destination, as a URI. */
export const sshEnginePrefix = 'ssh://'

/** What ssh runs with: the user's environment, for their agent and config; a test gives its own. */
export const SshEnvironment = Context.Reference<{
  readonly env: Readonly<Record<string, string>>
}>('@fabrica/engine-app/SshEnvironment', {
  defaultValue: () => ({
    env: Object.fromEntries(
      Object.entries(process.env).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, value]],
      ),
    ),
  }),
})

/** The engine `--engine` names. */
export type EngineTarget = Data.TaggedEnum<{
  /** The local engine, through its socket. */
  Local: {}
  /** An engine through the SSH bridge to `destination`. */
  Ssh: { readonly destination: SshDestination }
}>
export const EngineTarget = Data.taggedEnum<EngineTarget>()

const decodeDestination = Schema.decodeUnknownOption(SshDestination)

/** `--engine` names an engine the CLI doesn't know. */
export class UnknownEngine extends Data.TaggedError('UnknownEngine')<{
  readonly name: string
}> {
  override get message() {
    return `no engine named ${this.name} is known: name the local engine (${localEngineName}), or one on another host by its SSH destination (${sshEnginePrefix}[user@]host[:port])`
  }
}

/** No engine answers on the socket. */
export class EngineUnreachable extends Data.TaggedError('EngineUnreachable')<{
  readonly socket: string
}> {
  override get message() {
    return `no engine answers at ${this.socket}: start one with \`fabrica serve\``
  }
}

/** No engine answered through ssh, which ended no other way. */
export class EngineUnreachableOverSsh extends Data.TaggedError(
  'EngineUnreachableOverSsh',
)<{
  readonly destination: string
}> {
  override get message() {
    return `no engine answered through ssh at ${this.destination}`
  }
}

/** The connection to the engine was lost before it answered. */
export class EngineLost extends Data.TaggedError('EngineLost')<{
  /** Where the engine was: its socket, or its SSH destination. */
  readonly at: string
}> {
  override get message() {
    return `the connection to the engine at ${this.at} was lost`
  }
}

/** The engine and the CLI share no protocol version: one must be updated. */
export class EngineRefused extends Data.TaggedError('EngineRefused')<{
  readonly mismatch: VersionMismatch
}> {
  override get message() {
    const { client, engine, update } = this.mismatch
    return update === 'client'
      ? `the engine speaks protocol ${engine}, too new for this fabrica (protocol ${client}): update fabrica`
      : `the engine speaks protocol ${engine}, too old for this fabrica (protocol ${client}): update the engine`
  }
}

/** The engine `--engine` names: the local one where it isn't given. */
export const resolveEngine = (
  name: Option.Option<string>,
): Result.Result<EngineTarget, UnknownEngine> =>
  Option.match(name, {
    onNone: () => Result.succeed(EngineTarget.Local()),
    onSome: given => {
      if (given === localEngineName) {
        return Result.succeed(EngineTarget.Local())
      }
      const destination = given.startsWith(sshEnginePrefix)
        ? decodeDestination(given)
        : Option.none()
      return Option.match(destination, {
        onNone: () => Result.fail(new UnknownEngine({ name: given })),
        onSome: valid =>
          Result.succeed(EngineTarget.Ssh({ destination: valid })),
      })
    },
  })

/** How the CLI says hello. */
const cliOptions: ClientOptions = {
  name: 'fabrica CLI',
  kind: 'cli',
  release: version,
}

/** A client of the local engine, and where it is. */
const localClient = Effect.gen(function* () {
  const local = yield* LocalEngine
  const socket = yield* local.socket
  const client = yield* clientOver(layerUnixSocket(socket), {
    unreachable: () => new EngineUnreachable({ socket }),
  })
  return { client, at: socket }
})

/** A client of the engine at `destination`, through the SSH bridge, and where it is. */
const sshClient = (destination: SshDestination) =>
  Effect.gen(function* () {
    const { env } = yield* SshEnvironment
    const client = yield* clientOver(
      layerSsh({ destination, env, prompting: SshPrompting.Terminal() }),
      {
        unreachable: error =>
          Option.getOrElse(
            sshFailed(error),
            () => new EngineUnreachableOverSsh({ destination }),
          ),
        reconnect: sshReconnect(),
      },
    )
    return { client, at: destination }
  })

/** A client over `transport`, said hello: failing with `unreachable`'s error where no engine answers. */
const clientOver = <E>(
  transport: Layer.Layer<Socket.Socket>,
  options: {
    readonly unreachable: (error: RpcClientError.RpcClientError) => E
    readonly reconnect?: ClientOptions['reconnect']
  },
) =>
  make({
    ...cliOptions,
    ...(options.reconnect === undefined
      ? {}
      : { reconnect: options.reconnect }),
  }).pipe(
    Effect.provide(transport),
    Effect.catchTags({
      RpcClientError: error => Effect.fail(options.unreachable(error)),
      VersionMismatch: mismatch => Effect.fail(new EngineRefused({ mismatch })),
    }),
  )

/** Runs `use` with a client of the engine `--engine` names, closed as `use` ends. */
export const withEngine = <A, E, R>(
  use: (
    client: EngineClientShape,
  ) => Effect.Effect<A, E | RpcClientError.RpcClientError, R>,
) =>
  Effect.gen(function* () {
    const target = yield* Effect.fromResult(resolveEngine(yield* EngineName))
    const { client, at } = yield* EngineTarget.$match(target, {
      Local: () => localClient,
      Ssh: ({ destination }) => sshClient(destination),
    })
    return yield* use(client).pipe(
      Effect.catchTag('RpcClientError', () =>
        Effect.fail(new EngineLost({ at })),
      ),
    )
  }).pipe(Effect.scoped)
