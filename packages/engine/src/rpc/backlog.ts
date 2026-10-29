import { Effect, Exit, Option, Ref, Scope, Semaphore, Stream } from 'effect'

import {
  Actor,
  BacklogItem,
  BacklogRpcs,
  type NewTicket,
  NotReady,
  NotReadyReason,
  type ProjectId,
  Refused,
  type Resolution,
  type Resume,
  type Ticket,
  type TicketChanges,
  type TicketFilter,
  type TicketId,
  TicketNotFound,
  Why,
} from '@fabrica/contracts'

import { type KeyedFeed, makeKeyedFeed } from '../keyed-feed'
import { Projects } from '../projects/service'
import * as WorkGraph from '../workgraph'
import {
  type TicketUpdate,
  WaitReason,
  type WorkGraphShape,
  describeWait,
} from '../workgraph'
import { notImplemented } from './not-implemented'

// The Backlog group's handlers (spec §8.1, §11.1) on each project's work graph, opened by the Projects
// service: every change made through a client is the maintainer's. What the work graph refuses (a
// cycle, a transition its status doesn't allow, a ticket its schema wouldn't take) is answered
// `Refused` with the work graph's words; a ticket it doesn't have, `TicketNotFound`. What the engine
// can't do (its store failed, the project's database won't open) is a defect of the request that met
// it. `tickets.why` gives each reason with the words the log says it in (H81). The backlog stream is
// one keyed feed per project, fed from its work graph's changes, so a client that reconnects resumes
// it. `import` is the Beads import's ticket's.

/** What the work graph fails with, as the Backlog group's requests meet it. */
type GraphError =
  | WorkGraph.TicketNotFound
  | WorkGraph.StoreFailed
  | WorkGraph.EdgeCycle
  | WorkGraph.InvalidTicket
  | WorkGraph.TransitionRefused

/** Every change a client makes is the maintainer's (§11.2). */
const maintainer = Actor.cases.maintainer.make({})

/** The object with `key` set where `value` is given, without it where it isn't. */
const given = <K extends string, A>(
  key: K,
  value: Option.Option<A>,
): Partial<Record<K, A>> => {
  const object: Partial<Record<K, A>> = {}
  if (Option.isSome(value)) object[key] = value.value
  return object
}

/** A reason in the protocol's terms, by the work graph's reason. */
const notReadyOf = (reason: WaitReason): NotReady =>
  WaitReason.$match(reason, {
    NotOpen: ({ status }) =>
      status === 'closed'
        ? NotReady.cases.closed.make({})
        : NotReady.cases.in_progress.make({}),
    Deferred: ({ until }) => NotReady.cases.deferred.make({ until }),
    NotForWorkers: ({ type }) => NotReady.cases.not_dispatched.make({ type }),
    // The backlog asks without a run, so nothing is set aside; a run's view gives its reasons.
    SetAside: () => {
      throw new Error('a ticket set aside outside a run has no reason')
    },
    Blocked: ({ blocker, status }) =>
      NotReady.cases.blocked.make({ by: blocker, status }),
    ClosedUnmerged: ({ blocker }) =>
      NotReady.cases.closed_unmerged.make({ by: blocker }),
    FiledFrom: ({ origin }) =>
      NotReady.cases.filed_from_unmerged.make({ ticket: origin }),
  })

/** `tickets.why`'s answer, by the work graph's reasons. */
export const whyOf = (reasons: ReadonlyArray<WaitReason>): Why => {
  const [first, ...rest] = reasons.map(
    reason =>
      new NotReadyReason({
        reason: notReadyOf(reason),
        words: describeWait(reason),
      }),
  )
  return first === undefined
    ? Why.cases.ready.make({})
    : Why.cases.not_ready.make({ reasons: [first, ...rest] })
}

/** A project's backlog stream, and the work graph it is fed from. */
interface Watched {
  readonly graph: WorkGraphShape
  readonly feed: KeyedFeed<Ticket, TicketId, BacklogItem>
  readonly scope: Scope.Closeable
}

