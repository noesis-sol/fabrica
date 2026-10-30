import {
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from 'effect'

import {
  Actor,
  AlreadyAnswered,
  Answered,
  type AttentionAnswer,
  AttentionClosed,
  AttentionNotFound,
  AttentionPatch,
  AttentionRef,
  AttentionRequest,
  type Edge,
  InvalidAnswer,
  PermissionDecision,
  PermissionId,
  type ProjectId,
  type ProjectNotFound,
  type QuestionAnswer,
  type Resume,
  type Ticket,
  type TicketEvent,
  type TicketId,
  attentionKey,
  streamItem,
} from '@fabrica/contracts'

import type { AttentionShape, PermissionRequest } from '../control/ports'
import { type KeyedFeed, makeKeyedFeed } from '../keyed-feed'
import { Projects } from '../projects/service'
import type { WorkGraphShape } from '../workgraph'
import { drawBase36 } from '../workgraph/ids'
import { isConsequential } from './consequential'
import { withAnswer } from './design'

// The attention requests (spec §15.1, §15.2, §8.5): what waits on the maintainer, across the engine's
// projects. Questions (from workers, organs, talks or the maintainer) and maintainer tasks are read
// from each project's work graph, followed as it changes; permission requests come from the gate,
// through each run's side of the service, and live as long as their agent waits. Every client lists
// the same requests and watches them change. The first answer wins: answers are taken one at a time,
// and a later one is told who answered and when.
//
// A question's answer is written into the design of each ticket it blocks, then recorded on the
// question, closing it as `answered`, as the maintainer's change: the tickets it blocks become ready,
// a session waiting on it (`ask_and_wait`) hears it, and the run, which wakes on every change but its
// own, takes the asking ticket back at once and resumes its session with the answer (H92). A
// permission request is answered allow once, allow for this run (a rule of the run's side: the same
// tool with the same input is allowed for the rest of the run, the requests it matches meanwhile
// with it), or refuse with a note. Any question's answer can be revised: the new answer replaces the
// old in the designs and on the question, and what the old one led to is undone where it can be
// (tickets closed or deferred on it reopened or undeferred), and listed where it can't.

/** The projects, as the attention requests read them. */
export interface AttentionProjects {
  /** The engine's projects. */
  readonly list: Effect.Effect<ReadonlyArray<ProjectId>>
  /** Something whenever the projects may have changed: one added or removed. */
  readonly changed: Stream.Stream<unknown>
  /** The project's work graph; a defect where it can't be opened. */
  readonly graph: (
    project: ProjectId,
  ) => Effect.Effect<WorkGraphShape, ProjectNotFound>
}

/** A revised answer, what it undid of the old one, and what it couldn't undo. */
export interface Revised {
  readonly answered: Answered
  readonly undone: ReadonlyArray<string>
  readonly kept: ReadonlyArray<string>
}

export interface AttentionRequestsShape {
  /** Every project's requests, or one project's, oldest first. */
  readonly list: (
    project: Option.Option<ProjectId>,
  ) => Effect.Effect<ReadonlyArray<AttentionRequest>, ProjectNotFound>
  /** The requests as a snapshot, or the patches after `resume`, then each change. */
  readonly watch: (input: {
    readonly project: Option.Option<ProjectId>
    readonly resume: Option.Option<Resume>
  }) => Stream.Stream<AttentionItem, ProjectNotFound>
  /** Answers a request for the client `by`; the first answer wins (§8.5). */
  readonly answer: (input: {
    readonly answer: AttentionAnswer
    readonly by: ClientName
  }) => Effect.Effect<
    Answered,
    AlreadyAnswered | AttentionNotFound | InvalidAnswer
  >
  /** Revises a question's answer, undoing what the old one did where it can (§15.2, H53). */
  readonly revise: (input: {
    readonly project: ProjectId
    readonly ticket: TicketId
    readonly answer: QuestionAnswer
    readonly by: ClientName
  }) => Effect.Effect<Revised, AttentionNotFound | InvalidAnswer>
  /** A run's side, as its control server asks: its own allow-for-this-run rules, gone with it. */
  readonly forRun: Effect.Effect<AttentionShape>
}

export class AttentionRequests extends Context.Service<
  AttentionRequests,
  AttentionRequestsShape
>()('@fabrica/engine/AttentionRequests') {}

/** The attention stream's items. */
export const AttentionItem = streamItem(
  Schema.Array(AttentionRequest),
  AttentionPatch,
)
export type AttentionItem = typeof AttentionItem.Type

/** How a client names itself, and how the engine says who answered (§8.5). */
type ClientName = Answered['by']

/** Every answer a client gives is the maintainer's (§11.2). */
const maintainer = Actor.cases.maintainer.make({})

/** A change's actor, said as who answered. */
const actorName = (actor: Option.Option<Actor>): ClientName =>
  Option.match(actor, {
    onNone: () => 'someone',
    onSome: Actor.match({
      maintainer: () => 'the maintainer',
      worker: ({ session }) => `the worker of session ${session}`,
      talk: ({ session }) => `the talk of session ${session}`,
      organ: ({ organ }) => `the ${organ}`,
      engine: () => 'the engine',
    }),
  })

/** A permission rule of a run: a tool and its input, allowed for the rest of the run. */
interface Rule {
  readonly tool: string
  readonly input: string
}

const ruleOf = (call: {
  readonly tool: string
  readonly input: unknown
}): Rule => ({ tool: call.tool, input: JSON.stringify(call.input) })

const sameRule = (a: Rule, b: Rule): boolean =>
  a.tool === b.tool && a.input === b.input

/** A permission request waiting for its answer. */
interface Pending {
  readonly request: AttentionRequest
  readonly rule: Rule
  readonly rules: Ref.Ref<ReadonlyArray<Rule>>
  readonly decision: Deferred.Deferred<PermissionDecision>
}

/** The most closures kept for the patches a feed keeps: four times a feed's 256. */
const keptClosures = 1024

/** The answer's text: the option's label, or the maintainer's words. */
const answerText = (
  ticket: Ticket,
  answer: QuestionAnswer,
): Effect.Effect<string, InvalidAnswer> =>
  answer._tag === 'text'
    ? Effect.succeed(answer.text)
    : Option.match(
        Option.flatMap(ticket.question, ({ choices }) => choices),
        {
          onNone: () =>
            Effect.fail(
              new InvalidAnswer({
                reason: `${ticket.id} was asked without options: answer it in words`,
              }),
            ),
          onSome: ({ options }) =>
            Option.match(Option.fromUndefinedOr(options[answer.index]), {
              onNone: () =>
                Effect.fail(
                  new InvalidAnswer({
                    reason: `${ticket.id} has ${options.length} options, numbered from 0: there is no option ${answer.index}`,
                  }),
                ),
              onSome: option => Effect.succeed(option.label),
            }),
        },
      )

/** The tickets a question blocks, and the ticket it was asked from. */
const linksOf = (question: TicketId, edges: ReadonlyArray<Edge>) => ({
  blocks: edges
    .filter(edge => edge.kind === 'blocks' && edge.from === question)
    .map(edge => edge.to),
  askedFrom: Option.fromUndefinedOr(
    edges.find(
      edge => edge.kind === 'discovered_from' && edge.from === question,
    )?.to,
  ),
})

/** A work graph's questions and maintainer tasks, as requests. */
const requestsOf = (
  project: ProjectId,
  graph: WorkGraphShape,
): Effect.Effect<ReadonlyArray<AttentionRequest>> =>
  Effect.all(
    [
      graph.list({ statuses: ['open', 'in_progress'], types: ['question'] }),
      graph.list({ statuses: ['open', 'in_progress'], types: ['manual'] }),
      graph.edges(),
    ],
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.map(([questions, tasks, edges]) => [
      ...questions.flatMap(ticket =>
        Option.toArray(ticket.question).map(question =>
          AttentionRequest.cases.question.make({
            project,
            ticket: ticket.id,
            title: ticket.title,
            description: ticket.description,
            choices: question.choices,
            consequential: isConsequential(question),
            maintainerOnly: question.maintainerOnly,
            ...linksOf(ticket.id, edges),
            openedAt: ticket.createdAt,
          }),
        ),
      ),
      ...tasks.map(ticket =>
        AttentionRequest.cases.task.make({
          project,
          ticket: ticket.id,
          title: ticket.title,
          openedAt: ticket.createdAt,
        }),
      ),
    ]),
    Effect.orDie,
  )

/** The request's ref. */
const refOf = (request: AttentionRequest): AttentionRef =>
  AttentionRequest.match(request, {
    question: ({ project, ticket }): AttentionRef =>
      AttentionRef.cases.question.make({ project, ticket }),
    permission: ({ project, id }): AttentionRef =>
      AttentionRef.cases.permission.make({ project, id }),
    task: ({ project, ticket }): AttentionRef =>
      AttentionRef.cases.task.make({ project, ticket }),
    review: ({ project, ticket }): AttentionRef =>
      AttentionRef.cases.review.make({ project, ticket }),
  })

/** The last event of the kind in a ticket's history. */
const lastOf = <Tag extends TicketEvent['change']['_tag']>(
  history: ReadonlyArray<TicketEvent>,
  tag: Tag,
) =>
  Option.fromUndefinedOr(history.findLast(event => event.change._tag === tag))

/** The attention requests over `projects`, in the current scope. */
export const make = (
  projects: AttentionProjects,
): Effect.Effect<AttentionRequestsShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    /** The requests, by key, oldest first. */
    const requests = yield* Ref.make<ReadonlyMap<string, AttentionRequest>>(
      new Map(),
    )
    /** How each request that left the list left it, for the patches that say so. */
    const closures = new Map<string, AttentionClosed>()
    /** Who answered each request answered through the service, and when. */
    const answers = new Map<string, Answered>()
    const pending = yield* Ref.make<ReadonlyMap<string, Pending>>(new Map())
    const all = yield* feedOf([])
    const byProject = yield* Ref.make<
      ReadonlyMap<ProjectId, KeyedFeed<AttentionRequest, string, AttentionItem>>
    >(new Map())
    /** Guards the requests and their feeds together. */
    const listLock = yield* Semaphore.make(1)
    /** One answer at a time, so the first wins. */
    const answerLock = yield* Semaphore.make(1)
    /** One read of the work graphs at a time, so an older read never lands after a newer one. */
    const syncLock = yield* Semaphore.make(1)
    const followLock = yield* Semaphore.make(1)
    const followed = yield* Ref.make<ReadonlyMap<ProjectId, Scope.Closeable>>(
      new Map(),
    )
    const following = yield* Ref.make(false)

    function feedOf(items: ReadonlyArray<AttentionRequest>) {
      return makeKeyedFeed<AttentionRequest, string, AttentionItem>({
        name: 'attention',
        items,
        keyOf: attentionKey,
        snapshot: AttentionItem.cases.snapshot.make,
        patch: ({ seq, value }) =>
          AttentionItem.cases.patch.make({
            seq,
            value: {
              upsert: value.upsert,
              remove: value.remove.flatMap(key =>
                Option.toArray(Option.fromUndefinedOr(closures.get(key))),
              ),
            },
          }),
      })
    }

    const feedsFor = (project: ProjectId) =>
      Effect.map(Ref.get(byProject), feeds => [
        all,
        ...Option.toArray(Option.fromUndefinedOr(feeds.get(project))),
      ])

    const put = (request: AttentionRequest) =>
      listLock.withPermit(
        Effect.gen(function* () {
          yield* Ref.update(requests, map =>
            new Map(map).set(attentionKey(request), request),
          )
          const feeds = yield* feedsFor(request.project)
          yield* Effect.forEach(feeds, feed => feed.upsert(request), {
            discard: true,
          })
        }),
      )

    const close = (request: AttentionRequest) =>
      listLock.withPermit(
        Effect.gen(function* () {
          const key = attentionKey(request)
          if (!(yield* Ref.get(requests)).has(key)) return
          const answered = Option.fromUndefinedOr(answers.get(key))
          closures.set(
            key,
            new AttentionClosed({
              ref: refOf(request),
              by: Option.map(answered, ({ by }) => by),
              at: yield* Option.match(answered, {
                onNone: () => DateTime.now,
                onSome: ({ at }) => Effect.succeed(at),
              }),
            }),
          )
          for (const old of [...closures.keys()].slice(
            0,
            Math.max(0, closures.size - keptClosures),
          ))
            closures.delete(old)
          yield* Ref.update(requests, map => {
            const next = new Map(map)
            next.delete(key)
            return next
          })
          const feeds = yield* feedsFor(request.project)
          yield* Effect.forEach(feeds, feed => feed.remove(key), {
            discard: true,
          })
        }),
      )

    /** Brings the project's questions and tasks up to its work graph. */
    const sync = (project: ProjectId, graph: WorkGraphShape) =>
      syncLock.withPermit(
        Effect.gen(function* () {
          const now = yield* requestsOf(project, graph)
          const keys = new Set(now.map(attentionKey))
          const before = [...(yield* Ref.get(requests)).values()].filter(
            request =>
              request.project === project && request._tag !== 'permission',
          )
          yield* Effect.forEach(
            before.filter(request => !keys.has(attentionKey(request))),
            close,
            { discard: true },
          )
          yield* Effect.forEach(now, put, { discard: true })
        }),
      )

    /** Drops a project's questions and tasks: it is gone. */
    const forgetRequests = (project: ProjectId) =>
      Effect.gen(function* () {
        const gone = [...(yield* Ref.get(requests)).values()].filter(
          request =>
            request.project === project && request._tag !== 'permission',
        )
        yield* Effect.forEach(gone, close, { discard: true })
      })

    /** Follows the project's work graph: its requests now, and again on each change. */
    const follow = (project: ProjectId) =>
      Effect.gen(function* () {
        if ((yield* Ref.get(followed)).has(project)) return
        const opened = yield* Effect.option(projects.graph(project))
        if (Option.isNone(opened)) return
        const graph = opened.value
        const held = yield* Scope.fork(scope)
        yield* Ref.update(followed, map => new Map(map).set(project, held))
        const changes = yield* graph.changes.pipe(
          Scope.provide(held),
          Effect.orDie,
        )
        yield* changes.pipe(
          Stream.runForEach(() => sync(project, graph)),
          Effect.catch(error =>
            Effect.logWarning(
              `the attention requests of ${project} stopped following its work graph: ${error.message}`,
            ),
          ),
          Effect.forkIn(held),
        )
        yield* sync(project, graph)
      })

    /** Follows every project, and stops following one that is gone. */
    const reconcile = followLock.withPermit(
      Effect.gen(function* () {
        const ids = new Set(yield* projects.list)
        const was = yield* Ref.get(followed)
        for (const [project, held] of was) {
          if (ids.has(project)) continue
          yield* Scope.close(held, Exit.void)
          yield* Ref.update(followed, map => {
            const next = new Map(map)
            next.delete(project)
            return next
          })
          yield* forgetRequests(project)
        }
        yield* Effect.forEach(ids, follow, { discard: true })
      }),
    )

    /** Starts following the projects, the first time it is asked. */
    const followAll = Effect.gen(function* () {
      const started = yield* Ref.getAndSet(following, true)
      if (!started)
        yield* projects.changed.pipe(
          Stream.runForEach(() => reconcile),
          Effect.forkIn(scope),
        )
      yield* reconcile
    })

    /** The project's requests made current: followed, and read again. */
    const current = (project: ProjectId) =>
      Effect.gen(function* () {
        const graph = yield* projects.graph(project)
        yield* followLock.withPermit(follow(project))
        yield* sync(project, graph)
      })

    const list = Effect.fn('Attention.list')(function* (
      project: Option.Option<ProjectId>,
    ) {
      yield* Option.match(project, {
        onNone: () => followAll,
        onSome: current,
      })
      const items = [...(yield* Ref.get(requests)).values()]
      return Option.match(project, {
        onNone: () => items,
        onSome: id => items.filter(request => request.project === id),
      })
    })

    const projectFeed = (project: ProjectId) =>
      listLock.withPermit(
        Effect.gen(function* () {
          const held = (yield* Ref.get(byProject)).get(project)
          if (held !== undefined) return held
          const items = [...(yield* Ref.get(requests)).values()].filter(
            request => request.project === project,
          )
          const feed = yield* feedOf(items)
          yield* Ref.update(byProject, map => new Map(map).set(project, feed))
          return feed
        }),
      )

    const watch = (input: {
      readonly project: Option.Option<ProjectId>
      readonly resume: Option.Option<Resume>
    }) =>
      Stream.unwrap(
        Option.match(input.project, {
          onNone: () => Effect.as(followAll, all.watch(input.resume)),
          onSome: project =>
            Effect.gen(function* () {
              const feed = yield* projectFeed(project)
              yield* current(project)
              return feed.watch(input.resume)
            }),
        }),
      )

    /** Who answered the request first, where it was answered. */
    const alreadyAnswered = (key: string) =>
      Option.map(
        Option.fromUndefinedOr(answers.get(key)),
        ({ by, at }) => new AlreadyAnswered({ by, at }),
      )

    const graphFor = (ref: AttentionRef) =>
      projects
        .graph(ref.project)
        .pipe(
          Effect.catchTag('ProjectNotFound', () =>
            Effect.fail(new AttentionNotFound({ ref })),
          ),
        )

    /** The question, open or answered; not found where the ticket is none or no question. */
    const questionOf = (
      ref: AttentionRef,
      graph: WorkGraphShape,
      ticket: TicketId,
    ) =>
      graph.show(ticket).pipe(
        Effect.catchTag('TicketNotFound', () =>
          Effect.fail(new AttentionNotFound({ ref })),
        ),
        Effect.orDie,
        Effect.filterOrFail(
          detail => Option.isSome(detail.ticket.question),
          () => new AttentionNotFound({ ref }),
        ),
      )

    /** Writes the answer into each blocked ticket's design; the designs as they were, to put back. */
    const writeDesigns = (
      graph: WorkGraphShape,
      question: Ticket,
      blocks: ReadonlyArray<TicketId>,
      answer: string,
    ) =>
      Effect.forEach(blocks, id =>
        Effect.gen(function* () {
          const { ticket } = yield* graph.show(id)
          yield* graph.update({
            id,
            changes: {
              design: Option.some(
                withAnswer(ticket.design, {
                  question: question.id,
                  title: question.title,
                  answer,
                }),
              ),
            },
            actor: maintainer,
          })
          return { id, design: ticket.design }
        }),
      ).pipe(Effect.orDie)

    const putDesignsBack = (
      graph: WorkGraphShape,
      designs: ReadonlyArray<{
        readonly id: TicketId
        readonly design: Option.Option<string>
      }>,
    ) =>
      Effect.forEach(
        designs,
        ({ id, design }) =>
          Effect.ignore(
            graph.update({ id, changes: { design }, actor: maintainer }),
          ),
        { discard: true },
      )

    const answerQuestion = Effect.fn('Attention.answerQuestion')(function* (
      input: {
        readonly project: ProjectId
        readonly ticket: TicketId
        readonly answer: QuestionAnswer
      },
      by: ClientName,
    ) {
      const ref = AttentionRef.cases.question.make({
        project: input.project,
        ticket: input.ticket,
      })
      const key = attentionKey(ref)
      const graph = yield* graphFor(ref)
      const detail = yield* questionOf(ref, graph, input.ticket)
      const question = detail.ticket
      if (question.status === 'closed') {
        const first = alreadyAnswered(key)
        if (Option.isSome(first)) return yield* first.value
        if (!Option.contains(question.resolution, 'answered'))
          return yield* new AttentionNotFound({ ref })
        const history = yield* Effect.orDie(graph.history(question.id))
        const answered = lastOf(history, 'answered')
        return yield* new AlreadyAnswered({
          by: actorName(Option.flatMap(answered, ({ actor }) => actor)),
          at: Option.match(answered, {
            onNone: () => question.updatedAt,
            onSome: ({ at }) => at,
          }),
        })
      }
      const text = yield* answerText(question, input.answer)
      const { blocks } = linksOf(question.id, detail.edges)
      // The designs first, so the tickets the answer readies carry it as they become ready.
      const designs = yield* writeDesigns(graph, question, blocks, text)
      const answered = new Answered({ by, at: yield* DateTime.now })
      answers.set(key, answered)
      yield* graph
        .answer({ id: question.id, answer: text, actor: maintainer })
        .pipe(
          Effect.tapError(() =>
            Effect.andThen(
              putDesignsBack(graph, designs),
              Effect.sync(() => answers.delete(key)),
            ),
          ),
          Effect.catchTag('TransitionRefused', () =>
            Effect.fail(
              new AlreadyAnswered({
                by: actorName(Option.none()),
                at: answered.at,
              }),
            ),
          ),
          Effect.catchTag(['NotAQuestion', 'TicketNotFound'], () =>
            Effect.fail(new AttentionNotFound({ ref })),
          ),
          Effect.orDie,
        )
      yield* sync(input.project, graph)
      return answered
    })

    /** Allows every waiting request of the same run its new rule takes, with the answer that made it. */
    const allowMatching = (
      rules: Ref.Ref<ReadonlyArray<Rule>>,
      rule: Rule,
      answered: Answered,
    ) =>
      Effect.gen(function* () {
        const matching = [...(yield* Ref.get(pending)).entries()].filter(
          ([, waiting]) =>
            waiting.rules === rules && sameRule(waiting.rule, rule),
        )
        yield* Effect.forEach(
          matching,
          ([key, waiting]) =>
            Effect.andThen(
              Effect.sync(() => answers.set(key, answered)),
              settle(key, waiting, PermissionDecision.cases.allow_run.make({})),
            ),
          { discard: true },
        )
      })

    /** Gives a waiting request its decision and takes it off the list. */
    const settle = (
      key: string,
      waiting: Pending,
      decision: PermissionDecision,
    ) =>
      Effect.gen(function* () {
        yield* Ref.update(pending, map => {
          const next = new Map(map)
          next.delete(key)
          return next
        })
        yield* Deferred.succeed(waiting.decision, decision)
        yield* close(waiting.request)
      })

    const answerPermission = Effect.fn('Attention.answerPermission')(function* (
      input: {
        readonly project: ProjectId
        readonly id: PermissionId
        readonly decision: PermissionDecision
      },
      by: ClientName,
    ) {
      const ref = AttentionRef.cases.permission.make({
        project: input.project,
        id: input.id,
      })
      const key = attentionKey(ref)
      const waiting = (yield* Ref.get(pending)).get(key)
      if (waiting === undefined) {
        const first = alreadyAnswered(key)
        return yield* Option.isSome(first)
          ? Effect.fail(first.value)
          : Effect.fail(new AttentionNotFound({ ref }))
      }
      const answered = new Answered({ by, at: yield* DateTime.now })
      answers.set(key, answered)
      if (input.decision._tag === 'allow_run')
        yield* Ref.update(waiting.rules, rules => [...rules, waiting.rule])
      yield* settle(key, waiting, input.decision)
      // The others it matches are answered with it, by the same client.
      if (input.decision._tag === 'allow_run')
        yield* allowMatching(waiting.rules, waiting.rule, answered)
      return answered
    })

    const answer = (input: {
      readonly answer: AttentionAnswer
      readonly by: ClientName
    }) =>
      answerLock.withPermit(
        input.answer._tag === 'question'
          ? answerQuestion(input.answer, input.by)
          : answerPermission(input.answer, input.by),
      )

    /** Asks the maintainer about a call no rule of the run allows, and waits for the answer. */
    const ask = (
      request: PermissionRequest,
      rules: Ref.Ref<ReadonlyArray<Rule>>,
    ): Effect.Effect<PermissionDecision> =>
      Effect.gen(function* () {
        const rule = ruleOf(request)
        if ((yield* Ref.get(rules)).some(each => sameRule(each, rule)))
          return PermissionDecision.cases.allow_run.make({})
        const id = PermissionId.make(`perm-${yield* drawBase36(12)}`)
        const shown = AttentionRequest.cases.permission.make({
          project: request.project,
          id,
          ticket: request.ticket,
          session: request.session,
          tool: request.tool,
          input: yield* Schema.decodeUnknownEffect(Schema.Json)(
            request.input,
          ).pipe(Effect.orElseSucceed(() => null)),
          shown: request.shown,
          why: request.why,
          openedAt: yield* DateTime.now,
        })
        const key = attentionKey(shown)
        const decision = yield* Deferred.make<PermissionDecision>()
        const waiting: Pending = { request: shown, rule, rules, decision }
        /** Takes the request off the list where it is still there: its agent stopped waiting. */
        const withdraw = answerLock.withPermit(
          Effect.gen(function* () {
            if (!(yield* Ref.get(pending)).has(key)) return
            yield* Ref.update(pending, map => {
              const next = new Map(map)
              next.delete(key)
              return next
            })
            yield* close(shown)
          }),
        )
        return yield* Effect.gen(function* () {
          // Registered under the answers' lock, so a rule an answer adds meanwhile is never missed.
          const ruled = yield* answerLock.withPermit(
            Effect.gen(function* () {
              if ((yield* Ref.get(rules)).some(each => sameRule(each, rule)))
                return true
              yield* Ref.update(pending, map => new Map(map).set(key, waiting))
              yield* put(shown)
              return false
            }),
          )
          if (ruled) return PermissionDecision.cases.allow_run.make({})
          return yield* Deferred.await(decision)
        }).pipe(Effect.onInterrupt(() => withdraw))
      }).pipe(Effect.withSpan('Attention.permission'))

    const forRun = Effect.map(
      Ref.make<ReadonlyArray<Rule>>([]),
      (rules): AttentionShape => ({
        permission: request => ask(request, rules),
      }),
    )

    const revise = Effect.fn('Attention.revise')(function* (input: {
      readonly project: ProjectId
      readonly ticket: TicketId
      readonly answer: QuestionAnswer
      readonly by: ClientName
    }) {
      const ref = AttentionRef.cases.question.make({
        project: input.project,
        ticket: input.ticket,
      })
      const graph = yield* graphFor(ref)
      const detail = yield* questionOf(ref, graph, input.ticket)
      const question = detail.ticket
      if (!Option.contains(question.resolution, 'answered'))
        return yield* new InvalidAnswer({
          reason: `${question.id} hasn't been answered: answer it rather than revise its answer`,
        })
      const text = yield* answerText(question, input.answer)
      const history = yield* Effect.orDie(graph.history(question.id))
      // What came after the old answer, by the history's order.
      const since = Option.match(lastOf(history, 'answered'), {
        onNone: () => 0,
        onSome: ({ seq }) => seq,
      })
      const links = linksOf(question.id, detail.edges)
      const reached = new Set([
        ...links.blocks,
        ...Option.toArray(links.askedFrom),
      ])
      const undone: Array<string> = []
      const kept: Array<string> = []
      const after = (events: ReadonlyArray<TicketEvent>) =>
        events.filter(event => event.seq > since)
      // The sessions that took the tickets up again on the old answer: what they did, it led to.
      const sessions = new Set<string>()
      for (const id of reached) {
        const events = after(yield* Effect.orDie(graph.history(id)))
        const claims = events.flatMap(event =>
          event.change._tag === 'claimed'
            ? [event.change.assignee.session]
            : [],
        )
        for (const session of claims) sessions.add(session)
        if (claims.length > 0)
          kept.push(`${id}'s worker was given the old answer, and worked on it`)
      }
      const byThem = (event: TicketEvent) =>
        Option.exists(
          event.actor,
          actor => actor._tag === 'worker' && sessions.has(actor.session),
        )
      const tickets = yield* Effect.orDie(graph.list())
      for (const ticket of tickets) {
        if (ticket.id === question.id) continue
        const events = after(
          yield* Effect.orDie(graph.history(ticket.id)),
        ).filter(event => reached.has(ticket.id) || byThem(event))
        if (events.length === 0) continue
        if (events.some(event => event.change._tag === 'created'))
          kept.push(
            `${ticket.id} (${ticket.title}) was filed on the old answer: it stays`,
          )
        const closedOnIt = events.some(
          event =>
            event.change._tag === 'closed' &&
            event.change.resolution !== 'answered',
        )
        if (closedOnIt && ticket.status === 'closed') {
          if (Option.isSome(ticket.mergedCommit))
            kept.push(
              `${ticket.id} (${ticket.title}) merged as ${ticket.mergedCommit.value}: its change stays on Base`,
            )
          else {
            yield* Effect.orDie(
              graph.reopen({ id: ticket.id, actor: maintainer }),
            )
            undone.push(`${ticket.id} (${ticket.title}) reopened`)
          }
        }
        const deferredOnIt = events.some(
          event => event.change._tag === 'deferred',
        )
        if (deferredOnIt && ticket.status === 'deferred') {
          yield* Effect.orDie(
            graph.undefer({ id: ticket.id, actor: maintainer }),
          )
          undone.push(`${ticket.id} (${ticket.title}) undeferred`)
        }
      }
      yield* writeDesigns(graph, question, links.blocks, text)
      const answered = new Answered({ by: input.by, at: yield* DateTime.now })
      answers.set(attentionKey(ref), answered)
      yield* Effect.orDie(graph.reopen({ id: question.id, actor: maintainer }))
      yield* Effect.orDie(
        graph.answer({ id: question.id, answer: text, actor: maintainer }),
      )
      yield* sync(input.project, graph)
      return { answered, undone, kept } satisfies Revised
    })

    return {
      list,
      watch,
      answer,
      revise: input => answerLock.withPermit(revise(input)),
      forRun,
    } satisfies AttentionRequestsShape
  })

/** The projects as the daemon keeps them. */
export const daemonProjects = Effect.map(
  Projects,
  (projects): AttentionProjects => ({
    list: Effect.map(projects.list, infos => infos.map(({ id }) => id)),
    changed: projects.watchStatus(Option.none()),
    graph: project =>
      projects
        .workGraph(project)
        .pipe(Effect.catchTag('WorkGraphUnopened', Effect.die)),
  }),
)

/** The attention requests over the daemon's projects. */
export const layer: Layer.Layer<AttentionRequests, never, Projects> =
  Layer.effect(AttentionRequests, Effect.flatMap(daemonProjects, make))
