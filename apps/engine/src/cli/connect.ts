import { Context, Data, Effect, Layer, Option, Schema } from 'effect'
import { RpcClientError } from 'effect/rpc'
import type { Socket } from 'effect/socket'

import {
  type ClientOptions,
  type EngineClientShape,
  SshDestination,
  type WslDistro,
  isDefect,
  make,
  tlsEndpointText,
} from '@fabrica/client'
import {
  SshPrompting,
  type TlsEngine,
  layerSsh,
  layerTls,
  layerUnixSocket,
  layerWsl,
  sshFailed,
  sshReconnect,
  tlsReconnect,
  tlsRefused,
  wslFailed,
  wslReconnect,
} from '@fabrica/client/node'
import type { VersionMismatch } from '@fabrica/contracts'
import type { Daemon } from '@fabrica/engine'

import { version } from '../version'
import { EngineName } from './flags'
import { EngineReach, findKnownEngine, localEngineName } from './known-engines'

// How a command reaches its engine (spec §19, §8.2): the engine `--engine <name>` names, or the local
// one. The local engine is known by the name `local`, and its socket reaches it; an engine on another
// host is named by its SSH destination, `ssh://[user@]host[:port]`, and reached through the SSH bridge
// as the app reaches it, ssh asking on the terminal for what it needs, as it always does. Any other
// name is looked up among the engines `fabrica engine add` keeps (`known-engines.ts`), each reached as
// the app reaches it: through the SSH bridge, the WSL2 bridge, or TLS with its pinned certificate and
// token. A command talks to its engine through one client, said hello as the CLI, closed as the
// command ends.

/** The local engine's socket, found from the host as a command needs it. */
export class LocalEngine extends Context.Service<
  LocalEngine,
  { readonly socket: Effect.Effect<string, Daemon.UnsupportedPlatform> }
>()('@fabrica/engine-app/LocalEngine') {}

/** How `--engine` names an engine reached through the SSH bridge: by its destination, as a URI. */
export const sshEnginePrefix = 'ssh://'

/** What ssh and wsl.exe run with: the user's environment, for their agent and config; a test gives its own. */
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
  /** An engine through the bridge in the WSL2 distribution `distro`. */
  Wsl: { readonly distro: WslDistro }
  /** An engine paired over TLS. */
  Tls: { readonly engine: TlsEngine }
}>
export const EngineTarget = Data.taggedEnum<EngineTarget>()

const decodeDestination = Schema.decodeUnknownOption(SshDestination)

/** `--engine` names an engine the CLI doesn't know. */
export class UnknownEngine extends Data.TaggedError('UnknownEngine')<{
  readonly name: string
}> {
  override get message() {
    return `no engine named ${this.name} is known: name the local engine (${localEngineName}), one \`fabrica engine add\` keeps, or one on another host by its SSH destination (${sshEnginePrefix}[user@]host[:port])`
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

/** No engine answered through wsl.exe, which ended no other way. */
export class EngineUnreachableOverWsl extends Data.TaggedError(
  'EngineUnreachableOverWsl',
)<{
  readonly distro: string
}> {
  override get message() {
    return `no engine answered through wsl.exe in the WSL distribution ${this.distro}`
  }
}

/** No engine answered over TLS, and none refused the certificate or the token. */
export class EngineUnreachableOverTls extends Data.TaggedError(
  'EngineUnreachableOverTls',
)<{
  readonly address: string
}> {
  override get message() {
    return `no engine answered over TLS at ${this.address}`
  }
}

/** The connection to the engine was lost before it answered. */
export class EngineLost extends Data.TaggedError('EngineLost')<{
  /** Where the engine was: its socket, its SSH destination, its WSL2 distribution or its TLS address. */
  readonly at: string
}> {
  override get message() {
    return `the connection to the engine at ${this.at} was lost`
  }
}

/** The engine answered with a defect: a request it doesn't serve yet, or one it failed serving. */
export class EngineFailed extends Data.TaggedError('EngineFailed')<{
  /** Where the engine was: its socket, its SSH destination, its WSL2 distribution or its TLS address. */
  readonly at: string
  /** The defect, in words. */
  readonly reason: string
}> {
  override get message() {
    return `the engine at ${this.at} couldn't answer: ${this.reason}`
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

/** How a known engine is reached, as a target. */
const targetOf = (reach: EngineReach): EngineTarget =>
  EngineReach.match<EngineTarget>(reach, {
    Ssh: ({ destination }) => EngineTarget.Ssh({ destination }),
    Wsl: ({ distro }) => EngineTarget.Wsl({ distro }),
    Tls: engine => EngineTarget.Tls({ engine }),
  })

/** The engine `--engine` names: the local one where it isn't given. */
export const resolveEngine = (name: Option.Option<string>) =>
  Option.match(name, {
    onNone: () => Effect.succeed(EngineTarget.Local()),
    onSome: given => {
      if (given === localEngineName) {
        return Effect.succeed(EngineTarget.Local())
      }
      if (given.startsWith(sshEnginePrefix)) {
        return Option.match(decodeDestination(given), {
          onNone: () => Effect.fail(new UnknownEngine({ name: given })),
          onSome: destination =>
            Effect.succeed(EngineTarget.Ssh({ destination })),
        })
      }
      return Effect.flatMap(
        findKnownEngine(given),
        Option.match({
          onNone: () => Effect.fail(new UnknownEngine({ name: given })),
          onSome: ({ reach }) => Effect.succeed(targetOf(reach)),
        }),
      )
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

/** A client of the engine in the WSL2 distribution `distro`, through its bridge, and where it is. */
const wslClient = (distro: WslDistro) =>
  Effect.gen(function* () {
    const { env } = yield* SshEnvironment
    const client = yield* clientOver(layerWsl({ distro, env }), {
      unreachable: error =>
        Option.getOrElse(
          wslFailed(error),
          () => new EngineUnreachableOverWsl({ distro }),
        ),
      reconnect: wslReconnect(),
    })
    return { client, at: `WSL ${distro}` }
  })

/** A client of the engine paired over TLS, its certificate checked against the pin, and where it is. */
const tlsClient = (engine: TlsEngine) =>
  Effect.gen(function* () {
    const at = tlsEndpointText(engine)
    const client = yield* clientOver(layerTls(engine), {
      unreachable: error =>
        Option.getOrElse(
          tlsRefused(error),
          () => new EngineUnreachableOverTls({ address: at }),
        ),
      reconnect: tlsReconnect(),
    })
    return { client, at }
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
    const target = yield* resolveEngine(yield* EngineName)
    const { client, at } = yield* EngineTarget.$match(target, {
      Local: () => localClient,
      Ssh: ({ destination }) => sshClient(destination),
      Wsl: ({ distro }) => wslClient(distro),
      Tls: ({ engine }) => tlsClient(engine),
    })
    return yield* use(client).pipe(
      Effect.catchTag('RpcClientError', error =>
        Effect.fail(
          error instanceof RpcClientError.RpcClientError && isDefect(error)
            ? new EngineFailed({ at, reason: error.reason.message })
            : new EngineLost({ at }),
        ),
      ),
    )
  }).pipe(Effect.scoped)
