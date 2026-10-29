import { Effect, Layer, Option } from 'effect'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { SocketServer } from 'effect/socket'
import { chmod, lstat, unlink } from 'node:fs/promises'

import { NodeSocketServer } from '@effect/platform-node'
import { FabricaRpcs } from '@fabrica/contracts'

import { attentionHandlers } from './attention'
import { backlogHandlers } from './backlog'
import { engineHandlers } from './engine'
import { insightsHandlers } from './insights'
import { projectsHandlers } from './projects'
import { reviewHandlers } from './review'
import { runsHandlers } from './runs'
import { secretsHandlers } from './secrets'
import { talksHandlers } from './talks'
import { tokensHandlers } from './tokens'
import { workersHandlers } from './workers'

// The RPC server (spec §8.1, §8.2, §20.2): the protocol served on the engine's local socket, as NDJSON,
// with one handler layer per group, each in its own file. The socket is made mode 0600 before the
// server takes its first connection, in a folder only the engine's user can enter. A request's
// defect (a group not served yet, a fault) ends that request, never its client's connection.

/** Every group's handlers. */
export const protocolHandlers = Layer.mergeAll(
  engineHandlers,
  tokensHandlers,
  secretsHandlers,
  projectsHandlers,
  backlogHandlers,
  runsHandlers,
  workersHandlers,
  attentionHandlers,
  talksHandlers,
  reviewHandlers,
  insightsHandlers,
)

/** A socket server listening at `path`, a socket only its user can connect to. */
const localSocketServer = (path: string) =>
  Layer.effect(
    SocketServer.SocketServer,
    Effect.gen(function* () {
      const server = yield* NodeSocketServer.make({ path })
      yield* Effect.tryPromise({
        try: () => chmod(path, 0o600),
        catch: cause =>
          new SocketServer.SocketServerError({
            reason: new SocketServer.SocketServerOpenError({ cause }),
          }),
      })
      return server
    }),
  )

/** Removes a socket an engine left at `path` when it ended without removing it; the caller holds the lock. */
export const removeStaleSocket = Effect.fn('RpcServer.removeStaleSocket')(
  function* (path: string) {
    const left = yield* Effect.tryPromise(() => lstat(path)).pipe(Effect.option)
    if (Option.isSome(left) && left.value.isSocket()) {
      yield* Effect.tryPromise(() => unlink(path)).pipe(Effect.ignore)
    }
  },
)

/** The protocol served at the local socket `path`, on the daemon's services. */
export const localRpcServer = (path: string) =>
  RpcServer.layer(FabricaRpcs, { disableFatalDefects: true }).pipe(
    Layer.provide(protocolHandlers),
    Layer.provide(
      RpcServer.layerProtocolSocketServer.pipe(
        Layer.provide([localSocketServer(path), RpcSerialization.layerNdjson]),
      ),
    ),
  )
