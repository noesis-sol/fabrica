import { DateTime, Duration, Effect, Layer, Option, Ref, Stream } from 'effect'
import { TestClock } from 'effect/testing'

import { describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  Assignee,
  AttentionRequest,
  EngineId,
  ProjectId,
  ProjectNotFound,
  type RunEvent,
  RunId,
  SessionId,
  type SetAsideReason,
  type TicketId,
  formatLocalTime,
} from '@fabrica/contracts'

import { make } from '../src/attention'
import { WorkGraph, makeWorkGraph, storeLayer } from '../src/workgraph'

// Review requests past their run (spec §15.1, §18.3): the attention service reads the tickets a run
// set aside from the work graph, whose last deferral was the run's, and the event stream, which says
// why. A card stays through the run's end and a restart, and closes as its ticket is undeferred, closed
// or taken up, or as the maintainer defers it again.

const project = ProjectId.make('app')
const engine = EngineId.make('engine-1')
const session = SessionId.make('session-1')
const run = RunId.make('2026-11-03T22:00:00.000+00:00')

const byEngine: Actor = { _tag: 'engine', engine }
const byWorker: Actor = { _tag: 'worker', session }
const byMaintainer: Actor = { _tag: 'maintainer' }
const byTalk: Actor = { _tag: 'talk', session }

const graphLayer = Layer.effect(
  WorkGraph,
  makeWorkGraph({ prefix: 'fa' }),
).pipe(Layer.provide(storeLayer(':memory:')))

/** The attention requests over the one project; its stream's records are in `stream`, its reads counted in `reads`. */
const service = Effect.gen(function* () {
  const graph = yield* WorkGraph
  const stream = yield* Ref.make<ReadonlyArray<RunEvent>>([])
  const reads = yield* Ref.make(0)
  const start = make({
    list: Effect.succeed([project]),
    changed: Stream.never,
    graph: id =>
      id === project
        ? Effect.succeed(graph)
        : Effect.fail(new ProjectNotFound({ project: id })),
    events: () =>
      Effect.andThen(
        Ref.update(reads, n => n + 1),
        Ref.get(stream),
      ),
  })
  /** The stream gets `ticket`'s `deferred` record, as of now. */
  const recorded = (ticket: TicketId, reason: SetAsideReason) =>
    Effect.gen(function* () {
      const time = formatLocalTime(
        DateTime.setZone(yield* DateTime.now, DateTime.zoneMakeOffset(0)),
      )
      const record: RunEvent = {
        v: 1,
        time,
        run,
        kind: 'deferred',
        ticket,
        title: 'Add the page',
        reason,
        detail: 'why',
        text: 'why',
      }
      yield* Ref.update(stream, records => [...records, record])
    })
  return { attention: yield* start, start, graph, recorded, reads }
})

const fileTicket = Effect.gen(function* () {
  const graph = yield* WorkGraph
  const ticket = yield* graph.create({
    ticket: { type: 'task', title: 'Add the page' },
    actor: byMaintainer,
  })
  return ticket.id
})

const defer = (id: TicketId, actor: Actor) =>
  Effect.flatMap(WorkGraph, graph =>
    graph.defer({ id, until: Option.none(), actor }),
  )

const later = TestClock.adjust(Duration.seconds(1))

