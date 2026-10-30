import { Effect, Option, Result } from 'effect'

import type { Actor, SessionId, TicketId } from '@fabrica/contracts'

import { type HandBackWorkerShape, WorkerAnswer } from '../merge/handbacks'
import { WorkGraph } from '../workgraph'
import { HandBackEnd, type Supervision } from './supervisor'
import {
  type WorkerContext,
  WorkerEnd,
  WorkerTurn,
  dispatchWorker,
  modelOf,
} from './worker'

// The run's workers as the merge queue's hand-backs reach them (spec §13.7): a hand-back resumes the
// session the ticket's dispatch saved (Pi's `switch_session` on its file), on the model that wrote it,
// with a control channel and a proxy token of its own under the session its claim names, and gives it
// the hand-back's prompt under the run's supervision, waiting for its turn: a finish settles it (git
// says what it did), a defer defers it, a turn refused at the usage limit ends there once the run
// holds for it, and a session that can't resume or is stopped leaves it unavailable. Interrupted, the
// turn is aborted with the agent's scope. A stopped turn's closing message is noted on its ticket.

/** What a hand-back's worker, come out as `end`, answers the merge queue. */
export const answerOf = (end: HandBackEnd): WorkerAnswer =>
  HandBackEnd.$match(end, {
    AtLimit: () => WorkerAnswer.AtLimit(),
    Ended: ({ end: came }) =>
      WorkerEnd.$match(came, {
        Finished: () => WorkerAnswer.Settled(),
        // Settled through another outcome, or none: git says what it did.
        WaitsFor: () => WorkerAnswer.Settled(),
        Asked: () => WorkerAnswer.Settled(),
        Unfinished: () => WorkerAnswer.Settled(),
        Deferred: ({ reason }) => WorkerAnswer.Deferred({ reason }),
        SetAside: ({ note }) =>
          WorkerAnswer.Unavailable({
            reason: `its supervision stopped its worker: ${note}`,
          }),
        ToolFailed: ({ tool, reason }) =>
          WorkerAnswer.Unavailable({
            reason: `its worker's ${tool} tool failed in the engine: ${reason}`,
          }),
        SetupFailed: ({ detail }) =>
          WorkerAnswer.Unavailable({
            reason: `its worktree's setup failed: ${detail}`,
          }),
        NotStarted: ({ reason }) =>
          WorkerAnswer.Unavailable({
            reason: `its worker's session didn't resume: ${reason}`,
          }),
        Failed: ({ reason }) =>
          WorkerAnswer.Unavailable({ reason: `its worker failed: ${reason}` }),
      }),
  })

/**
 * The run's hand-back worker, on the services it is made with: `drawSession` gives the session of a
 * ticket whose claim names none.
 */
export const makeHandBackWorker = Effect.fnUntraced(function* (input: {
  readonly context: WorkerContext
  readonly supervision: Supervision
  readonly actor: Actor
  readonly drawSession: Effect.Effect<SessionId>
}) {
  const { context, supervision, actor } = input
  const services = yield* Effect.context<
    Effect.Services<ReturnType<typeof dispatchWorker>> | WorkGraph
  >()
  const graph = yield* WorkGraph

  /** The session its claim names, and its own model, the ticket read once. */
  const claimOf = (ticket: TicketId) =>
    Effect.gen(function* () {
      const { ticket: taken } = yield* graph.show(ticket)
      const session = yield* Option.match(taken.assignee, {
        onNone: () => input.drawSession,
        onSome: ({ session: claimed }) => Effect.succeed(claimed),
      })
      return { session, model: modelOf(taken, context.started) }
    })

  const give: HandBackWorkerShape['give'] = ({ ticket, worktree, prompt }) =>
    Effect.gen(function* () {
      const [saved, claim] = yield* Effect.all(
        [context.sessions.saved(ticket), Effect.result(claimOf(ticket))],
        { concurrency: 2 },
      )
      if (Option.isNone(saved))
        return WorkerAnswer.Unavailable({
          reason: 'its worker has no saved session to resume',
        })
      if (Result.isFailure(claim))
        return WorkerAnswer.Unavailable({
          reason: `its ticket couldn't be read: ${claim.failure.message}`,
        })
      const { session, model } = claim.success
      const end = yield* supervision.handBack({
        ticket,
        session,
        turn: WorkerTurn.HandBack({
          worktree,
          session: Option.some(saved.value.session),
          prompt,
        }),
        model,
        run: attempt => dispatchWorker(context, ticket, session, attempt),
      })
      return answerOf(end)
    }).pipe(Effect.provideContext(services))

  const tell: HandBackWorkerShape['tell'] = ({ ticket, message }) =>
    graph.note({ id: ticket, body: message, actor }).pipe(
      Effect.asVoid,
      Effect.catch(error =>
        Effect.logWarning(
          `Couldn't note the end of ${ticket}'s hand-back on it`,
          error,
        ),
      ),
    )

  return { give, tell } satisfies HandBackWorkerShape
})
