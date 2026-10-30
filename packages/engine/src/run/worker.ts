import {
  Data,
  Deferred,
  Effect,
  Option,
  Redacted,
  Result,
  Schema,
  Stream,
} from 'effect'

import {
  type Actor,
  Assignee,
  type MergeStanding,
  ModelOverride,
  type RunId,
  type SessionId,
  type Ticket,
  type TicketId,
} from '@fabrica/contracts'

import { PiAgent } from '../agent'
import { ControlRole, ControlServer, Outcome, type OwnCheck } from '../control'
import { readFileText } from '../files'
import { Git, Prepared, type Worktree, Worktrees } from '../git'
import type { MergeQueueShape } from '../merge'
import { ModelProxy } from '../proxy'
import type { RunLog } from '../runlog'
import { WorkGraph } from '../workgraph'
import type { RunConfig } from './config'
import {
  type CitedSpec,
  type Dependency,
  citedSections,
  citingTexts,
  firstPrompt,
  specSection,
} from './prompt'
import { record } from './records'
import { SetUp, setUpWorktree } from './setup'
import type { Started } from './start-checks'

// One dispatch of a ticket (spec §13.2, §12.1, §12.9): claimed, given a worktree from Base (created,
// or reused and rebased), set up, and handed to a fresh worker, a Pi session of its own, with its
// first prompt, its model and its proxy token; its control channel's outcomes come back as the
// worker's end. A hand-back (§13.6) gives the same worker its worktree as it left it and its session
// resumed, with the hand-back's prompt. Everything it opens (the control socket, the proxy's token,
// the agent) is held in its scope and closed with it.

/** How a dispatch's worker starts its turn. */
export type WorkerTurn = Data.TaggedEnum<{
  /** The ticket's first: claimed, its worktree prepared and set up, a new session with the first prompt. */
  First: {}
  /** Handed back (§13.6): its worktree as it was, the session Pi kept resumed, with `prompt`. */
  HandBack: {
    readonly worktree: Worktree
    /** The worker's session file; none starts a new session, the first prompt before `prompt`. */
    readonly session: Option.Option<string>
    readonly prompt: string
  }
}>
export const WorkerTurn = Data.taggedEnum<WorkerTurn>()

/** How a dispatch's worker came out, for the loop. */
export type WorkerEnd = Data.TaggedEnum<{
  /** `finish`: the worktree, what it stood on and the worker's session file, for the verifier and the merge queue. */
  Finished: {
    readonly worktree: Worktree
    readonly checkOwn: OwnCheck
    readonly session: Option.Option<string>
  }
  /** `defer`: set aside, its worktree and session kept. */
  Deferred: { readonly reason: string }
  /** `wait_for`: back in the queue until `ticket` merges. */
  WaitsFor: { readonly ticket: TicketId; readonly needs: string }
  /** `ask_question` about its own ticket: it waits on `question`. */
  Asked: { readonly question: TicketId }
  /** It settled with no outcome tool called (§12.3). */
  Unfinished: {}
  /** A tool failed in the engine under it (§12.8). */
  ToolFailed: { readonly tool: string; readonly reason: string }
  /** Its worktree's setup failed (§13.8). */
  SetupFailed: { readonly detail: string }
  /** It couldn't be dispatched or its worker didn't start: the claim, git, the control socket, Pi. */
  Failed: { readonly reason: string }
}>
export const WorkerEnd = Data.taggedEnum<WorkerEnd>()

/** What a dispatch works with. */
export interface WorkerContext {
  readonly config: RunConfig
  readonly run: RunId
  readonly started: Started
  readonly log: RunLog['Service']
  readonly merges: MergeQueueShape
  readonly actor: Actor
}

/** A model as a ticket's `model` writes it, `anthropic/claude-…`, as the agent's choice. */
const choiceOf = (written: ModelOverride) => {
  const slash = written.indexOf('/')
  return {
    provider: written.slice(0, slash),
    modelId: written.slice(slash + 1),
  }
}

/** The worker's model: the ticket's, else the project's (§12.5). */
export const modelOf = (ticket: Ticket, started: Started) =>
  Option.orElse(
    Option.map(Option.filter(ticket.model, Schema.is(ModelOverride)), choiceOf),
    () =>
      Option.map(started.settings.project.model, choice => ({
        provider: choice.provider,
        modelId: choice.model,
      })),
  )

/** Where the ticket stands in the merge queue, as its gate asks (H59). */
export const standingOf = (
  merges: MergeQueueShape,
  ticket: TicketId,
): Effect.Effect<MergeStanding> =>
  Effect.map(merges.line, line =>
    Option.contains(line.merging, ticket)
      ? 'merging'
      : line.waiting.includes(ticket)
        ? 'waiting'
        : 'not_queued',
  )

