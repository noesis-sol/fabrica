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
  type CommitHash,
  type MergeStanding,
  ModelName,
  ModelOverride,
  PermissionsVariable,
  type RunId,
  type SessionId,
  type SetAsideReason,
  type Ticket,
  type TicketId,
} from '@fabrica/contracts'

import { PiAgent } from '../agent'
import { ControlRole, ControlServer, Outcome, type OwnCheck } from '../control'
import type { CostAccount } from '../cost'
import { readFileText } from '../files'
import { Git, Prepared, type Worktree, Worktrees } from '../git'
import {
  type MergeQueueShape,
  type MergeSetupShape,
  SetupOutcome,
} from '../merge'
import { ModelProxy } from '../proxy'
import type { RunLog } from '../runlog'
import type { WorkerDesk } from '../view'
import { WorkGraph } from '../workgraph'
import {
  type CarrySessionsShape,
  type ResumeWhy,
  type SavedSession,
  SessionLeft,
  beganNow,
  changesSince,
  resumePrompt,
} from './carryover'
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
import { setUpWorktree } from './setup'
import type { Started } from './start-checks'
import type { Attempt } from './supervisor'
import { recordTurns } from './turns'

// One dispatch of a ticket (spec §13.2, §12.1, §12.9): claimed, given a worktree from Base (created,
// or reused and rebased), set up, and handed to a fresh worker, a Pi session of its own, with its
// first prompt, its model and its proxy token; its control channel's outcomes come back as the
// worker's end. A hand-back (§13.6) gives the same worker its worktree as it left it and its session
// resumed, with the hand-back's prompt. Everything it opens (the control socket, the proxy's token,
// the agent) is held in its scope and closed with it. A resume (§13.2, H76: carried over, answered,
// undeferred) claims the ticket again and gives a worker its worktree as it was and its saved session
// resumed, told why and what changed since it began; its worktree gone, it starts afresh. Each saves
// its session for the carry-over once its agent has started (H75).

/** How a dispatch's worker starts its turn. */
export type WorkerTurn = Data.TaggedEnum<{
  /** The ticket's first: claimed, its worktree prepared and set up, a new session with the first prompt. */
  First: {}
  /** Started again in its worktree as it is, a new session with the first prompt: another model's (§12.5). */
  Again: { readonly worktree: Worktree }
  /** Handed back (§13.6): its worktree as it was, the session Pi kept resumed, with `prompt`. */
  HandBack: {
    readonly worktree: Worktree
    /** The worker's session file; none starts a new session, the first prompt before `prompt`. */
    readonly session: Option.Option<string>
    readonly prompt: string
  }
  /** Resumed (§13.2, H76): claimed again, its worktree as it was, its saved session told `why`. */
  Resume: { readonly saved: SavedSession; readonly why: ResumeWhy }
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
  /** Its agent didn't start: Pi's spawn or handshake (§12.8's `StartFailed`). */
  NotStarted: { readonly reason: string }
  /** Its supervision set it aside (§12.8, §14.5): past `ticket_limit`, stuck twice, over its budget. */
  SetAside: { readonly reason: SetAsideReason; readonly note: string }
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
  /** The project's setup, as a dispatch sets its worktree up (§13.8). */
  readonly setup: MergeSetupShape
  /** The run's saved sessions, for the carry-over (§13.10). */
  readonly sessions: CarrySessionsShape
  readonly actor: Actor
  /** The run's workers as the maintainer reaches them: a worker's turns go through it (§18.4). */
  readonly desk: WorkerDesk
  /** The run's cost account, which each session's `turn` records take their spend from (§14.4). */
  readonly cost: CostAccount
}

/** What a released worker is told, where it hasn't settled its ticket (§18.4). */
export const releasedPrompt =
  'The maintainer has released you: carry on with your ticket, and settle it with an outcome tool (finish, defer, wait_for or ask_question).'

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

