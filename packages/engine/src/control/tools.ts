import {
  Deferred,
  type Duration,
  Effect,
  Option,
  Queue,
  Schema,
  Stream,
} from 'effect'

import {
  type Actor,
  Awaited,
  type CheckOwnPass,
  Edge,
  type Ended,
  Filed,
  type FiledLink,
  type Files,
  LinkedTicket,
  Noted,
  type PermissionAsked,
  type PermissionDecision,
  type ProjectId,
  type QuestionChoices,
  RepoPath,
  type SessionId,
  type TicketId,
  TicketMetadata,
  type TicketResult,
  TicketView,
  ToolRefusal,
} from '@fabrica/contracts'

import {
  type CantTell,
  type GitShape,
  type WorktreeStatus,
  isClean,
} from '../git'
import type { Wake } from '../time'
import type {
  EdgeCycle,
  InvalidTicket,
  StoreFailed,
  TicketNotFound,
  TransitionRefused,
  WorkGraphShape,
} from '../workgraph'
import { Outcome } from './outcome'
import type { AttentionShape, CheckOwnPassesShape } from './ports'
import { inScope } from './token'

// The worker's tools, the engine's side (spec §12.3, §13.5): what each does to the work graph, what
// it refuses, and the outcome it publishes for the run loop. A tool acts for its session alone: on
// its own ticket, or one linked to it. A refusal (`ToolRefusal`) is the agent's to correct; a failure
// in the engine (the store, git) is a defect of the call, published as `ToolFailed` (§12.8).

/** The agent's session the tools act for, and the services they act through. */
export interface ToolContext {
  readonly project: ProjectId
  readonly ticket: TicketId
  readonly session: SessionId
  readonly worktree: string
  /** How long `ask_and_wait` holds the agent for an answer, in time awake. */
  readonly questionWait: Duration.Input
  readonly graph: WorkGraphShape
  readonly git: GitShape
  readonly wake: Wake['Service']
  readonly passes: CheckOwnPassesShape
  readonly attention: AttentionShape
  readonly outcomes: Queue.Queue<Outcome>
}

/** A question's fields, as `ask_question` and `ask_and_wait` take them. */
interface Asking {
  readonly title: string
  readonly description: string
  readonly choices: QuestionChoices
  readonly consequential: boolean
  readonly maintainerOnly: boolean
  readonly blocks: Option.Option<TicketId>
}

const refuse = {
  invalid: (issue: string) =>
    Effect.fail(ToolRefusal.cases.invalid.make({ issue })),
  outOfScope: (ticket: TicketId) =>
    Effect.fail(ToolRefusal.cases.out_of_scope.make({ ticket })),
  dirty: (status: WorktreeStatus) =>
    Effect.fail(
      ToolRefusal.cases.worktree_dirty.make({
        uncommitted: status.uncommitted.filter(Schema.is(RepoPath)),
        untracked: status.untracked.filter(Schema.is(RepoPath)),
      }),
    ),
}

const ended: Ended = {}

/** What fails in the engine rather than on the call's arguments: the store, git. */
type EngineError =
  | StoreFailed
  | TicketNotFound
  | InvalidTicket
  | EdgeCycle
  | TransitionRefused
  | CantTell

/** A failure in the engine, told from a refusal: refusals are plain values, never errors. */
const isEngineError = (
  error: ToolRefusal | EngineError,
): error is EngineError => error instanceof Error

