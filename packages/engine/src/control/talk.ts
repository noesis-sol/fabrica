import { Effect, Option, Redacted, type Scope } from 'effect'

import {
  ControlSocketVariable,
  ControlTokenVariable,
  PermissionDecision,
  type TalkId,
  ToolRefusal,
} from '@fabrica/contracts'

import {
  type AgentControl,
  type ControlFailed,
  type ControlHandlers,
  openSocket,
  serveControl,
} from './server'
import { drawToken } from './token'

// A talk's control channel (spec §12.2, §15.4, §20.2): a Unix socket of the talk's own, served as a
// worker's is, whose token reaches nothing but the talk's mode's tools, each call handed to the engine's
// side of it by name. A talk has no ticket, no work graph of its own and no maintainer to ask on a
// call's behalf: every worker's tool is refused, it never stands in the merge queue, and whatever the
// gate would ask about is refused, for a talk only reads.

/** Refuses a call to a tool of a worker's, a verifier's or an organ's. */
const notATalks = (tool: string) => () =>
  Effect.fail(
    ToolRefusal.cases.invalid.make({ issue: `${tool} isn't a talk's tool` }),
  )

/** Opens the talk's control channel, for as long as the scope is open. */
export const openTalkControl = Effect.fn('Control.openTalk')(function* ({
  talk,
  folder,
  call,
}: {
  readonly talk: TalkId
  /** The folder the socket is made in, created with mode 0700 where it isn't there. */
  readonly folder: string
  /** The engine's side of a call to one of the mode's tools: its answer, encoded, or why it was refused. */
  readonly call: (options: {
    readonly tool: string
    readonly input: unknown
  }) => Effect.Effect<unknown, ToolRefusal>
}): Effect.fn.Return<
  Omit<AgentControl, 'outcomes'>,
  ControlFailed,
  Scope.Scope
> {
  const token = yield* drawToken
  const { server, socket } = yield* openSocket({ folder, name: talk })
  const handlers: ControlHandlers = {
    get_ticket: notATalks('get_ticket'),
    file_ticket: notATalks('file_ticket'),
    ask_question: notATalks('ask_question'),
    add_note: notATalks('add_note'),
    check_own: notATalks('check_own'),
    finish: notATalks('finish'),
    defer: notATalks('defer'),
    wait_for: notATalks('wait_for'),
    ask_and_wait: notATalks('ask_and_wait'),
    verdict: notATalks('verdict'),
    answer: notATalks('answer'),
    file_root: notATalks('file_root'),
    talk_tool: ({ tool, input }) =>
      call({ tool, input }).pipe(
        Effect.tapDefect(defect =>
          Effect.logError(
            `the talk ${talk}'s ${tool} failed: ${String(defect)}`,
          ),
        ),
        Effect.withSpan('Control.talk_tool'),
      ),
    request_permission: ({ tool }) =>
      Effect.succeed(
        PermissionDecision.cases.refuse.make({
          note: Option.some(`A talk only reads: it has no use of ${tool}.`),
        }),
      ),
    merge_standing: () => Effect.succeed('not_queued'),
    report_gate_decision: ({ tool, verdict }) =>
      Effect.logInfo(`gate ${verdict._tag}: ${tool}`).pipe(
        Effect.annotateLogs({ talk }),
      ),
    report_unfinished: () => Effect.void,
  }
  yield* serveControl({ handlers, token, server })
  return {
    socket,
    token,
    environment: {
      [ControlSocketVariable]: socket,
      [ControlTokenVariable]: Redacted.value(token),
    },
  }
})