/** The variables every agent of the run gets beyond its channel's: the project's `permissions`, the level its gate enforces (§12.6). */
export const runVariables = (
  started: Started,
): Readonly<Record<string, string>> => ({
  [PermissionsVariable]: started.settings.project.permissions,
})

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

/**
 * The worktree from Base for the ticket: created, or reused and rebased, a conflicting rebase undone;
 * with the Base commit it was prepared from.
 */
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
  return { prepared, base: base.value }
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

/** Claims the ticket for the worker's session. */
const claimFor = (
  context: WorkerContext,
  ticket: TicketId,
  session: SessionId,
) =>
  Effect.gen(function* () {
    const graph = yield* WorkGraph
    return yield* graph.claim({
      id: ticket,
      assignee: new Assignee({ engine: context.config.engine, session }),
      actor: context.actor,
    })
  })

/**
 * The worktree of the ticket's first turn, the ticket claimed: prepared and set up, with the Base
 * commit it was prepared from; none where its setup failed.
 */
const firstWorktree = Effect.fn('Run.firstWorktree')(function* (
  context: WorkerContext,
  ticket: TicketId,
) {
  const { prepared, base } = yield* worktreeFor(context, ticket)
  const project = context.started.settings.project
  const setUp = yield* setUpWorktree(yield* Git, context.setup, {
    ticket,
    prepared,
    base,
    command: project.setup,
    patterns: project.setup_files,
  })
  return SetupOutcome.$is('Failed')(setUp)
    ? Result.fail(setUp.detail)
    : Result.succeed({ worktree: prepared.worktree, base })
})

/** How a turn's worker starts, its worktree ready: its prompt, the session it resumes, its saved session's base. */
interface Begun {
  readonly worktree: Worktree
  /** None: the first prompt alone; some: this text, after the first prompt where nothing is resumed. */
  readonly prompt: Option.Option<string>
  readonly resume: Option.Option<string>
  /** The Base commit its worktree was prepared from, its session beginning now; none keeps the saved one's. */
  readonly base: Option.Option<CommitHash>
}

/**
 * The turn's worktree and how its worker starts: a first turn's claimed, prepared and set up; another
 * go's and a hand-back's as they are; a resume's claimed again and as it was, or, gone, prepared afresh as a first
 * turn's. A failed setup is its detail.
 */
const begin = Effect.fn('Run.begin')(function* (
  context: WorkerContext,
  ticket: TicketId,
  session: SessionId,
  turn: WorkerTurn,
) {
  const afresh = Effect.gen(function* () {
    const first = yield* firstWorktree(context, ticket)
    return Result.map(first, ({ worktree, base }): Begun => ({
      worktree,
      prompt: Option.none(),
      resume: Option.none(),
      base: Option.some(base),
    }))
  })
  return yield* WorkerTurn.$match(turn, {
    First: () => Effect.andThen(claimFor(context, ticket, session), afresh),
    // A new session in the worktree as it is, its saved session's Base commit kept.
    Again: ({ worktree }) =>
      Effect.map(context.sessions.saved(ticket), saved =>
        Result.succeed<Begun>({
          worktree,
          prompt: Option.none(),
          resume: Option.none(),
          base: Option.map(saved, ({ base }) => base),
        }),
      ),
    HandBack: ({ worktree, session: kept, prompt }) =>
      Effect.succeed(
        Result.succeed<Begun>({
          worktree,
          prompt: Option.some(prompt),
          resume: kept,
          base: Option.none(),
        }),
      ),
    Resume: ({ saved, why }) =>
      Effect.gen(function* () {
        yield* claimFor(context, ticket, session)
        const listed = yield* (yield* Worktrees).list({
          home: context.config.home,
        })
        const kept = listed.find(entry => entry.ticket === ticket)
        if (kept === undefined) {
          yield* context.sessions.drop(ticket)
          return yield* afresh
        }
        const changes = changesSince(
          saved.began,
          yield* beganNow({
            checkout: context.config.checkout,
            started: context.started,
          }),
        )
        return Result.succeed<Begun>({
          worktree: {
            ticket: kept.ticket,
            path: kept.path,
            branch: kept.branch,
          },
          prompt: Option.some(resumePrompt({ ticket, why, changes })),
          resume: Option.some(saved.session),
          base: Option.some(saved.base),
        })
      }),
  })
})