describe('a review request a run left', () => {
  it.effect(
    "is read from the work graph and the stream: the record's reason, the deferral's time, the ticket's title",
    () =>
      Effect.gen(function* () {
        const { attention, recorded } = yield* service
        const ticket = yield* fileTicket
        yield* defer(ticket, byEngine)
        const deferredAt = yield* DateTime.now
        yield* recorded(ticket, 'CHECKS_FAILED')
        expect(yield* attention.list(Option.some(project))).toStrictEqual([
          AttentionRequest.cases.review.make({
            project,
            ticket,
            title: 'Add the page',
            reason: 'CHECKS_FAILED',
            openedAt: deferredAt,
          }),
        ])
        // Listed across every project too.
        expect(yield* attention.list(Option.none())).toHaveLength(1)
      }).pipe(Effect.scoped, Effect.provide(graphLayer)),
  )

  it.effect('is there again for a service started anew', () =>
    Effect.gen(function* () {
      const { start, recorded } = yield* service
      const ticket = yield* fileTicket
      yield* defer(ticket, byWorker)
      yield* recorded(ticket, 'DEFERRED')
      const restarted = yield* start
      expect(
        (yield* restarted.list(Option.some(project))).map(request =>
          request._tag === 'review' ? request.ticket : undefined,
        ),
      ).toEqual([ticket])
    }).pipe(Effect.scoped, Effect.provide(graphLayer)),
  )

  it.effect('is none for a ticket no run deferred', () =>
    Effect.gen(function* () {
      const { attention, recorded } = yield* service
      const byHand = yield* fileTicket
      yield* defer(byHand, byMaintainer)
      const inTalk = yield* fileTicket
      yield* defer(inTalk, byTalk)
      // Even with a record: an earlier set-aside's, undeferred since, and deferred by hand.
      yield* recorded(byHand, 'MERGE_CONFLICT')
      expect(yield* attention.list(Option.some(project))).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(graphLayer)),
  )

  it.effect(
    'closes as its ticket is undeferred, closed, or deferred again by the maintainer',
    () =>
      Effect.gen(function* () {
        const { attention, graph, recorded } = yield* service
        const undeferred = yield* fileTicket
        const closed = yield* fileTicket
        const again = yield* fileTicket
        const stays = yield* fileTicket
        for (const ticket of [undeferred, closed, again, stays]) {
          yield* defer(ticket, byEngine)
          yield* recorded(ticket, 'CHECKS_FAILED')
        }
        const open = Effect.map(
          attention.list(Option.some(project)),
          requests =>
            requests.flatMap(request =>
              request._tag === 'review' ? [request.ticket] : [],
            ),
        )
        expect((yield* open).toSorted()).toEqual(
          [undeferred, closed, again, stays].toSorted(),
        )

        yield* later
        yield* graph.undefer({ id: undeferred, actor: byMaintainer })
        yield* graph.close({
          id: closed,
          resolution: 'cancelled',
          reason: 'no longer',
          actor: byMaintainer,
        })
        yield* defer(again, byMaintainer)
        expect(yield* open).toEqual([stays])
      }).pipe(Effect.scoped, Effect.provide(graphLayer)),
  )

  it.effect('closes as a next run takes its ticket up', () =>
    Effect.gen(function* () {
      const { attention, graph, recorded } = yield* service
      const ticket = yield* fileTicket
      // Set aside until a time: when that comes, a run's claim takes it.
      yield* graph.defer({
        id: ticket,
        until: Option.some(DateTime.add(yield* DateTime.now, { seconds: 1 })),
        actor: byEngine,
      })
      yield* recorded(ticket, 'TICKET_LIMIT')
      expect(yield* attention.list(Option.some(project))).toHaveLength(1)
      yield* later
      yield* graph.claim({
        id: ticket,
        assignee: new Assignee({ engine, session }),
        actor: byWorker,
      })
      expect(yield* attention.list(Option.some(project))).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(graphLayer)),
  )

  it.effect(
    'says only that its ticket is deferred where the stream has no record of this deferral, until one comes',
    () =>
      Effect.gen(function* () {
        const { attention, recorded } = yield* service
        const ticket = yield* fileTicket
        const reasons = Effect.map(
          attention.list(Option.some(project)),
          requests =>
            requests.flatMap(request =>
              request._tag === 'review' ? [request.reason] : [],
            ),
        )
        // An earlier set-aside's record, older than the deferral, doesn't say why this one was.
        yield* recorded(ticket, 'MERGE_CONFLICT')
        yield* later
        yield* defer(ticket, byWorker)
        expect(yield* reasons).toEqual(['DEFERRED'])
        yield* later
        yield* recorded(ticket, 'BUDGET_EXCEEDED')
        expect(yield* reasons).toEqual(['BUDGET_EXCEEDED'])
      }).pipe(Effect.scoped, Effect.provide(graphLayer)),
  )

  it.effect('reads the stream only for what it has yet to learn', () =>
    Effect.gen(function* () {
      const { attention, graph, reads, recorded } = yield* service
      const list = attention.list(Option.some(project))

      // Nothing deferred, or deferred by hand: no read.
      const byHand = yield* fileTicket
      yield* defer(byHand, byMaintainer)
      yield* list
      expect(yield* Ref.get(reads)).toBe(0)

      // A reason read once is kept while the ticket stays as it was.
      const ticket = yield* fileTicket
      yield* defer(ticket, byEngine)
      yield* recorded(ticket, 'CHECKS_FAILED')
      yield* list
      yield* list
      yield* fileTicket
      yield* list
      expect(yield* Ref.get(reads)).toBe(1)

      // Changed, it is read again, with what changed.
      yield* later
      yield* graph.update({
        id: ticket,
        changes: { title: 'Add the other page' },
        actor: byMaintainer,
      })
      expect((yield* list)[0]).toMatchObject({ title: 'Add the other page' })
      expect(yield* Ref.get(reads)).toBe(2)
    }).pipe(Effect.scoped, Effect.provide(graphLayer)),
  )
})

describe("a going run's word on its set-aside tickets", () => {
  const told = (ticket: TicketId, reason: SetAsideReason) =>
    Effect.map(DateTime.now, openedAt =>
      AttentionRequest.cases.review.make({
        project,
        ticket,
        title: 'As the run says',
        reason,
        openedAt,
      }),
    )

  it.effect(
    'holds while it goes, and what the work graph says takes over as it ends',
    () =>
      Effect.gen(function* () {
        const { attention, recorded } = yield* service
        const ticket = yield* fileTicket
        yield* defer(ticket, byEngine)
        yield* recorded(ticket, 'CHECKS_FAILED')
        const fromRun = yield* told(ticket, 'CHECKS_FAILED')
        yield* attention.reviews({ project, open: [fromRun] })
        expect(yield* attention.list(Option.some(project))).toStrictEqual([
          fromRun,
        ])

        yield* attention.reviews({ project, open: [] })
        expect(yield* attention.list(Option.some(project))).toMatchObject([
          { _tag: 'review', ticket, title: 'Add the page' },
        ])
      }).pipe(Effect.scoped, Effect.provide(graphLayer)),
  )

  it.effect('leaves no card for a ticket set aside in the run alone', () =>
    Effect.gen(function* () {
      const { attention } = yield* service
      // Someone else's claim: the run set it aside, the work graph didn't.
      const ticket = yield* fileTicket
      yield* attention.reviews({
        project,
        open: [yield* told(ticket, 'TOOL_DEFECT')],
      })
      expect(yield* attention.list(Option.some(project))).toHaveLength(1)
      yield* attention.reviews({ project, open: [] })
      expect(yield* attention.list(Option.some(project))).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(graphLayer)),
  )

  it.effect("never fails its teller: a project it can't read is said", () =>
    Effect.gen(function* () {
      const { attention } = yield* service
      yield* attention.reviews({
        project: ProjectId.make('gone'),
        open: [],
      })
    }).pipe(Effect.scoped, Effect.provide(graphLayer)),
  )
})

describe('a project that is gone', () => {
  it.effect('takes its review requests with it', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const known = yield* Ref.make<ReadonlyArray<ProjectId>>([project])
      const attention = yield* make({
        list: Ref.get(known),
        changed: Stream.never,
        graph: () => Effect.succeed(graph),
        events: () => Effect.succeed([]),
      })
      const ticket = yield* fileTicket
      yield* defer(ticket, byEngine)
      expect(yield* attention.list(Option.none())).toHaveLength(1)
      yield* Ref.set(known, [])
      expect(yield* attention.list(Option.none())).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(graphLayer)),
  )
})
