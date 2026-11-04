import { DateTime, Effect, Option } from 'effect'

import {
  AttentionRequest,
  type ProjectId,
  type ReviewRequest,
  type RunEvent,
  type SetAsideReason,
  type Ticket,
  type TicketEvent,
  type TicketId,
} from '@fabrica/contracts'

import type { WorkGraphShape } from '../workgraph'

// The tickets runs have set aside, read from what outlasts a run (spec §15.1, §18.3), so a Review card
// stays past its run's end and an engine's restart. The work graph says which: a deferred ticket whose
// last deferral was a run's, its engine's or its worker's. A ticket the maintainer or a talk deferred
// was set aside by no run, and one the maintainer defers again has been looked at. The project's event
// stream says why: the ticket's last `deferred` record, where that came after the deferral; a run cut
// off between the two wrote none, and says only that the ticket is deferred. The stream can be long and
// the reads come with every change of the work graph, so a ticket's answer is kept until the ticket
// changes, unless its record may be yet to come.

/** What a ticket's read found, as of its last change. */
interface Known {
  readonly ticket: TicketId
  readonly updatedAt: number
  readonly review: Option.Option<ReviewRequest>
  /** Whether it stays so until the ticket changes: no record of it is yet to come. */
  readonly settled: boolean
}

/** The last deferral in a ticket's history, where a run made it. */
const runDeferral = (
  history: ReadonlyArray<TicketEvent>,
): Option.Option<TicketEvent> =>
  Option.filter(
    Option.fromUndefinedOr(
      history.findLast(({ change }) => change._tag === 'deferred'),
    ),
    ({ actor }) =>
      Option.exists(
        actor,
        ({ _tag }) => _tag === 'engine' || _tag === 'worker',
      ),
  )

/** Why the deferral at `since` set the ticket aside, where the stream wrote it by then. */
const recordedReason = (
  records: ReadonlyArray<RunEvent>,
  ticket: TicketId,
  since: DateTime.Utc,
): Option.Option<SetAsideReason> => {
  const last = records.findLast(
    (event): event is Extract<RunEvent, { readonly kind: 'deferred' }> =>
      event.kind === 'deferred' && event.ticket === ticket,
  )
  if (last === undefined) return Option.none()
  return Option.flatMap(DateTime.make(last.time), time =>
    DateTime.toEpochMillis(time) < DateTime.toEpochMillis(since)
      ? Option.none()
      : Option.fromUndefinedOr(last.reason),
  )
}

/** The project's tickets runs have set aside, its stream read from `records`, one read at a time. */
export const makeSetAsides = (
  records: (project: ProjectId) => Effect.Effect<ReadonlyArray<RunEvent>>,
) => {
  const known = new Map<ProjectId, ReadonlyMap<TicketId, Known>>()

  /** Reads the tickets as they are now, the stream at most once. */
  const read = Effect.fn('SetAsides.read')(function* (
    project: ProjectId,
    graph: Pick<WorkGraphShape, 'history'>,
    tickets: ReadonlyArray<Ticket>,
  ) {
    const deferrals = yield* Effect.forEach(
      tickets,
      ticket =>
        Effect.map(graph.history(ticket.id), history => ({
          ticket,
          deferral: runDeferral(history),
        })),
      { concurrency: 'unbounded' },
    )
    const stream = deferrals.some(({ deferral }) => Option.isSome(deferral))
      ? yield* records(project)
      : []
    return deferrals.map(({ ticket, deferral }): Known => {
      const reason = Option.flatMap(deferral, ({ at }) =>
        recordedReason(stream, ticket.id, at),
      )
      return {
        ticket: ticket.id,
        updatedAt: DateTime.toEpochMillis(ticket.updatedAt),
        review: Option.map(deferral, ({ at }) =>
          AttentionRequest.cases.review.make({
            project,
            ticket: ticket.id,
            title: ticket.title,
            reason: Option.getOrElse(reason, (): SetAsideReason => 'DEFERRED'),
            openedAt: at,
          }),
        ),
        settled: Option.isNone(deferral) || Option.isSome(reason),
      }
    })
  })

  return {
    /** The tickets of the project's work graph that runs have set aside, as review requests. */
    of: Effect.fn('SetAsides.of')(function* (
      project: ProjectId,
      graph: Pick<WorkGraphShape, 'list' | 'history'>,
    ) {
      const tickets = yield* graph.list({ statuses: ['deferred'] })
      const before = known.get(project)
      const kept = tickets.flatMap(ticket => {
        const held = before?.get(ticket.id)
        return held?.settled === true &&
          held.updatedAt === DateTime.toEpochMillis(ticket.updatedAt)
          ? [held]
          : []
      })
      const keptIds = new Set(kept.map(({ ticket }) => ticket))
      const found = yield* read(
        project,
        graph,
        tickets.filter(ticket => !keptIds.has(ticket.id)),
      )
      const now = [...kept, ...found]
      known.set(project, new Map(now.map(each => [each.ticket, each])))
      return now.flatMap(({ review }) => Option.toArray(review))
    }),
    /** Forgets a project: it is gone. */
    forget: (project: ProjectId) => Effect.sync(() => known.delete(project)),
  }
}