/** The spec's sections the ticket cites, read from its worktree as Base has them; none it can't read. */
const citedSpec = (ticket: Ticket, worktree: Worktree) =>
  Option.match(ticket.metadata.spec, {
    onNone: () => Effect.succeed(Option.none<CitedSpec>()),
    onSome: path => {
      const numbers = citedSections(citingTexts(ticket))
      if (numbers.length === 0) return Effect.succeed(Option.none<CitedSpec>())
      return readFileText({ root: worktree.path, path }).pipe(
        Effect.map(text =>
          Option.some<CitedSpec>({
            path,
            sections: numbers.flatMap(number =>
              Option.toArray(
                Option.map(specSection(text, number), section => ({
                  number,
                  text: section,
                })),
              ),
            ),
          }),
        ),
        Effect.catch(() => Effect.succeed(Option.none<CitedSpec>())),
      )
    },
  })

/** The first prompt of the ticket's worker in `worktree`. */
const promptOf = Effect.fn('Run.prompt')(function* (
  ticket: TicketId,
  worktree: Worktree,
) {
  const graph = yield* WorkGraph
  const detail = yield* graph.show(ticket)
  const blockers = detail.edges.filter(
    edge => edge.kind === 'blocks' && edge.to === ticket,
  )
  const [dependencies, spec] = yield* Effect.all(
    [
      Effect.forEach(
        blockers,
        ({ from }) =>
          Effect.map(graph.show(from), ({ ticket: blocker }): Dependency => ({
            id: blocker.id,
            title: blocker.title,
            result: blocker.result,
          })),
        { concurrency: 'unbounded' },
      ),
      citedSpec(detail.ticket, worktree),
    ],
    { concurrency: 2 },
  )
  return {
    ticket: detail.ticket,
    prompt: firstPrompt({ ticket, notes: detail.notes, spec, dependencies }),
  }
})

/** The worktree from Base for the ticket: created, or reused and rebased, a conflicting rebase undone. */
const worktreeFor = Effect.fn('Run.worktree')(function* (
  context: WorkerContext,
  ticket: TicketId,
) {
  const git = yield* Git
  const worktrees = yield* Worktrees
  const base = yield* git.commitHash({
    repo: context.config.checkout,
    revision: `refs/heads/${context.started.base}`,
  })
  if (Option.isNone(base))
    return yield* Effect.fail(
      new DispatchRefused({
        reason: `Base, ${context.started.base}, has no commit`,
      }),
    )
  const prepared = yield* worktrees.prepare({
    home: context.config.home,
    ticket,
    base: base.value,
  })
  // A conflicting rebase of a reused worktree is undone: the merge queue rebases it again, and hands
  // its conflicts back (§13.7).
  yield* Prepared.$match(prepared, {
    Created: () => Effect.void,
    Reused: ({ worktree, rebase }) =>
      rebase._tag === 'Conflict'
        ? Effect.asVoid(git.abortRebase({ worktree: worktree.path }))
        : Effect.void,
  })
  return prepared
})

/** A dispatch that can't go on, in words. */
class DispatchRefused extends Data.TaggedError('DispatchRefused')<{
  readonly reason: string
}> {
  override get message() {
    return this.reason
  }
}

/** What a session's outcome ends its worker as; none for a check, which the turn goes on past. */
const endOf = (
  outcome: Outcome,
  worktree: Worktree,
  session: Option.Option<string>,
): Option.Option<WorkerEnd> =>
  Outcome.$match(outcome, {
    Finished: ({ checkOwn }) =>
      Option.some(WorkerEnd.Finished({ worktree, checkOwn, session })),
    Deferred: ({ reason }) => Option.some(WorkerEnd.Deferred({ reason })),
    WaitsFor: ({ ticket, needs }) =>
      Option.some(WorkerEnd.WaitsFor({ ticket, needs })),
    Asked: ({ question }) => Option.some(WorkerEnd.Asked({ question })),
    Unfinished: () => Option.some(WorkerEnd.Unfinished()),
    Checked: () => Option.none(),
    // The control server refuses a worker's verdict: it never comes.
    Verdict: () => Option.none(),
    ToolFailed: ({ tool, reason }) =>
      Option.some(WorkerEnd.ToolFailed({ tool, reason })),
  })

