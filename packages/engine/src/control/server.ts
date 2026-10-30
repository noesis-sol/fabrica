import {
  Context,
  Data,
  type Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Redacted,
  type Scope,
  Stream,
} from 'effect'
import { Headers } from 'effect/http'
import { RpcServer } from 'effect/rpc'
import { SocketServer } from 'effect/socket'
import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import * as NodePath from 'node:path'

import * as NodeSocketServer from '@effect/platform-node-shared/NodeSocketServer'
import {
  ControlRpcs,
  ControlSocketVariable,
  ControlToken,
  ControlTokenHeader,
  ControlTokenVariable,
  ControlUnauthorized,
  type MergeStanding,
  type ProjectId,
  type SessionId,
  type TicketId,
  layerNdjson,
} from '@fabrica/contracts'

import { Checks } from '../checks'
import { Git } from '../git'
import { Wake } from '../time'
import { WorkGraph } from '../workgraph'
import type { Outcome } from './outcome'
import { Attention, CheckOwnPasses } from './ports'
import { drawToken, tokenMatches } from './token'
import { type CheckOwnRun, type ControlRole, makeTools } from './tools'

// The agent control server (spec §12.2, §12.3, §20.2): for each agent's session, a Unix socket of its
// own, mode 0600 in a folder only the engine's user can enter, serving the control group in the
// Schema RPC protocol (newline-delimited JSON). Every request's token is checked before it is read;
// the session's outcomes reach the run loop as one stream. Closing the session's scope closes the
// socket, interrupts the calls in flight and removes the socket's file.

/** One agent's session, as its control channel serves it. */
export interface ControlSession {
  readonly project: ProjectId
  readonly ticket: TicketId
  readonly session: SessionId
  /** The ticket's worker, or its verifier (§13.6). */
  readonly role: ControlRole
  readonly worktree: string
  /** The folder the socket is made in, created with mode 0700 where it isn't there. */
  readonly folder: string
  /** How long `ask_and_wait` holds the agent for an answer (`question_wait`), in time awake. */
  readonly questionWait: Duration.Input
  /** How `check_own` runs for it. */
  readonly checkOwn: CheckOwnRun
  /** Where its ticket stands in the merge queue, read when its gate asks (§12.6, H59). */
  readonly mergeStanding: Effect.Effect<MergeStanding>
}

/** An agent's control channel, open. */
export interface AgentControl {
  readonly socket: string
  readonly token: Redacted.Redacted<string>
  /** The variables the agent's environment gets for it: the socket's path and the token. */
  readonly environment: Readonly<Record<string, string>>
  /** The session's outcomes, in the order its tools published them; read by one reader. */
  readonly outcomes: Stream.Stream<Outcome>
}

/** The control socket couldn't be made or opened. */
export class ControlFailed extends Data.TaggedError('ControlFailed')<{
  readonly socket: string
  readonly reason: string
}> {
  override get message() {
    return `the control socket ${this.socket} couldn't be opened: ${this.reason}`
  }
}

/** The longest Unix socket path every platform takes: macOS's `sun_path` holds 104 bytes, its NUL among them. */
const maxSocketPath = 103

export interface ControlServerShape {
  /** Opens the session's control channel, for as long as the scope is open. */
  readonly open: (
    session: ControlSession,
  ) => Effect.Effect<AgentControl, ControlFailed, Scope.Scope>
}

export class ControlServer extends Context.Service<
  ControlServer,
  ControlServerShape
>()('@fabrica/engine/ControlServer') {}

const failed = (socket: string) => (cause: unknown) =>
  new ControlFailed({
    socket,
    reason: cause instanceof Error ? cause.message : String(cause),
  })

/** Makes the folder, only its owner let in, and clears a socket a closed session left at `socket`. */
const prepare = (folder: string, socket: string) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(folder, { recursive: true, mode: 0o700 })
      await chmod(folder, 0o700)
      const left = await lstat(socket).catch(() => undefined)
      if (left === undefined) return
      if (!left.isSocket())
        throw new Error('something other than a socket is at its path')
      await rm(socket)
    },
    catch: failed(socket),
  })

export const make = Effect.gen(function* () {
  const graph = yield* WorkGraph
  const git = yield* Git
  const checks = yield* Checks
  const wake = yield* Wake
  const passes = yield* CheckOwnPasses
  const attention = yield* Attention

  const open = Effect.fn('ControlServer.open')(function* (
    session: ControlSession,
  ) {
    const socket = NodePath.join(session.folder, `${session.ticket}.sock`)
    if (Buffer.byteLength(socket) > maxSocketPath)
      return yield* new ControlFailed({
        socket,
        reason: `its path is longer than ${maxSocketPath} bytes`,
      })
    yield* prepare(session.folder, socket)
    const token = yield* drawToken
    const outcomes = yield* Queue.unbounded<Outcome>()

    const tools = makeTools({
      ...session,
      graph,
      git,
      checks,
      wake,
      passes,
      attention,
      outcomes,
    })
    const handlers = ControlRpcs.toLayer(
      ControlRpcs.of({
        get_ticket: tools.getTicket,
        file_ticket: tools.fileTicket,
        ask_question: tools.askQuestion,
        add_note: tools.addNote,
        check_own: tools.checkOwn,
        finish: tools.finish,
        defer: tools.defer,
        wait_for: tools.waitFor,
        ask_and_wait: tools.askAndWait,
        verdict: tools.verdict,
        request_permission: tools.requestPermission,
        merge_standing: () => tools.mergeStanding,
        report_gate_decision: tools.reportGateDecision,
        report_unfinished: () => tools.reportUnfinished,
      }),
    )
    const checkToken = Layer.succeed(ControlToken)((effect, { headers }) =>
      Option.match(Headers.get(headers, ControlTokenHeader), {
        onNone: () => Effect.fail(new ControlUnauthorized()),
        onSome: given =>
          tokenMatches(token, given)
            ? effect
            : Effect.fail(new ControlUnauthorized()),
      }),
    )

    const server = yield* NodeSocketServer.make({ path: socket }).pipe(
      Effect.mapError(failed(socket)),
    )
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => rm(socket, { force: true })).pipe(Effect.ignore),
    )
    yield* Effect.tryPromise({
      try: () => chmod(socket, 0o600),
      catch: failed(socket),
    })
    yield* RpcServer.make(ControlRpcs, {
      concurrency: 'unbounded',
      disableFatalDefects: true,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(handlers, checkToken).pipe(
          Layer.provideMerge(
            RpcServer.layerProtocolSocketServer.pipe(
              Layer.provide(layerNdjson),
              Layer.provide(Layer.succeed(SocketServer.SocketServer)(server)),
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    )

    return {
      socket,
      token,
      environment: {
        [ControlSocketVariable]: socket,
        [ControlTokenVariable]: Redacted.value(token),
      },
      outcomes: Stream.fromQueue(outcomes),
    } satisfies AgentControl
  })

  return ControlServer.of({ open })
})

/** The control server, over the work graph, git, the checks, time awake, the passes and the attention service. */
export const layer: Layer.Layer<
  ControlServer,
  never,
  WorkGraph | Git | Checks | Wake | CheckOwnPasses | Attention
> = Layer.effect(ControlServer, make)
