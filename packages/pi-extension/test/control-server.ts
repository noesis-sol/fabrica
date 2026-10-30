import { Effect, Layer, Option, Schema } from 'effect'
import { Headers } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { SocketServer } from 'effect/socket'
import { join } from 'node:path'

import * as NodeSocketServer from '@effect/platform-node-shared/NodeSocketServer'
import {
  CheckOwnRan,
  ControlRpcs,
  ControlToken,
  ControlTokenHeader,
  ControlUnauthorized,
  Filed,
  NoteId,
  Noted,
  PermissionDecision,
  TicketId,
  TicketView,
  ToolRefusal,
} from '@fabrica/contracts'

// The engine's side of an agent's control channel, for the extension's tests: a control server on a
// real Unix socket that checks the session's token and answers every request as the engine would,
// recording each call the tests look at.

export const own = TicketId.make('fab-own.1')
export const other = TicketId.make('fab-other.2')

/** The worker's ticket, as `get_ticket` shows it. */
export const ownView = Schema.decodeUnknownSync(TicketView)({
  ticket: {
    id: own,
    type: 'task',
    title: 'Build the extension',
    description: null,
    design: null,
    acceptance: null,
    status: 'in_progress',
    resolution: null,
    priority: 1,
    deferUntil: null,
    assignee: null,
    model: null,
    metadata: {},
    result: null,
    question: null,
    mergedCommit: null,
    closeReason: null,
    createdAt: 0,
    updatedAt: 0,
  },
  labels: [],
  notes: [],
  edges: [],
  dependencies: [],
})

/** A call the control server answered: the request's tag and its payload. */
export interface Call {
  readonly rpc: string
  readonly payload: unknown
}

export type Answers = Parameters<typeof ControlRpcs.of>[0]

/** The note the maintainer refuses every permission request with. */
export const RefusalNote = 'Keep to the worktree.'

/**
 * The engine's answers, each call recorded in `calls`: `finish` refused when `dirty`, and every
 * permission request refused with `RefusalNote`.
 */
export const answers = (
  calls: Array<Call>,
  { dirty }: { readonly dirty: boolean },
): Answers => {
  const record = (rpc: string, payload: unknown) =>
    Effect.sync(() => {
      calls.push({ rpc, payload })
    })
  const ended = (rpc: string) => (payload: unknown) =>
    Effect.as(record(rpc, payload), {})
  return {
    get_ticket: payload => Effect.as(record('get_ticket', payload), ownView),
    file_ticket: payload =>
      Effect.as(
        record('file_ticket', payload),
        new Filed({ id: TicketId.make('fab-new.1') }),
      ),
    ask_question: payload =>
      Effect.as(
        record('ask_question', payload),
        new Filed({ id: TicketId.make('fab-question.1') }),
      ),
    add_note: payload =>
      Effect.as(
        record('add_note', payload),
        new Noted({ id: NoteId.make('note-1') }),
      ),
    check_own: payload =>
      Effect.as(
        record('check_own', payload),
        CheckOwnRan.cases.not_run.make({ reason: 'no check_own is set' }),
      ),
    finish: payload =>
      dirty
        ? Effect.andThen(
            record('finish', payload),
            Effect.fail(
              ToolRefusal.cases.worktree_dirty.make({
                uncommitted: ['src/a.ts'],
                untracked: ['notes.txt'],
              }),
            ),
          )
        : ended('finish')(payload),
    defer: ended('defer'),
    wait_for: ended('wait_for'),
    verdict: ended('verdict'),
    ask_and_wait: payload =>
      Effect.as(record('ask_and_wait', payload), {
        _tag: 'unanswered' as const,
        question: TicketId.make('fab-question.1'),
      }),
    request_permission: payload =>
      Effect.as(
        record('request_permission', payload),
        PermissionDecision.cases.refuse.make({
          note: Option.some(RefusalNote),
        }),
      ),
    merge_standing: () => Effect.succeed('not_queued'),
    report_gate_decision: payload =>
      Effect.asVoid(record('report_gate_decision', payload)),
    report_unfinished: payload =>
      Effect.asVoid(record('report_unfinished', payload)),
  }
}

/** The session's token, which every request carries. */
export const token = 'session-token'

/** A control server on a socket in `folder`, checking `token`, answering as `handlers` does. */
export const serve = Effect.fn(function* (folder: string, handlers: Answers) {
  const socket = join(folder, 'control.sock')
  const server = yield* NodeSocketServer.make({ path: socket })
  const checkToken = Layer.succeed(ControlToken)((effect, { headers }) =>
    Option.contains(Headers.get(headers, ControlTokenHeader), token)
      ? effect
      : Effect.fail(new ControlUnauthorized()),
  )
  yield* RpcServer.make(ControlRpcs, {
    concurrency: 'unbounded',
    disableFatalDefects: true,
  }).pipe(
    Effect.provide(
      ControlRpcs.toLayer(ControlRpcs.of(handlers)).pipe(
        Layer.provideMerge(checkToken),
        Layer.provideMerge(
          RpcServer.layerProtocolSocketServer.pipe(
            Layer.provide(RpcSerialization.layerNdjson),
            Layer.provide(Layer.succeed(SocketServer.SocketServer)(server)),
          ),
        ),
      ),
    ),
    Effect.forkScoped,
  )
  return socket
})