export const makeTools = (context: ToolContext) => {
  const { ticket, graph, git, outcomes } = context
  const actor: Actor = { _tag: 'worker', session: context.session }

  const publish = (outcome: Outcome) => Queue.offer(outcomes, outcome)

  /** The call's failures in the engine, as defects, each published first; its refusals stay. */
  const engineFault =
    (tool: string) =>
    <A, R>(
      effect: Effect.Effect<A, ToolRefusal | EngineError, R>,
    ): Effect.Effect<A, ToolRefusal, R> =>
      Effect.catchIf(effect, isEngineError, error =>
        Effect.andThen(
          publish(Outcome.ToolFailed({ tool, reason: error.message })),
          Effect.die(error),
        ),
      )

  /** The session's own ticket, read again for each call: what it links to changes as the session files. */
  const own = graph.show(ticket)

  /** Refuses a target the token doesn't reach. */
  const requireScope = Effect.fn('Control.requireScope')(function* (
    target: TicketId,
  ) {
    if (target === ticket) return
    const { edges } = yield* own
    if (!inScope({ own: ticket, edges, target }))
      return yield* refuse.outOfScope(target)
  })

  const getTicket = (input: { readonly id: Option.Option<TicketId> }) =>
    Effect.gen(function* () {
      const target = Option.getOrElse(input.id, () => ticket)
      yield* requireScope(target)
      const detail = yield* graph.show(target)
      const blockers = detail.edges.filter(
        edge => edge.kind === 'blocks' && edge.to === target,
      )
      const dependencies = yield* Effect.forEach(
        blockers,
        ({ from }) =>
          Effect.map(
            graph.show(from),
            ({ ticket: blocker }) =>
              new LinkedTicket({
                id: blocker.id,
                title: blocker.title,
                result: blocker.result,
              }),
          ),
        { concurrency: 'unbounded' },
      )
      return new TicketView({
        ticket: detail.ticket,
        labels: detail.labels,
        notes: detail.notes,
        edges: detail.edges,
        dependencies,
      })
    }).pipe(engineFault('get_ticket'), Effect.withSpan('Control.get_ticket'))

  const fileTicket = (input: {
    readonly title: string
    readonly description: string
    readonly type: 'task' | 'bug' | 'feature' | 'chore'
    readonly priority: Option.Option<number>
    readonly files: Files
    readonly labels: Option.Option<ReadonlyArray<string>>
    readonly link: FiledLink
  }) =>
    Effect.gen(function* () {
      const metadata = yield* Schema.decodeUnknownEffect(TicketMetadata)(
        input.files === 'unknown' ? {} : { files: input.files },
      ).pipe(Effect.catch(issue => refuse.invalid(issue.message)))
      const filed = yield* graph
        .fileDiscovered({
          from: ticket,
          link: input.link,
          ticket: {
            type: input.type,
            title: input.title,
            description: input.description,
            ...Option.match(input.priority, {
              onNone: () => ({}),
              onSome: priority => ({ priority }),
            }),
            ...Option.match(input.labels, {
              onNone: () => ({}),
              onSome: labels => ({ labels }),
            }),
            metadata,
          },
          actor,
        })
        .pipe(
          Effect.catchTag(['InvalidTicket', 'EdgeCycle'], error =>
            refuse.invalid(error.message),
          ),
        )
      return new Filed({ id: filed.id })
    }).pipe(engineFault('file_ticket'), Effect.withSpan('Control.file_ticket'))

  /** Files the question, blocking its ticket, and links it to the session's ticket it was asked from. */
  const ask = Effect.fn('Control.ask')(function* (
    input: Asking,
    target: TicketId,
  ) {
    const question = yield* graph.ask({
      question: {
        title: input.title,
        description: input.description,
        choices: input.choices,
        consequential: input.consequential,
        maintainerOnly: input.maintainerOnly,
        blocks: [target],
      },
      actor,
    })
    yield* graph.addDependency({
      edge: new Edge({
        from: question.id,
        to: ticket,
        kind: 'discovered_from',
      }),
      actor,
    })
    return question.id
  })

  const askQuestion = (input: Asking) =>
    Effect.gen(function* () {
      const target = Option.getOrElse(input.blocks, () => ticket)
      yield* requireScope(target)
      const question = yield* ask(input, target)
      if (target === ticket) yield* publish(Outcome.Asked({ question }))
      return new Filed({ id: question })
    }).pipe(
      engineFault('ask_question'),
      Effect.withSpan('Control.ask_question'),
    )

  const askAndWait = (input: Asking) =>
    Effect.scoped(
      Effect.gen(function* () {
        const target = Option.getOrElse(input.blocks, () => ticket)
        yield* requireScope(target)
        // The wait starts before the question is filed, and the answers are watched from before it,
        // so neither an answer nor the time it takes can slip past.
        const due = yield* context.wake.deadline(context.questionWait)
        const changes = yield* graph.changes
        const question = yield* ask(input, target)
        const answer = yield* Deferred.make<string, never>()
        yield* changes.pipe(
          Stream.filter(event => Option.contains(event.ticketId, question)),
          Stream.map(event => event.change),
          Stream.filter(change => change._tag === 'answered'),
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.never,
              onSome: change => Deferred.succeed(answer, change.answer),
            }),
          ),
          // A store that fails while it waits leaves the wait to run out.
          Effect.ignore,
          Effect.forkScoped,
        )
        const answered = yield* Effect.raceFirst(
          Effect.asSome(Deferred.await(answer)),
          Effect.as(context.wake.waitUntil(due), Option.none<string>()),
        )
        return yield* Option.match(answered, {
          onSome: text =>
            Effect.succeed(
              Awaited.cases.answered.make({ question, answer: text }),
            ),
          onNone: () =>
            Effect.as(
              target === ticket
                ? publish(Outcome.Asked({ question }))
                : Effect.void,
              Awaited.cases.unanswered.make({ question }),
            ),
        })
      }),
    ).pipe(engineFault('ask_and_wait'), Effect.withSpan('Control.ask_and_wait'))

  const addNote = (input: { readonly body: string }) =>
    Effect.map(
      graph.note({ id: ticket, body: input.body, actor }),
      note => new Noted({ id: note.id }),
    ).pipe(engineFault('add_note'), Effect.withSpan('Control.add_note'))

  const finish = (input: {
    readonly checkOwn: CheckOwnPass
    readonly result: TicketResult
  }) =>
    Effect.gen(function* () {
      const { checkOwn, result } = input
      const [detail, status] = yield* Effect.all(
        [own, git.status({ worktree: context.worktree })],
        { concurrency: 2 },
      )
      const expected = Option.getOrElse(
        detail.ticket.metadata.result_kind,
        () => 'summary' as const,
      )
      if (result._tag !== expected)
        return yield* Effect.fail(
          ToolRefusal.cases.wrong_result_kind.make({
            expected,
            given: result._tag,
          }),
        )
      if (!isClean(status)) return yield* refuse.dirty(status)
      const [head, tree] = yield* Effect.all(
        [
          git.commitHash({ repo: context.worktree, revision: 'HEAD' }),
          git.treeHash({ repo: context.worktree, revision: 'HEAD' }),
        ],
        { concurrency: 2 },
      )
      if (!Option.contains(head, checkOwn.commit))
        return yield* refuse.invalid(
          `${checkOwn.commit} isn't HEAD (${Option.getOrElse(head, () => 'none')}): finish the commit the worktree is on`,
        )
      if (!Option.contains(tree, checkOwn.tree))
        return yield* refuse.invalid(
          `${checkOwn.tree} isn't HEAD's tree (${Option.getOrElse(tree, () => 'none')})`,
        )
      if (!(yield* context.passes.passed({ ticket, tree: checkOwn.tree })))
        return yield* Effect.fail(
          ToolRefusal.cases.check_own_not_passed.make({ tree: checkOwn.tree }),
        )
      yield* graph.update({
        id: ticket,
        changes: { result: Option.some(result) },
        actor,
      })
      yield* publish(Outcome.Finished({ result, checkOwn }))
      return ended
    }).pipe(engineFault('finish'), Effect.withSpan('Control.finish'))

  const defer = (input: { readonly reason: string }) =>
    Effect.gen(function* () {
      yield* graph.note({ id: ticket, body: input.reason, actor })
      yield* graph.defer({ id: ticket, until: Option.none(), actor })
      yield* publish(Outcome.Deferred({ reason: input.reason }))
      return ended
    }).pipe(engineFault('defer'), Effect.withSpan('Control.defer'))

  const waitFor = (input: {
    readonly ticket: TicketId
    readonly needs: string
  }) =>
    Effect.gen(function* () {
      if (input.ticket === ticket)
        return yield* refuse.invalid("a ticket can't wait for itself")
      const status = yield* git.status({ worktree: context.worktree })
      if (status.uncommitted.length > 0) return yield* refuse.dirty(status)
      yield* graph
        .addDependency({
          edge: new Edge({ from: input.ticket, to: ticket, kind: 'blocks' }),
          actor,
        })
        .pipe(
          Effect.catchTag(['TicketNotFound', 'EdgeCycle'], error =>
            refuse.invalid(error.message),
          ),
        )
      yield* graph.note({
        id: ticket,
        body: `Waiting on ${input.ticket} to merge: ${input.needs}`,
        actor,
      })
      yield* publish(
        Outcome.WaitsFor({ ticket: input.ticket, needs: input.needs }),
      )
      return ended
    }).pipe(engineFault('wait_for'), Effect.withSpan('Control.wait_for'))

  const requestPermission = (
    input: PermissionAsked,
  ): Effect.Effect<PermissionDecision> =>
    context.attention
      .permission({
        project: context.project,
        ticket,
        session: context.session,
        toolCall: input.toolCall,
        tool: input.tool,
        input: input.input,
        shown: input.shown,
        why: input.why,
      })
      .pipe(Effect.withSpan('Control.request_permission'))

  const reportUnfinished = publish(Outcome.Unfinished()).pipe(
    Effect.asVoid,
    Effect.withSpan('Control.report_unfinished'),
  )

  return {
    getTicket,
    fileTicket,
    askQuestion,
    askAndWait,
    addNote,
    finish,
    defer,
    waitFor,
    requestPermission,
    reportUnfinished,
  }
}
