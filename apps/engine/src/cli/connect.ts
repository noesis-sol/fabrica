import { Context, Data, Effect, Option, Result } from 'effect'
import type { RpcClientError } from 'effect/rpc'

import { type EngineClientShape, make } from '@fabrica/client'
import { layerUnixSocket } from '@fabrica/client/node'
import type { VersionMismatch } from '@fabrica/contracts'
import type { Daemon } from '@fabrica/engine'

import { version } from '../version'
import { EngineName } from './flags'

// How a command reaches its engine (spec §19, §8.2): the engine `--engine <name>` names, or the local
// one. Known engines (SSH, WSL2, TLS) are reached as the app reaches them once their tickets add them;
// until then the local engine is the only one known, by the name `local`, and its socket reaches it.
// A command talks to its engine through one client, said hello as the CLI, closed as the command ends.

/** The local engine's socket, found from the host as a command needs it. */
export class LocalEngine extends Context.Service<
  LocalEngine,
  { readonly socket: Effect.Effect<string, Daemon.UnsupportedPlatform> }
>()('@fabrica/engine-app/LocalEngine') {}

/** The name `--engine` gives the local engine. */
export const localEngineName = 'local'

/** `--engine` names an engine the CLI doesn't know. */
export class UnknownEngine extends Data.TaggedError('UnknownEngine')<{
  readonly name: string
}> {
  override get message() {
    return `no engine named ${this.name} is known: only the local engine (${localEngineName}) is, yet`
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

/** The connection to the engine was lost before it answered. */
export class EngineLost extends Data.TaggedError('EngineLost')<{
  readonly socket: string
}> {
  override get message() {
    return `the connection to the engine at ${this.socket} was lost`
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

/** Whether `--engine` names the local engine: where it isn't given, or names it. */
export const resolveEngine = (
  name: Option.Option<string>,
): Result.Result<void, UnknownEngine> =>
  Option.match(name, {
    onNone: () => Result.void,
    onSome: given =>
      given === localEngineName
        ? Result.void
        : Result.fail(new UnknownEngine({ name: given })),
  })

/** Runs `use` with a client of the engine `--engine` names, closed as `use` ends. */
export const withEngine = <A, E, R>(
  use: (
    client: EngineClientShape,
  ) => Effect.Effect<A, E | RpcClientError.RpcClientError, R>,
) =>
  Effect.gen(function* () {
    yield* Effect.fromResult(resolveEngine(yield* EngineName))
    const local = yield* LocalEngine
    const socket = yield* local.socket
    const client = yield* make({
      name: 'fabrica CLI',
      kind: 'cli',
      release: version,
    }).pipe(
      Effect.provide(layerUnixSocket(socket)),
      Effect.catchTags({
        RpcClientError: () => Effect.fail(new EngineUnreachable({ socket })),
        VersionMismatch: mismatch =>
          Effect.fail(new EngineRefused({ mismatch })),
      }),
    )
    return yield* use(client).pipe(
      Effect.catchTag('RpcClientError', () =>
        Effect.fail(new EngineLost({ socket })),
      ),
    )
  }).pipe(Effect.scoped)
