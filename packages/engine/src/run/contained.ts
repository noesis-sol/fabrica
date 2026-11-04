import { Effect, Option, type Scope } from 'effect'
import { mkdir } from 'node:fs/promises'
import * as NodePath from 'node:path'

import type { TicketId } from '@fabrica/contracts'

import {
  type AgentContainer,
  AgentStartFailed,
  AgentStartFailure,
  type Mount,
  type PreparedContainers,
  controlAddressOf,
  hostAddressOf,
  reachedAt,
  samePath,
} from '../agent'
import { checksFolder } from '../checks/command'
import { ControlTransport } from '../control'
import { Git } from '../git'
import { type AgentProxy, ModelProxy } from '../proxy'

// What a run gives an agent for its container (spec §12.7): how the agent reaches the control channel
// and the model proxy from inside, on the runtime the start chose (fab-mgi.60, .61), and what is
// mounted beyond its own folders: the worktree's git folder, where its commits go, with its hooks and
// configuration read-only, as the engine's own git reads those on the host; the checks' logs `check_own`
// names; and the channel's and the proxy's sockets where a mounted socket is the way. And who the host's
// git says commits, since the user's git configuration stays on the host.

/** How the agent reaches its control channel: the socket, on every placement but one (fab-mgi.61). */
export const controlTransportOf = ({
  containers,
}: {
  readonly containers: Option.Option<PreparedContainers>
}): ControlTransport =>
  Option.match(
    Option.flatMap(containers, ({ placement }) => controlAddressOf(placement)),
    {
      onNone: () => ControlTransport.Unix(),
      onSome: address => ControlTransport.Tcp({ reachedAt: address }),
    },
  )

/** The providers the agent's Pi is pointed at, and its container, where the project has one. */
export const containedAgent = Effect.fn('Run.containedAgent')(function* ({
  ticket,
  checkout,
  worktree,
  sockets,
  containers,
  channel,
  granted,
}: {
  readonly ticket: TicketId
  readonly checkout: string
  readonly worktree: string
  readonly sockets: string
  readonly containers: Option.Option<PreparedContainers>
  readonly channel: { readonly socket: string }
  readonly granted: AgentProxy
}): Effect.fn.Return<
  {
    readonly providers: AgentProxy['providers']
    readonly container: { readonly container?: AgentContainer }
  },
  AgentStartFailed,
  Git | ModelProxy | Scope.Scope
> {
  if (Option.isNone(containers))
    return { providers: granted.providers, container: {} }
  const prepared = containers.value
  const failed = (doing: string) => (error: { readonly message: string }) =>
    new AgentStartFailed({
      ticket,
      reason: AgentStartFailure.Container({
        message: `${doing}: ${error.message}`,
      }),
    })
  const git = yield* Git
  const proxy = yield* ModelProxy
  const place = yield* git
    .checkoutOf({ folder: worktree })
    .pipe(Effect.mapError(failed("the worktree's git folder wasn't found")))
  if (Option.isNone(place))
    return yield* failed("the worktree's git folder wasn't found")({
      message: `${worktree} isn't in a repository`,
    })
  const { commonDir } = place.value
  const [name, email] = yield* Effect.all(
    [
      git.configValue({ repo: worktree, name: 'user.name' }),
      git.configValue({ repo: worktree, name: 'user.email' }),
    ],
    { concurrency: 'unbounded' },
  ).pipe(Effect.mapError(failed("the host's git identity wasn't read")))
  const hooks = NodePath.join(commonDir, 'hooks')
  const logs = NodePath.join(checkout, checksFolder)
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(hooks, { recursive: true })
      await mkdir(logs, { recursive: true })
    },
    catch: error => ({
      message: error instanceof Error ? error.message : String(error),
    }),
  }).pipe(Effect.mapError(failed("the container's mounts couldn't be made")))
  const hostAddress = hostAddressOf(prepared.placement)
  const proxySocket = NodePath.join(sockets, `${ticket}.p.sock`)
  if (Option.isNone(hostAddress))
    yield* proxy
      .listenOn(proxySocket)
      .pipe(Effect.mapError(failed("the model proxy's socket didn't open")))
  const mounts: ReadonlyArray<Mount> = [
    samePath(commonDir),
    samePath(hooks, true),
    samePath(NodePath.join(commonDir, 'config'), true),
    samePath(logs, true),
    ...(Option.isNone(controlAddressOf(prepared.placement))
      ? [samePath(channel.socket)]
      : []),
    ...(Option.isNone(hostAddress) ? [samePath(proxySocket)] : []),
  ]
  return {
    providers: Option.match(hostAddress, {
      // The relay serves the proxy on its own port at the container's 127.0.0.1, so its URLs hold.
      onNone: () => granted.providers,
      onSome: host =>
        granted.providers.map(entry => ({
          ...entry,
          baseUrl: reachedAt(entry.baseUrl, host),
        })),
    }),
    container: {
      container: {
        prepared,
        mounts,
        identity: { name, email },
        relay: Option.isNone(hostAddress)
          ? Option.some({
              port: new URL(proxy.address).port,
              socket: proxySocket,
            })
          : Option.none(),
      },
    },
  }
})