/** The Backlog group's handlers on the Projects service, the backlog streams' fibers in the layer's scope. */
export const makeBacklogHandlers = Effect.gen(function* () {
  const projects = yield* Projects
  const layerScope = yield* Effect.scope
  const watched = yield* Ref.make<ReadonlyMap<ProjectId, Watched>>(new Map())
  const watchLock = yield* Semaphore.make(1)

  const graphOf = (project: ProjectId) =>
    projects
      .workGraph(project)
      .pipe(Effect.catchTag('WorkGraphUnopened', Effect.die))

  /** A read's errors in the protocol's terms: a ticket the project hasn't, its store's failures defects. */
  const found =
    (project: ProjectId) =>
    <A, R>(
      effect: Effect.Effect<
        A,
        WorkGraph.TicketNotFound | WorkGraph.StoreFailed,
        R
      >,
    ): Effect.Effect<A, TicketNotFound, R> =>
      Effect.catch(
        effect,
        (
          error: WorkGraph.TicketNotFound | WorkGraph.StoreFailed,
        ): Effect.Effect<never, TicketNotFound> =>
          error._tag === 'StoreFailed'
            ? Effect.die(error)
            : Effect.fail(new TicketNotFound({ project, ticket: error.id })),
      )

  /** A change's errors in the protocol's terms: what the work graph refuses is `Refused`, in its words. */
  const answered =
    (project: ProjectId) =>
    <A, R>(
      effect: Effect.Effect<A, GraphError, R>,
    ): Effect.Effect<A, TicketNotFound | Refused, R> =>
      Effect.catch(
        effect,
        (error: GraphError): Effect.Effect<never, TicketNotFound | Refused> =>
          error._tag === 'StoreFailed' || error._tag === 'TicketNotFound'
            ? found(project)(Effect.fail(error))
            : Effect.fail(new Refused({ reason: error.message })),
      )

  const list = Effect.fn('Backlog.list')(function* ({
    project,
    filter,
  }: {
    readonly project: ProjectId
    readonly filter: TicketFilter
  }) {
    const graph = yield* graphOf(project)
    const base = {
      ...given('statuses', filter.status),
      ...given('types', filter.type),
    }
    // The work graph filters by one label: a ticket is listed where it has every label named.
    const [first, ...others] = Option.getOrElse(filter.labels, () => [])
    const tickets = yield* graph
      .list(first === undefined ? base : { ...base, label: first })
      .pipe(Effect.orDie)
    const labelled = yield* Effect.forEach(
      others,
      label =>
        graph.list({ ...base, label }).pipe(
          Effect.orDie,
          Effect.map(each => new Set(each.map(({ id }) => id))),
        ),
      { concurrency: 'unbounded' },
    )
    const children = yield* Option.match(filter.parent, {
      onNone: () => Effect.succeed(Option.none<ReadonlySet<TicketId>>()),
      onSome: parent =>
        graph.show(parent).pipe(
          Effect.map(({ edges }) =>
            Option.some(
              new Set(
                edges
                  .filter(
                    edge => edge.kind === 'parent' && edge.from === parent,
                  )
                  .map(({ to }) => to),
              ),
            ),
          ),
          // Children of a ticket the project doesn't have: none.
          Effect.catchTag('TicketNotFound', () =>
            Effect.succeed(Option.some<ReadonlySet<TicketId>>(new Set())),
          ),
          Effect.orDie,
        ),
    })
    return tickets.filter(
      ({ id }) =>
        labelled.every(set => set.has(id)) &&
        Option.match(children, {
          onNone: () => true,
          onSome: set => set.has(id),
        }),
    )
  })

  const show = Effect.fn('Backlog.show')(function* ({
    project,
    ticket,
  }: {
    readonly project: ProjectId
    readonly ticket: TicketId
  }) {
    const graph = yield* graphOf(project)
    return yield* graph.show(ticket).pipe(found(project))
  })

  const create = Effect.fn('Backlog.create')(function* ({
    project,
    ticket,
  }: {
    readonly project: ProjectId
    readonly ticket: NewTicket
  }) {
    const { type } = ticket
    if (type === 'question')
      return yield* new Refused({
        reason:
          'a question is asked of the maintainer by a worker or a talk, with its options; it is not created',
      })
    const graph = yield* graphOf(project)
    const created = yield* graph
      .create({
        ticket: {
          type,
          title: ticket.title,
          ...given('description', ticket.description),
          ...given('design', ticket.design),
          ...given('acceptance', ticket.acceptance),
          ...given('priority', ticket.priority),
          ...given('labels', ticket.labels),
          ...given('parent', ticket.parent),
          ...given('metadata', ticket.metadata),
          ...given('model', ticket.model),
        },
        actor: maintainer,
      })
      .pipe(answered(project))
    return { id: created.id }
  })

  const update = Effect.fn('Backlog.update')(function* ({
    project,
    ticket,
    changes,
  }: {
    readonly project: ProjectId
    readonly ticket: TicketId
    readonly changes: TicketChanges
  }) {
    const { status, deferUntil, ...fields } = changes
    if (
      status === 'open' &&
      deferUntil !== undefined &&
      Option.isSome(deferUntil)
    )
      return yield* new Refused({
        reason: 'a ticket reopened has no time to be deferred until',
      })
    const graph = yield* graphOf(project)
    const plain: TicketUpdate = fields
    if (Object.values(plain).some(value => value !== undefined))
      yield* graph
        .update({ id: ticket, changes: plain, actor: maintainer })
        .pipe(answered(project))
    // A time to defer until defers the ticket, where it isn't reopened.
    if (status === 'open') {
      const { ticket: current } = yield* graph
        .show(ticket)
        .pipe(answered(project))
      if (current.status === 'closed')
        yield* graph
          .reopen({ id: ticket, actor: maintainer })
          .pipe(answered(project))
      else if (current.status === 'deferred')
        yield* graph
          .undefer({ id: ticket, actor: maintainer })
          .pipe(answered(project))
      else if (current.status === 'in_progress')
        return yield* new Refused({
          reason: `can't reopen ${ticket}: it is in progress`,
        })
    } else if (status === 'deferred' || deferUntil !== undefined) {
      yield* graph
        .defer({
          id: ticket,
          until: deferUntil ?? Option.none(),
          actor: maintainer,
        })
        .pipe(answered(project))
    }
  })

  const close = Effect.fn('Backlog.close')(function* ({
    project,
    ticket,
    resolution,
    reason,
  }: {
    readonly project: ProjectId
    readonly ticket: TicketId
    readonly resolution: Resolution
    readonly reason: Option.Option<string>
  }) {
    const graph = yield* graphOf(project)
    yield* graph
      .close({
        id: ticket,
        resolution,
        ...given('reason', reason),
        actor: maintainer,
      })
      .pipe(answered(project))
  })

  const label = Effect.fn('Backlog.label')(function* ({
    project,
    ticket,
    add,
    remove,
  }: {
    readonly project: ProjectId
    readonly ticket: TicketId
    readonly add: ReadonlyArray<string>
    readonly remove: ReadonlyArray<string>
  }) {
    const graph = yield* graphOf(project)
    // A ticket the project doesn't have is refused, even with no labels to change.
    yield* graph.show(ticket).pipe(answered(project))
    yield* Effect.forEach(
      add,
      each =>
        graph
          .label({ id: ticket, label: each, actor: maintainer })
          .pipe(answered(project)),
      { discard: true },
    )
    yield* Effect.forEach(
      remove,
      each =>
        graph
          .unlabel({ id: ticket, label: each, actor: maintainer })
          .pipe(answered(project)),
      { discard: true },
    )
  })

  const note = Effect.fn('Backlog.note')(function* ({
    project,
    ticket,
    body,
  }: {
    readonly project: ProjectId
    readonly ticket: TicketId
    readonly body: string
  }) {
    const graph = yield* graphOf(project)
    const written = yield* graph
      .note({ id: ticket, body, actor: maintainer })
      .pipe(answered(project))
    return { id: written.id }
  })

  const ready = Effect.fn('Backlog.ready')(function* ({
    project,
  }: {
    readonly project: ProjectId
  }) {
    const [graph, onBase] = yield* Effect.all(
      [graphOf(project), projects.onBase(project)],
      { concurrency: 'unbounded' },
    )
    return yield* graph.ready({ onBase }).pipe(Effect.orDie)
  })

  const why = Effect.fn('Backlog.why')(function* ({
    project,
    ticket,
  }: {
    readonly project: ProjectId
    readonly ticket: TicketId
  }) {
    const [graph, onBase] = yield* Effect.all(
      [graphOf(project), projects.onBase(project)],
      { concurrency: 'unbounded' },
    )
    const reasons = yield* graph
      .why({ id: ticket, onBase })
      .pipe(found(project))
    return whyOf(reasons)
  })

  /** A backlog stream for `graph`: subscribed to its changes before its tickets are read, so none is missed. */
  const startFeed = (project: ProjectId, graph: WorkGraphShape) =>
    Effect.gen(function* () {
      const scope = yield* Scope.fork(layerScope)
      return yield* Effect.gen(function* () {
        const changes = yield* graph.changes.pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.orDie,
        )
        const tickets = yield* graph.list().pipe(Effect.orDie)
        const feed = yield* makeKeyedFeed<Ticket, TicketId, BacklogItem>({
          name: 'backlog',
          items: tickets,
          keyOf: ticket => ticket.id,
          snapshot: BacklogItem.cases.snapshot.make,
          patch: BacklogItem.cases.patch.make,
        })
        // Each change sends its ticket as it is now, or its going.
        yield* changes.pipe(
          Stream.runForEach(event =>
            Option.match(event.ticketId, {
              onNone: () => Effect.void,
              onSome: id =>
                graph.show(id).pipe(
                  Effect.flatMap(({ ticket }) => feed.upsert(ticket)),
                  Effect.catchTag('TicketNotFound', () => feed.remove(id)),
                ),
            }),
          ),
          Effect.catch(error =>
            Effect.logWarning(
              `the backlog of ${project} stopped sending its changes: ${error.message}`,
            ),
          ),
          Effect.forkIn(scope),
        )
        return { graph, feed, scope } satisfies Watched
      }).pipe(Effect.tapCause(() => Scope.close(scope, Exit.void)))
    })

  /** The project's backlog stream, started the first time it is asked for, and again for a work graph opened anew. */
  const feedOf = (project: ProjectId) =>
    Effect.gen(function* () {
      const graph = yield* graphOf(project)
      return yield* watchLock.withPermit(
        Effect.gen(function* () {
          const held = (yield* Ref.get(watched)).get(project)
          if (held !== undefined && held.graph === graph) return held.feed
          if (held !== undefined) yield* Scope.close(held.scope, Exit.void)
          const started = yield* startFeed(project, graph)
          yield* Ref.update(watched, map => new Map(map).set(project, started))
          return started.feed
        }),
      )
    })

  const watch = ({
    project,
    resume,
  }: {
    readonly project: ProjectId
    readonly resume: Option.Option<Resume>
  }) => Stream.unwrap(Effect.map(feedOf(project), feed => feed.watch(resume)))

  return BacklogRpcs.of({
    'tickets.list': list,
    'tickets.show': show,
    'tickets.create': create,
    'tickets.update': update,
    'tickets.close': close,
    'tickets.dep.add': ({ project, edge }) =>
      Effect.flatMap(graphOf(project), graph =>
        graph
          .addDependency({ edge, actor: maintainer })
          .pipe(answered(project)),
      ),
    'tickets.dep.remove': ({ project, edge }) =>
      Effect.flatMap(graphOf(project), graph =>
        graph
          .removeDependency({ edge, actor: maintainer })
          .pipe(answered(project)),
      ),
    'tickets.label': label,
    'tickets.note': note,
    'tickets.ready': ready,
    'tickets.why': why,
    'tickets.import': notImplemented('tickets.import'),
    'tickets.watch': watch,
  })
})

/** The Backlog group's handlers. */
export const backlogHandlers = BacklogRpcs.toLayer(makeBacklogHandlers)