/**
 * Dispatches `ticket` under `session` for its attempt's turn: its first claims it, prepares and sets
 * up its worktree; another go or a hand-back takes its worktree as it is. Each opens its control
 * channel and proxy token, starts its agent on the attempt's model (a hand-back resuming its session)
 * with its prompt and waits for the turn to settle, telling its watcher its worktree, its session and
 * its agent's events. Its end is the first outcome its session published that ends a turn; none, it is
 * unfinished.
 */
export const runWorker = Effect.fn('Run.worker')(function* (
  context: WorkerContext,
  ticket: TicketId,
  session: SessionId,
  { turn, model, watcher }: Attempt,
) {
  const control = yield* ControlServer
  const proxy = yield* ModelProxy
  const agents = yield* PiAgent
  const { config, started } = context
  const project = started.settings.project

  const ready = yield* begin(context, ticket, session, turn)
  if (Result.isFailure(ready))
    return WorkerEnd.SetupFailed({ detail: ready.failure })
  const { worktree, resume } = ready.success
  yield* watcher.prepared(worktree)

  const { prompt: first } = yield* promptOf(ticket, worktree)
  const prompt = Option.match(ready.success.prompt, {
    onNone: () => first,
    onSome: text => (Option.isSome(resume) ? text : `${first}\n\n${text}`),
  })
  const modelText = Option.match(model, {
    onNone: () => 'none',
    onSome: ({ provider, modelId }) => `${provider}/${modelId}`,
  })
  const modelName = Schema.is(ModelName)(modelText) ? modelText : 'none'
  yield* context.desk.enter({ ticket, session, model: modelName })
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
    model: modelText,
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
    env: { ...channel.environment, ...runVariables(started) },
    projectTrusted: config.projectTrusted,
    nice: config.nice,
  })
  yield* watcher.started(agent.session.file)
  yield* (yield* agent.events).pipe(
    Stream.runForEach(watcher.heard),
    Effect.forkScoped,
  )
  yield* recordTurns({
    log: context.log,
    cost: context.cost,
    ticket: Option.some(ticket),
    session,
    model: modelName,
    events: yield* agent.events,
  })
  // Saved for the carry-over once the agent has started (H75): a session beginning now with what it
  // begins with, a hand-back's under the session it had.
  yield* Option.match(agent.session.file, {
    onNone: () => Effect.void,
    onSome: file =>
      Option.match(ready.success.base, {
        onNone: () =>
          Effect.flatMap(context.sessions.saved(ticket), saved =>
            Option.match(saved, {
              onNone: () => Effect.void,
              onSome: kept => context.sessions.save({ ...kept, session: file }),
            }),
          ),
        onSome: base =>
          Effect.flatMap(
            beganNow({ checkout: config.checkout, started }),
            began =>
              context.sessions.save({
                ticket,
                session: file,
                base,
                left: SessionLeft.cases.working.make({}),
                began,
              }),
          ),
      }),
  })
  // The engine's prompt, the maintainer's turns before it and after it while they steer the worker.
  yield* context.desk.converse({
    ticket,
    agent,
    prompt,
    released: releasedPrompt,
    settled: Deferred.isDone(ended),
  })
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
  attempt: Attempt,
) =>
  runWorker(context, ticket, session, attempt).pipe(
    Effect.scoped,
    Effect.catchTag('AgentStartFailed', error =>
      Effect.succeed(WorkerEnd.NotStarted({ reason: error.message })),
    ),
    Effect.catch(error =>
      Effect.succeed(WorkerEnd.Failed({ reason: error.message })),
    ),
  )