/** The worktree of the ticket's first turn: claimed, prepared and set up; none where its setup failed. */
const firstWorktree = Effect.fn('Run.firstWorktree')(function* (
  context: WorkerContext,
  ticket: TicketId,
  session: SessionId,
) {
  const graph = yield* WorkGraph
  yield* graph.claim({
    id: ticket,
    assignee: new Assignee({ engine: context.config.engine, session }),
    actor: context.actor,
  })
  const prepared = yield* worktreeFor(context, ticket)
  const setUp = yield* setUpWorktree({ prepared })
  return SetUp.$is('Failed')(setUp)
    ? Result.fail(setUp.detail)
    : Result.succeed(prepared.worktree)
})

/**
 * Dispatches `ticket` under `session` for `turn`: its first claims it, prepares and sets up its
 * worktree; a hand-back takes its worktree as it was. Each opens its control channel and proxy token,
 * starts its agent (a hand-back resuming its session) with its prompt and waits for the turn to
 * settle. Its end is the first outcome its session published that ends a turn; none, it is unfinished.
 */
export const runWorker = Effect.fn('Run.worker')(function* (
  context: WorkerContext,
  ticket: TicketId,
  session: SessionId,
  turn: WorkerTurn,
) {
  const control = yield* ControlServer
  const proxy = yield* ModelProxy
  const agents = yield* PiAgent
  const { config, started } = context
  const project = started.settings.project

  const ready = yield* WorkerTurn.$match(turn, {
    First: () => firstWorktree(context, ticket, session),
    HandBack: ({ worktree: kept }) => Effect.succeed(Result.succeed(kept)),
  })
  if (Result.isFailure(ready))
    return WorkerEnd.SetupFailed({ detail: ready.failure })
  const worktree = ready.success

  const { ticket: shown, prompt: first } = yield* promptOf(ticket, worktree)
  const [prompt, resume] = WorkerTurn.$match(turn, {
    First: () => [first, Option.none<string>()] as const,
    HandBack: ({ session: kept, prompt: handBack }) =>
      [
        Option.isSome(kept) ? handBack : `${first}\n\n${handBack}`,
        kept,
      ] as const,
  })
  const model = modelOf(shown, started)
  const channel = yield* control.open({
    project: config.project,
    ticket,
    session,
    role: ControlRole.Worker(),
    worktree: worktree.path,
    folder: config.sockets,
    questionWait: project.question_wait,
    checkOwn: {
      command: project.check_own,
      checkout: config.checkout,
      timeLimit: project.check_timeout,
      cores: config.cores,
      nice: config.nice,
    },
    mergeStanding: standingOf(context.merges, ticket),
  })
  const granted = yield* proxy.grant({
    run: context.run,
    ticket: Option.some(ticket),
    session: Option.some(session),
    model: Option.match(model, {
      onNone: () => 'none',
      onSome: ({ provider, modelId }) => `${provider}/${modelId}`,
    }),
  })

  // The session's outcomes, read from before the agent starts: its checks to the event stream, and
  // the first that ends a turn kept as the worker's end.
  const ended = yield* Deferred.make<Outcome>()
  yield* channel.outcomes.pipe(
    Stream.runForEach(outcome =>
      Outcome.$is('Checked')(outcome)
        ? record(context.log, outcome.check)
        : Option.isSome(endOf(outcome, worktree, Option.none()))
          ? Effect.asVoid(Deferred.succeed(ended, outcome))
          : Effect.void,
    ),
    Effect.forkScoped,
  )

  const agent = yield* agents.start({
    ticket,
    project: config.project,
    worktree: worktree.path,
    providers: Object.entries(granted.baseUrls).map(([provider, baseUrl]) => ({
      provider,
      baseUrl,
    })),
    token: Redacted.value(granted.token),
    model,
    tools: Option.none(),
    resume,
    env: channel.environment,
    projectTrusted: config.projectTrusted,
    nice: config.nice,
  })
  yield* agent.prompt(prompt)
  // The outcome is published before its tool answers, and the turn settles after: it is here.
  const outcome = yield* Deferred.poll(ended)
  if (Option.isNone(outcome)) return WorkerEnd.Unfinished()
  return Option.getOrElse(
    endOf(yield* outcome.value, worktree, agent.session.file),
    () => WorkerEnd.Unfinished(),
  )
})

/** `runWorker`, its failures to dispatch or start as its end, in its own scope. */
export const dispatchWorker = (
  context: WorkerContext,
  ticket: TicketId,
  session: SessionId,
  turn: WorkerTurn,
) =>
  runWorker(context, ticket, session, turn).pipe(
    Effect.scoped,
    Effect.catch(error =>
      Effect.succeed(WorkerEnd.Failed({ reason: error.message })),
    ),
  )
