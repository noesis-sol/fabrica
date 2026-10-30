import {
  Cause,
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  FiberSet,
  Option,
  Ref,
  Scope,
  Stream,
} from 'effect'

import {
  type Actor,
  type CommitHash,
  type DoneKind,
  type EndKind,
  type ExitCode,
  type HoldBack,
  type MergeStep,
  Phase,
  SessionId,
  type SetAsideReason,
  type StopKind,
  type Ticket,
  type TicketId,
  WaitFor,
  exitCodeOf,
  factsOf,
} from '@fabrica/contracts'

import { PiAgent } from '../agent'
import { Checks } from '../checks'
import { footprintParts } from '../footprints'
import { Git, Worktrees, isClean, ticketBranch } from '../git'
import { QUICK_SETTLE, makeHolds, stopping } from '../holds'
import {
  type MergeQueueShape,
  MergeSetup,
  type MergeSetupShape,
  MergeUpdate,
  clearAside,
  isOutcome,
  make as makeMergeQueue,
} from '../merge'
import { HandBackClock } from '../merge/handbacks'
import { ModelProxy } from '../proxy'
import {
  RunLog,
  dispatchingLine,
  footprintLine,
  mergedLine,
  mergesWaitLine,
  recordBattery,
  settledLine,
  shortCommit,
  warningLine,
  wroteLine,
} from '../runlog'
import { KeptAwake, keepAwake } from '../time'
import { type RunViewSources, makeRunViewSources } from '../view'
import { WorkGraph } from '../workgraph'
import { drawBase36 } from '../workgraph/ids'
import {
  ResumeWhy,
  type SavedSession,
  SessionLeft,
  carryOver,
  closeMerged,
  mergedOnBase,
  resumeWords,
} from './carryover'
import { type RunConfig, RunMode, overnightMode } from './config'
import { type RunControl, makeRunControl } from './control'
import { endSteps } from './end'
import { type Gated, type Taken, makeFootprintsGate } from './footprints-gate'
import {
  MayTake,
  heldClock,
  makeEnvironmentHold,
  mayTake,
  minimalAgent,
  providerHeld,
  settleOf,
  supervisorHolds,
  waitsOnHold,
} from './holds'
import { record } from './records'
import {
  SetupRetry,
  makeProjectSetup,
  setupRetries,
  setupWaiting,
  setupWaitsLines,
} from './setup'
import { StartChecked, type Started, runStartChecks } from './start-checks'
import {
  type RunSnapshot,
  type RunStateShape,
  inPhase,
  inProgress,
  makeRunState,
  slotsTaken,
} from './state'
import { makeSupervision, toolFollowUp } from './supervisor'
import {
  Verified,
  type VerifierRound,
  handBackPrompt,
  roundText,
  verifyFinished,
} from './verify'
import { WakeReason, readsReady } from './wakes'
import {
  type WorkerContext,
  WorkerEnd,
  WorkerTurn,
  dispatchWorker,
  modelOf,
} from './worker'

// The run loop (spec §13, §13.1, §13.2, §13.5, §13.9, H58): one run of a project. Its start checks
// list every problem together; then it fills its free slots at once and on every change, each wake
// carrying its reasons; each worker's outcome moves its ticket (through the verifier to the merge
// queue, set aside, back in the queue until another merges, waiting on a question), and each merge's;
// a verifier's FAIL hands the change back to its worker (§13.6); and when nothing is in
// progress and nothing more can be dispatched, it ends: supervision stopped first, sessions closed all
// at once, its end line, and its exit code. The run's state has one owner (`state.ts`); the loop is
// one fiber, woken by the workers, the merge queue, the work graph and its control (`control.ts`): a
// stop ends it `INTERRUPTED`; a drain dispatches nothing more, and the run ends `DRAINED` once nothing
// is in progress. Its start takes up what an earlier run left (`carryover.ts`, §13.10): each ticket
// with a saved session, carried over, answered or undeferred, resumes it as a dispatch does, in a free
// slot (H76); a ticket merged by hand is noticed as Base moves.

/** How a run ended, and the exit code the CLI exits with (§13.11). */
export interface RunEnd {
  readonly kind: EndKind
  readonly code: ExitCode
}

/** What the loop decided ends the run. */
type Ending = Data.TaggedEnum<{
  /** It ended by itself: nothing more to do. */
  Done: { readonly kind: DoneKind }
  /** Something stopped it. */
  Stop: {
    readonly kind: StopKind
    readonly ticket: Option.Option<TicketId>
    readonly detail: string
  }
}>
const Ending = Data.taggedEnum<Ending>()

/** A worker's session, as its claim and its control channel name it. */
const drawSession = Effect.map(drawBase36(16), random =>
  SessionId.make(`worker-${random}`),
)

/** The ticket and every ticket below it by `parent` edges (§13.1, `--ticket`). */
const descendants = (
  root: TicketId,
  edges: ReadonlyArray<{
    readonly from: TicketId
    readonly to: TicketId
    readonly kind: string
  }>,
): ReadonlySet<TicketId> => {
  const found = new Set<TicketId>([root])
  let added = true
  while (added) {
    added = false
    for (const edge of edges)
      if (
        edge.kind === 'parent' &&
        found.has(edge.from) &&
        !found.has(edge.to)
      ) {
        found.add(edge.to)
        added = true
      }
  }
  return found
}

/**
 * The phases a ticket can be dispatched from: back in the queue, but not until a merge or a probe where
 * its setup failed, nor until the probe where an environment hold put it back; or waiting on its
 * question, which a ready ticket's answer closed.
 */
const dispatchable = (snapshot: RunSnapshot, ticket: TicketId): boolean => {
  const taken = snapshot.tickets.get(ticket)
  return (
    taken === undefined ||
    taken.phase._tag === 'queued' ||
    taken.phase._tag === 'held_back' ||
    taken.phase._tag === 'asked' ||
    (taken.phase._tag === 'waiting' && taken.phase.for._tag === 'merge')
  )
}

/** The phases where a ticket's branch is no worker's or merge's now: a hand merge of it is noticed there. */
const outOfHand = (snapshot: RunSnapshot, ticket: TicketId): boolean => {
  const taken = snapshot.tickets.get(ticket)
  return (
    taken === undefined ||
    !(
      factsOf(taken.phase).takesSlot ||
      taken.phase._tag === 'waiting_to_merge' ||
      taken.phase._tag === 'merging' ||
      taken.phase._tag === 'merged' ||
      taken.phase._tag === 'no_change'
    )
  )
}

/** What the queue holds back, on a `dispatch` record: how many, by reason, and the solo ticket in line. */
const heldIn = (gated: Gated) => {
  const byReason: Partial<Record<HoldBack, number>> = {}
  for (const { reason } of gated.held)
    byReason[reason] = (byReason[reason] ?? 0) + 1
  return {
    ...(gated.held.length === 0
      ? {}
      : { held: gated.held.length, held_by: byReason }),
    ...Option.match(gated.solo, {
      onNone: () => ({}),
      onSome: ({ ticket, next }) => ({
        solo: next ? { ticket, next: true as const } : { ticket },
      }),
    }),
  }
}

/** The words of a merge's step on its phase record. */
const stepCause = (step: MergeStep): string => `merge: ${step}`

/** How long a run's transcripts wait to cross where its view isn't given: `stream_flush`'s default. */
const defaultFlush = Duration.millis(50)

/**
 * Runs the project's run to its end, its records written through the RunLog; `control` stops or
 * drains it from outside, and hears its start checks' answer; `view` is what the run writes its view
 * from (§8.3), a run of its own where none is given.
 */
export const runProject = Effect.fn('Run.project')(function* (
  config: RunConfig,
  given?: RunControl,
  view?: RunViewSources,
) {
  if (view === undefined) {
    const scope = yield* Scope.make()
    const sources = yield* makeRunViewSources({ flush: defaultFlush, scope })
    return yield* runViewed(config, given, sources.sources).pipe(
      Effect.ensuring(Scope.close(scope, Exit.void)),
    )
  }
  return yield* runViewed(config, given, view)
})

/** `runProject`, its view's sources given. */
const runViewed = Effect.fn('Run.viewed')(function* (
  config: RunConfig,
  given: RunControl | undefined,
  view: RunViewSources,
) {
  const log = yield* RunLog
  const run = log.run
  const control = given ?? (yield* makeRunControl)
  const checked = yield* view.steps.during('start_checks')(
    runStartChecks({ config, run, log }),
  )
  yield* Deferred.succeed(control.checked, checked)
  if (StartChecked.$is('Problems')(checked)) {
    // Every problem together, then the stop: exit 2 (§13.1).
    yield* Effect.forEach(
      checked.problems,
      problem =>
        record(log, {
          kind: 'warn',
          text: warningLine({ tag: 'SETUP', about: 'run', text: problem }),
        }),
      { discard: true },
    )
    const count = checked.problems.length
    yield* record(log, {
      kind: 'stop',
      detail: 'SETUP',
      text: `SETUP: the run didn't start: ${count === 1 ? 'a problem' : `${count} problems`}`,
    })
    const code = exitCodeOf('SETUP')
    yield* record(log, { kind: 'end', code })
    return { kind: 'SETUP', code } satisfies RunEnd
  }
  return yield* Effect.scoped(
    runStarted(config, checked.started, control, view),
  )
})

/** The run once its start checks passed: until it ends, within its scope. */
const runStarted = Effect.fn('Run.started')(function* (
  config: RunConfig,
  started: Started,
  control: RunControl,
  view: RunViewSources,
) {
  const log = yield* RunLog
  const graph = yield* WorkGraph
  const git = yield* Git
  const worktrees = yield* Worktrees
  const run = log.run
  const project = started.settings.project
  const actor: Actor = { _tag: 'engine', engine: config.engine }
  const { limit } = config.options

  // What an earlier run moved aside and left is deleted beside the start, which doesn't wait on it (§13.7).
  yield* Effect.forkDetach(clearAside(config.home))

  // Getting ready (H80): each of the start's steps said as it ends. The carry-over first, before
  // anything writes the run's state (§13.10): a stop during it cuts it short.
  const carried = yield* view.steps.during('carry_over')(
    carryOver({
      checkout: config.checkout,
      home: config.home,
      base: started.base,
      engine: config.engine,
      actor,
      log,
      stopping: Effect.map(control.state, now => now === 'stopping'),
    }),
  )
  const sessions = carried.sessions
  const carriedWords = [
    ...(carried.toResume.length === 0
      ? []
      : [`${carried.toResume.length} to resume`]),
    ...(carried.toMerge.length === 0
      ? []
      : [`${carried.toMerge.length} back in line to merge`]),
    ...(carried.merged.length === 0
      ? []
      : [`${carried.merged.length} on ${started.base} already, closed`]),
  ]
  yield* record(log, {
    kind: 'info',
    text: `start: the carry-over: ${carriedWords.length === 0 ? 'nothing to resume' : carriedWords.join(', ')}${carried.cutShort ? '; cut short by a stop, the rest kept for the next start' : ''}`,
  })

  // The project's setup, in a dispatch's worktree and in a merge's (§13.8), a step of the view's.
  const projectSetup = makeProjectSetup(yield* Checks, log, {
    command: project.setup,
    checkout: config.checkout,
    timeLimit: project.check_timeout,
    cores: config.cores,
  })
  const setup: MergeSetupShape = {
    run: input =>
      view.steps.during('setup', input.ticket)(projectSetup.run(input)),
  }
  // The tickets whose merge's setup failed: a merge puts them back in line, not in the queue.
  const failedAtMerge = yield* Ref.make<ReadonlySet<TicketId>>(new Set())

  const state = yield* makeRunState(log)
  // The holds, one state (§14, H58): the merge queue's hand-backs and the workers' quiet are counted
  // on its clock, stopped while they hold.
  const holds = yield* makeHolds({
    log,
    running: Effect.map(state.current, slotsTaken),
  })
  const clock = heldClock(holds, (yield* HandBackClock).sleep)

  // The merge queue lives in a scope of its own, so the end stops it before writing its records.
  const mergeScope = yield* Scope.make()
  const merges = yield* makeMergeQueue({
    home: config.home,
    base: started.base,
    checkFast: project.check_fast,
    checkTimeout: project.check_timeout,
    setupFiles: project.setup_files,
    handBacks: {
      resolve: project.hand_backs.resolve,
      fix: project.hand_backs.fix,
      timeout: project.resolve_timeout,
    },
    train: project.merge.train,
    cores: config.cores,
    actor,
  }).pipe(
    Effect.provideService(MergeSetup, MergeSetup.of(setup)),
    Effect.provideService(HandBackClock, clock),
    Scope.provide(mergeScope),
  )
  const mergeUpdates = yield* merges.updates.pipe(Scope.provide(mergeScope))
  const graphChanges = yield* graph.changes

  yield* record(log, {
    kind: 'start',
    version: config.version,
    engine: config.engine,
    repo: config.checkout,
    branch: started.base,
    commit: started.baseCommit,
    ...RunMode.$match(config.options.mode, {
      Tickets: () => ({}),
      Ticket: ({ ticket }) => ({ scope: ticket }),
    }),
    concurrency: project.concurrent,
    ...Option.match(limit, {
      onNone: () => ({}),
      onSome: most => ({ limit: most }),
    }),
    ...Option.match(project.model, {
      onNone: () => ({}),
      onSome: choice => ({ model: `${choice.provider}/${choice.model}` }),
    }),
    permissions: project.permissions,
  })
  // While the run goes, its host is kept from idle sleep and its battery watched, both ending with
  // the run's scope (§7.7, §15.6).
  const kept = yield* keepAwake({
    keepAwake: started.settings.engine.keep_awake,
    overnight: overnightMode(config.options.mode),
    host: config.keepAwakeHost,
  })
  if (KeptAwake.$is('Failed')(kept))
    yield* record(log, {
      kind: 'warn',
      detail: 'KEEP_AWAKE_FAILED',
      text: warningLine({
        tag: 'KEEP_AWAKE_FAILED',
        about: 'run',
        text: `${kept.command} didn't start (${kept.reason}); the host may idle-sleep`,
      }),
    })
  yield* recordBattery

  // Why the ticket merging waits (`MERGES_WAIT`, H72), on the console until its turn's outcome comes.
  const mergesWait = yield* Ref.make(
    Option.none<{ readonly ticket: TicketId; readonly detail: string }>(),
  )
  yield* view.attach({
    state,
    line: merges.line,
    mergesWait: Effect.map(
      Ref.get(mergesWait),
      Option.map(({ detail }) => detail),
    ),
    slots: project.concurrent,
  })
  // The carried tickets that had finished go back in line to merge, taking no slot (§13.7).
  yield* Effect.forEach(
    carried.toMerge,
    worktree =>
      Effect.gen(function* () {
        const title = yield* graph.show(worktree.ticket).pipe(
          Effect.map(({ ticket }) => ticket.title),
          Effect.orElseSucceed(() => worktree.ticket),
        )
        yield* state.enter({ ticket: worktree.ticket, title })
        const line = yield* merges.line
        yield* state.move({
          ticket: worktree.ticket,
          to: Phase.cases.waiting_to_merge.make({
            place: line.waiting.length + 1,
          }),
          cause: 'carried over: finished, back in line to merge',
        })
        yield* merges.enqueue({
          ticket: worktree.ticket,
          path: worktree.path,
          branch: worktree.branch,
        })
      }),
    { discard: true },
  )
  const footprints = yield* makeFootprintsGate({
    checkout: config.checkout,
    home: config.home,
    base: started.base,
    concurrent: project.concurrent,
    checks: [project.check_own, project.check_fast, project.check_full],
    sharedFiles: project.shared_files,
  })
  const wakes = control.wakes
  const runScope = yield* Effect.scope
  const agents = yield* PiAgent
  const proxy = yield* ModelProxy
  // The tickets an environment hold put back while their worker still ran: put back as it ends.
  const toReopen = yield* Ref.make<ReadonlySet<TicketId>>(new Set())
  /** When each ticket was last dispatched, in epoch ms: a quick settle is counted for the environment hold. */
  const dispatchedAt = new Map<TicketId, number>()
  const environment = yield* makeEnvironmentHold({
    holds,
    log,
    sleep: clock.sleep,
    agent: minimalAgent({
      config,
      run,
      model: Option.map(project.model, choice => ({
        provider: choice.provider,
        modelId: choice.model,
      })),
    }).pipe(
      Effect.provideService(PiAgent, agents),
      Effect.provideService(ModelProxy, proxy),
    ),
    reopen: tickets => Effect.forEach(tickets, reopened, { discard: true }),
    probed: Effect.suspend(() => probeFreed),
  })
  const supervision = yield* makeSupervision({
    proxy: yield* proxy.events,
    holds: supervisorHolds({
      holds,
      environment,
      retry: project.usage_limit_retry,
      sleep: clock.sleep,
      fork: effect => Effect.asVoid(Effect.forkIn(effect, runScope)),
    }),
    clock,
    ticketLimit: project.ticket_limit,
    fallbacks: project.model_fallbacks.map(choice => ({
      provider: choice.provider,
      modelId: choice.model,
    })),
  })
  const workers = yield* FiberSet.make<void>()
  const context: WorkerContext = {
    config,
    run,
    started,
    log,
    merges,
    setup,
    sessions,
    actor,
    desk: view.workers,
  }

  const stop = (
    kind: StopKind,
    detail: string,
    ticket = Option.none<TicketId>(),
  ) => wakes.wake(WakeReason.Stopped({ kind, ticket, detail }))

  /** A change of the work graph the run made failed: the run stops, `TRACKER_FAILED`. */
  const tracked = <A, E extends { readonly message: string }>(
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<void> =>
    effect.pipe(
      Effect.asVoid,
      Effect.catch(error => stop('TRACKER_FAILED', error.message)),
    )

  const titleOf = (snapshot: RunSnapshot, ticket: TicketId) =>
    snapshot.tickets.get(ticket)?.title ?? ticket

  /** Sets the ticket aside in the work graph with `note`, then in the run, as `reason`. */
  const setAside = (ticket: TicketId, reason: SetAsideReason, note: string) =>
    Effect.gen(function* () {
      yield* tracked(
        Effect.andThen(
          graph.note({ id: ticket, body: note, actor }),
          graph.defer({ id: ticket, until: Option.none(), actor }),
        ),
      )
      yield* sessions.left({
        ticket,
        left: SessionLeft.cases.set_aside.make({}),
      })
      const before = yield* state.move({
        ticket,
        to: Phase.cases.set_aside.make({ reason }),
        cause: note,
      })
      yield* record(log, {
        kind: 'deferred',
        ticket,
        title: Option.match(before, {
          onNone: () => ticket,
          onSome: ({ title }) => title,
        }),
        reason,
        detail: note,
        text: warningLine({
          tag: reason,
          about: 'ticket',
          text: `${ticket} set aside: ${note}`,
        }),
      })
    })

  const settled = (
    ticket: TicketId,
    outcome: 'finish' | 'defer' | 'wait_for' | 'ask_question' | 'none',
    how: string,
  ) =>
    record(log, {
      kind: 'settled',
      ticket,
      outcome,
      text: settledLine({ ticket, how }),
    })

  /** The ticket's setup failed: back until a merge or a probe (`SETUP_FAILED`, §13.8). */
  const setupFailed = (ticket: TicketId, detail: string) =>
    Effect.andThen(
      state.move({
        ticket,
        to: Phase.cases.waiting.make({ for: WaitFor.cases.setup.make({}) }),
        cause: detail,
      }),
      record(log, {
        kind: 'warn',
        ticket,
        text: warningLine({
          tag: 'SETUP_FAILED',
          about: 'ticket',
          text: `${ticket} waits for a merge or a probe: ${detail}`,
        }),
      }),
    )

  /**
   * A merge or a probe frees the tickets whose setup failed (§13.8), for `cause`: one its worker's setup
   * failed goes back in the queue, and one its merge's setup failed back in line to merge, each set up
   * again as it comes round.
   */
  const setupsRetried = (cause: string) =>
    Effect.gen(function* () {
      const waiting = setupWaiting(yield* state.current)
      if (waiting.length === 0) return
      const atMerge = yield* Ref.get(failedAtMerge)
      const listed = waiting.some(ticket => atMerge.has(ticket))
        ? yield* worktrees
            .list({ home: config.home })
            .pipe(
              Effect.catch(error =>
                Effect.as(
                  Effect.logWarning(
                    `the worktrees of the tickets whose merge's setup failed can't be listed: ${error.message}`,
                  ),
                  [],
                ),
              ),
            )
        : []
      yield* Effect.forEach(
        setupRetries({ waiting, failedAtMerge: atMerge, worktrees: listed }),
        SetupRetry.$match({
          Requeue: ({ ticket }) =>
            Effect.asVoid(
              state.move({ ticket, to: Phase.cases.queued.make({}), cause }),
            ),
          Remerge: ({ worktree }) =>
            Effect.gen(function* () {
              const { ticket } = worktree
              yield* Ref.update(
                failedAtMerge,
                failed => new Set([...failed].filter(id => id !== ticket)),
              )
              const line = yield* merges.line
              yield* state.move({
                ticket,
                to: Phase.cases.waiting_to_merge.make({
                  place: line.waiting.length + 1,
                }),
                cause,
              })
              yield* merges.enqueue(worktree)
              yield* record(log, {
                kind: 'info',
                ticket,
                text: `  ${ticket} back in line to merge: ${cause}`,
              })
            }),
          Stays: ({ ticket }) =>
            Effect.logWarning(
              `${ticket} stays waiting for its setup: its worktree isn't there`,
            ),
        }),
        { discard: true },
      )
    })

  /**
   * An environment hold puts the ticket back to wait for its probe (§14.1): one set aside for failing at
   * once is undeferred, its worktree and session kept; one whose worker still runs is put back as it ends.
   */
  const reopened = (ticket: TicketId): Effect.Effect<void> =>
    Effect.gen(function* () {
      const taken = (yield* state.current).tickets.get(ticket)
      if (taken === undefined) return
      if (factsOf(taken.phase).takesSlot) {
        yield* Ref.update(toReopen, kept => new Set([...kept, ticket]))
        return
      }
      if (taken.phase._tag !== 'set_aside') return
      yield* tracked(graph.undefer({ id: ticket, actor }))
      const detail = `the environment hold put it back: it waits for the probe (it was set aside ${taken.phase.reason})`
      yield* state.move({
        ticket,
        to: Phase.cases.waiting.make({ for: WaitFor.cases.probe.make({}) }),
        cause: detail,
      })
      yield* record(log, {
        kind: 'reopened',
        ticket,
        detail,
        text: `  ${ticket} back in the queue for the probe: ${detail}`,
      })
    })

  /**
   * `PROBE_OK` frees the tickets waiting for the probe and those whose setup failed (§14.1, §13.8),
   * before the environment hold lifts: its lift wakes the run to take them.
   */
  const probeFreed = Effect.gen(function* () {
    const cause = 'PROBE_OK: the environment probe passed'
    yield* Effect.forEach(
      inPhase(yield* state.current, 'waiting').filter(
        taken =>
          taken.phase._tag === 'waiting' && taken.phase.for._tag === 'probe',
      ),
      taken =>
        state.move({
          ticket: taken.ticket,
          to: Phase.cases.queued.make({}),
          cause,
        }),
      { discard: true },
    )
    yield* setupsRetried(`${cause}: its setup runs again`)
  })

  /** Whether the ticket's branch or worktree has changes; one that can't tell is taken as changed. */
  const hasChanges = (ticket: TicketId) =>
    Effect.gen(function* () {
      const listed = yield* worktrees.list({ home: config.home })
      const kept = listed.find(entry => entry.ticket === ticket)
      const [branch, status] = yield* Effect.all(
        [
          git.changedFiles({
            repo: config.checkout,
            branch: ticketBranch(ticket),
            base: started.base,
          }),
          kept === undefined
            ? Effect.succeed(Option.none())
            : Effect.map(git.status({ worktree: kept.path }), Option.some),
        ],
        { concurrency: 2 },
      )
      return (
        branch.length > 0 || Option.exists(status, found => !isClean(found))
      )
    }).pipe(Effect.orElseSucceed(() => true))

  /** Counts the ticket's turn, ended as `end`, for the environment hold (§14.1). */
  const countedFor = (ticket: TicketId, end: WorkerEnd) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const at = dispatchedAt.get(ticket)
      const quick =
        at !== undefined && now - at < Duration.toMillis(QUICK_SETTLE)
      const held = providerHeld(yield* holds.current)
      const changed =
        WorkerEnd.$is('Unfinished')(end) && quick && !held
          ? yield* hasChanges(ticket)
          : false
      yield* environment.settled(
        settleOf({ ticket, end, quick, changed, providerHeld: held }),
      )
    })

  /** Puts the ticket back for the probe where an environment hold asked for it while its worker ran. */
  const reopenedOnceEnded = (ticket: TicketId) =>
    Effect.gen(function* () {
      const reopen = yield* Ref.modify(toReopen, kept => [
        kept.has(ticket),
        new Set([...kept].filter(id => id !== ticket)),
      ])
      if (reopen) yield* reopened(ticket)
    })

  /**
   * Moves the ticket as its worker's end asks (§13.5), then frees its slot; a finish, verified or
   * past the verifier, goes to the merge queue for `finished`.
   */
  const workerEnded = (
    ticket: TicketId,
    end: WorkerEnd,
    finished = 'finished',
  ) =>
    Effect.gen(function* () {
      const title = titleOf(yield* state.current, ticket)
      // Counted while it still holds its slot, so a hold it trips is on before the run can see it ended.
      yield* countedFor(ticket, end)
      yield* WorkerEnd.$match(end, {
        Finished: ({ worktree }) =>
          Effect.gen(function* () {
            // Its phase moves before it is in line, so the queue's first step comes after it.
            yield* sessions.left({
              ticket,
              left: SessionLeft.cases.finished.make({}),
            })
            const line = yield* merges.line
            const place = line.waiting.length + 1
            yield* state.move({
              ticket,
              to: Phase.cases.waiting_to_merge.make({ place }),
              cause: finished,
            })
            yield* merges.enqueue(worktree)
          }),
        Deferred: ({ reason }) =>
          Effect.gen(function* () {
            yield* settled(ticket, 'defer', `deferred: ${reason}`)
            yield* sessions.left({
              ticket,
              left: SessionLeft.cases.set_aside.make({}),
            })
            yield* state.move({
              ticket,
              to: Phase.cases.set_aside.make({ reason: 'DEFERRED' }),
              cause: reason,
            })
            yield* record(log, {
              kind: 'deferred',
              ticket,
              title,
              reason: 'DEFERRED',
              detail: reason,
              text: warningLine({
                tag: 'DEFERRED',
                about: 'ticket',
                text: `${ticket} set aside: ${reason}`,
              }),
            })
          }),
        WaitsFor: ({ ticket: other, needs }) =>
          Effect.gen(function* () {
            yield* settled(ticket, 'wait_for', `waits for ${other} to merge`)
            // It starts afresh once the other merges, in its worktree rebased onto Base; kept till
            // then, so a hand merge of its branch is noticed.
            yield* sessions.left({
              ticket,
              left: SessionLeft.cases.waits.make({}),
            })
            yield* tracked(graph.release({ id: ticket, actor }))
            yield* state.move({
              ticket,
              to: Phase.cases.waiting.make({
                for: WaitFor.cases.merge.make({ tickets: [other] }),
              }),
              cause: `waits for ${other} to merge`,
            })
            yield* record(log, {
              kind: 'waits',
              ticket,
              title,
              waits_for: [other],
              detail: needs,
              text: warningLine({
                tag: 'WAITS_FOR_MERGE',
                about: 'ticket',
                text: `${ticket} waits for ${other} to merge: ${needs}`,
              }),
            })
          }),
        Asked: ({ question }) =>
          Effect.gen(function* () {
            yield* settled(ticket, 'ask_question', `asked ${question}`)
            const asked = yield* graph.show(question).pipe(
              Effect.map(({ ticket: shown }) => shown.title),
              Effect.orElseSucceed(() => question),
            )
            // Back in the queue, its session kept: the answer readies it, and it resumes (H76).
            yield* sessions.left({
              ticket,
              left: SessionLeft.cases.asked.make({ question }),
            })
            yield* tracked(graph.release({ id: ticket, actor }))
            yield* state.move({
              ticket,
              to: Phase.cases.asked.make({ question }),
              cause: `asked ${question}`,
            })
            yield* record(log, {
              kind: 'asked',
              ticket,
              title,
              question,
              detail: `${question}: ${asked}`,
              text: `  ${ticket} asked ${question}: ${asked}`,
            })
          }),
        Unfinished: () =>
          Effect.andThen(
            settled(ticket, 'none', 'no outcome'),
            setAside(
              ticket,
              'UNFINISHED',
              'its worker settled with no outcome: no finish, defer, wait_for or ask_question',
            ),
          ),
        // Set aside, with a follow-up filed about the tool (§12.8).
        ToolFailed: ({ tool, reason }) =>
          Effect.gen(function* () {
            yield* settled(ticket, 'none', `${tool} failed`)
            yield* tracked(
              graph.fileDiscovered({
                from: ticket,
                link: 'discovered_from',
                ticket: {
                  type: 'bug',
                  ...toolFollowUp({ ticket, tool, reason }),
                },
                actor,
              }),
            )
            yield* setAside(
              ticket,
              'TOOL_DEFECT',
              `${tool} failed in the engine: ${reason}`,
            )
          }),
        SetAside: ({ reason, note }) =>
          Effect.andThen(
            settled(ticket, 'none', `set aside: ${reason}`),
            setAside(ticket, reason, note),
          ),
        SetupFailed: ({ detail }) =>
          Effect.andThen(
            tracked(graph.release({ id: ticket, actor })),
            setupFailed(ticket, detail),
          ),
        NotStarted: ({ reason }) =>
          Effect.andThen(
            Effect.ignore(graph.release({ id: ticket, actor })),
            setAside(
              ticket,
              'TOOL_DEFECT',
              `its worker couldn't start: ${reason}`,
            ),
          ),
        Failed: ({ reason }) =>
          Effect.andThen(
            Effect.ignore(graph.release({ id: ticket, actor })),
            setAside(
              ticket,
              'TOOL_DEFECT',
              `its worker couldn't start: ${reason}`,
            ),
          ),
      })
      yield* reopenedOnceEnded(ticket)
      // A ticket released back to the queue moves the ready set: it may be ready already (§13.5).
      yield* wakes.wake(
        WorkerEnd.$is('WaitsFor')(end) || WorkerEnd.$is('SetupFailed')(end)
          ? WakeReason.Requeued({ ticket })
          : WakeReason.Settled({ ticket }),
      )
    })

  /** A verifier round's verdict, noted on the ticket so it outlasts the session (§13.6), and in the log. */
  const verdictNoted = (ticket: TicketId, round: VerifierRound) =>
    Effect.gen(function* () {
      const text = `Verifier ${roundText(round)}`
      yield* tracked(graph.note({ id: ticket, body: text, actor }))
      yield* record(log, {
        kind: 'warn',
        ticket,
        text: warningLine({
          tag: `VERIFIER_${round.verdict._tag}`,
          about: 'ticket',
          text: `${ticket} verifier round ${round.round}: ${round.verdict._tag}: ${round.verdict.summary}`,
        }),
      })
    })

  /**
   * The ticket's worker, each finish verified (§13.6): a PASS to the merge queue; a FAIL handed back
   * to the worker with the rounds' findings, at most `verifier.rounds` times, and a finish after the
   * last to the merge queue unverified; a disagreement handed back for the worker to ask the
   * maintainer. The verifier off, a finish goes to the merge queue as it is.
   */
  const workOn = (taken: Ticket, session: SessionId, first: WorkerTurn) =>
    Effect.gen(function* () {
      const ticket = taken.id
      const rounds: Array<VerifierRound> = []
      let turn: WorkerTurn = first
      while (true) {
        const end = yield* supervision.watch({
          ticket,
          session,
          turn,
          model: modelOf(taken, started),
          run: attempt => dispatchWorker(context, ticket, session, attempt),
        })
        if (!WorkerEnd.$is('Finished')(end))
          return yield* Effect.uninterruptible(workerEnded(ticket, end))
        yield* settled(ticket, 'finish', 'finished')
        const verifier = project.verifier
        if (!verifier.enabled)
          return yield* Effect.uninterruptible(workerEnded(ticket, end))
        if (rounds.length >= verifier.rounds)
          return yield* Effect.uninterruptible(
            workerEnded(
              ticket,
              end,
              `finished past the verifier's last round, ${verifier.rounds}`,
            ),
          )
        const round = rounds.length + 1
        yield* state.move({
          ticket,
          to: Phase.cases.verifying.make({ round }),
          cause: round === 1 ? 'finished' : 'finished again',
        })
        const verified = yield* verifyFinished({
          context,
          ticket,
          worktree: end.worktree,
          checkOwn: end.checkOwn,
          round,
          earlier: rounds,
        })
        if (Verified.$is('Passed')(verified)) {
          yield* record(log, {
            kind: 'info',
            ticket,
            text: `  ${ticket} verified in round ${round} on ${verified.tree}: ${verified.verdict.summary}`,
          })
          return yield* Effect.uninterruptible(
            workerEnded(ticket, end, 'verified'),
          )
        }
        if (Verified.$is('Unanswered')(verified))
          return yield* Effect.uninterruptible(
            Effect.andThen(
              setAside(
                ticket,
                'UNFINISHED',
                `its verifier settled with no verdict in round ${round}`,
              ),
              wakes.wake(WakeReason.Settled({ ticket })),
            ),
          )
        if (Verified.$is('NotRun')(verified))
          return yield* Effect.uninterruptible(
            Effect.andThen(
              setAside(
                ticket,
                'TOOL_DEFECT',
                `its verifier couldn't run in round ${round}: ${verified.reason}`,
              ),
              wakes.wake(WakeReason.Settled({ ticket })),
            ),
          )
        const given: VerifierRound = { round, verdict: verified.verdict }
        yield* verdictNoted(ticket, given)
        const prompt = handBackPrompt({
          ticket,
          round: given,
          rounds: verifier.rounds,
          earlier: rounds,
        })
        rounds.push(given)
        yield* state.move({
          ticket,
          to: Phase.cases.working.make({}),
          cause: Verified.$is('Disagrees')(verified)
            ? `verifier round ${round} disagrees with round ${verified.rounds.join(', ')}`
            : `verifier round ${round}: FAIL`,
        })
        turn = WorkerTurn.HandBack({
          worktree: end.worktree,
          session: end.session,
          prompt,
        })
      }
    })

  /** Closes each epic whose children are all closed and merged, as a ticket merges (§13.3). */
  const closeEpics = tracked(
    graph.closeEpics({
      onBase: id =>
        git
          .isOnBase({
            repo: config.checkout,
            branch: ticketBranch(id),
            base: started.base,
          })
          .pipe(Effect.orElseSucceed(() => false)),
      actor,
    }),
  )

  /** A merge's update: its ticket's phase, its records, and a wake where its turn ended (§13.7). */
  const mergeUpdated = (update: MergeUpdate) =>
    Effect.gen(function* () {
      const ticket = update.ticket
      const title = titleOf(yield* state.current, ticket)
      const ended = (effect: Effect.Effect<void>) =>
        Effect.andThen(effect, wakes.wake(WakeReason.MergeEnded({ ticket })))
      if (isOutcome(update))
        yield* Ref.update(
          mergesWait,
          Option.filter(wait => wait.ticket !== ticket),
        )
      yield* MergeUpdate.$match(update, {
        Step: ({ step }) =>
          Effect.asVoid(
            state.move({
              ticket,
              to: Phase.cases.merging.make({ step }),
              cause: stepCause(step),
            }),
          ),
        Check: ({ record: check }) => record(log, check),
        Wrote: ({ by, files }) =>
          record(log, {
            kind: 'info',
            ticket,
            text: wroteLine({ ticket, by, files }),
          }),
        MergesWait: ({ checkout, files, detail }) =>
          Effect.andThen(
            Ref.set(mergesWait, Option.some({ ticket, detail })),
            record(log, {
              kind: 'warn',
              ticket,
              detail,
              text: mergesWaitLine({ ticket, checkout, files }),
            }),
          ),
        // Its worker has it, in a slot of the run's (§13.7): the queue goes on meanwhile.
        HandedBack: ({ kind, attempt, detail }) =>
          ended(
            Effect.gen(function* () {
              yield* state.move({
                ticket,
                to:
                  kind === 'resolve'
                    ? Phase.cases.resolving.make({ attempt })
                    : Phase.cases.fixing.make({ attempt }),
                cause: detail,
              })
              yield* record(log, {
                kind: 'warn',
                ticket,
                text: warningLine({
                  tag: kind === 'resolve' ? 'RESOLVING' : 'FIXING',
                  about: 'ticket',
                  text: `${ticket} handed back to its worker (${attempt === 1 ? 'first' : `attempt ${attempt}`}): ${detail}`,
                }),
              })
            }),
          ),
        Requeued: ({ for: why, detail }) =>
          Effect.gen(function* () {
            const line = yield* merges.line
            yield* state.move({
              ticket,
              to: Phase.cases.waiting_to_merge.make({
                place: line.waiting.length + 1,
              }),
              cause: detail,
            })
            yield* record(log, {
              kind: 'info',
              ticket,
              text:
                why === 'recheck'
                  ? `  ${detail}`
                  : `  ${ticket} back in line to merge: ${detail}`,
            })
          }),
        Merged: ({ commit, unchecked }) =>
          ended(
            Effect.gen(function* () {
              yield* sessions.drop(ticket)
              yield* state.move({
                ticket,
                to: Phase.cases.merged.make({ commit }),
                cause: `merged into ${started.base}`,
              })
              yield* record(log, {
                kind: 'closed',
                ticket,
                title,
                commit,
                detail: `${shortCommit(commit)} merged into ${started.base}${unchecked ? ', unchecked' : ''}`,
                text: mergedLine({
                  ticket,
                  commit,
                  subject: title,
                  base: started.base,
                }),
              })
              yield* closeEpics
              yield* setupsRetried(`${ticket} merged: its setup runs again`)
            }),
          ),
        NoChange: () =>
          ended(
            Effect.gen(function* () {
              yield* sessions.drop(ticket)
              yield* state.move({
                ticket,
                to: Phase.cases.no_change.make({}),
                cause: 'no change to merge',
              })
              yield* record(log, {
                kind: 'closed',
                ticket,
                title,
                detail: 'no change to merge',
                text: `  ${ticket} closed: no change to merge; worktree and branch removed`,
              })
              yield* closeEpics
            }),
          ),
        SetAside: ({ reason, detail }) =>
          ended(
            Effect.gen(function* () {
              yield* sessions.left({
                ticket,
                left: SessionLeft.cases.set_aside.make({}),
              })
              yield* state.move({
                ticket,
                to: Phase.cases.set_aside.make({ reason }),
                cause: detail,
              })
              yield* record(log, {
                kind: 'deferred',
                ticket,
                title,
                reason,
                detail,
                text: warningLine({
                  tag: reason,
                  about: 'ticket',
                  text: `${ticket} set aside: ${detail}`,
                }),
              })
            }),
          ),
        // Nothing merges without a merge check (H62): the ticket is left for a run that has one.
        NoMergeCheck: () =>
          ended(
            Effect.gen(function* () {
              yield* state.move({
                ticket,
                to: Phase.cases.stopped.make({}),
                cause: "the project's check_fast isn't set",
              })
              yield* record(log, {
                kind: 'warn',
                ticket,
                text: warningLine({
                  tag: 'NO_MERGE_CHECK',
                  about: 'ticket',
                  text: `${ticket} isn't merged: the project's check_fast isn't set (set it, or "none" to merge unchecked)`,
                }),
              })
            }),
          ),
        SetupFailed: ({ detail }) =>
          ended(
            Effect.andThen(
              Ref.update(failedAtMerge, failed => new Set([...failed, ticket])),
              setupFailed(ticket, detail),
            ),
          ),
        // Only the end stops the queue; it moves the tickets left to stopped itself.
        Interrupted: () => Effect.void,
        Stopped: ({ kind, detail }) => stop(kind, detail, Option.some(ticket)),
      })
    })

  /** The ready tickets the run's mode takes, read through the ready rule (§13.3). */
  const readReady = (snapshot: RunSnapshot) =>
    Effect.gen(function* () {
      const ready = yield* graph.ready({
        onBase: id =>
          git
            .isOnBase({
              repo: config.checkout,
              branch: ticketBranch(id),
              base: started.base,
            })
            .pipe(Effect.orElseSucceed(() => false)),
        setAside: inPhase(snapshot, 'set_aside').map(({ ticket }) => ticket),
      })
      return yield* RunMode.$match(config.options.mode, {
        Tickets: () => Effect.succeed(ready),
        Ticket: ({ ticket }) =>
          Effect.map(graph.edges(), edges => {
            const scope = descendants(ticket, edges)
            return ready.filter(candidate => scope.has(candidate.id))
          }),
      })
    })

  /**
   * How a dispatched ticket's worker starts: its saved session resumed (§13.2, H76), told why from
   * where it was left, or a first turn where it has none.
   */
  const turnOf = (ticket: TicketId) =>
    Effect.gen(function* () {
      const saved = yield* sessions.saved(ticket)
      if (Option.isNone(saved)) return WorkerTurn.First()
      if (saved.value.left._tag === 'waits') {
        yield* sessions.drop(ticket)
        return WorkerTurn.First()
      }
      const why = yield* whyResumed(saved.value)
      return WorkerTurn.Resume({ saved: saved.value, why })
    })

  const whyResumed = (saved: SavedSession) =>
    SessionLeft.match(saved.left, {
      working: () => Effect.succeed<ResumeWhy>(ResumeWhy.Carried()),
      finished: () => Effect.succeed<ResumeWhy>(ResumeWhy.Carried()),
      waits: () => Effect.succeed<ResumeWhy>(ResumeWhy.Carried()),
      set_aside: () => Effect.succeed<ResumeWhy>(ResumeWhy.Undeferred()),
      asked: ({ question }) =>
        graph.show(question).pipe(
          Effect.map(({ ticket: asked }) =>
            Option.getOrElse(
              Option.flatMap(asked.question, ({ answer }) => answer),
              () => 'it was closed with no answer given',
            ),
          ),
          Effect.orElseSucceed(() => 'it is gone, with no answer given'),
          Effect.map((answer): ResumeWhy =>
            ResumeWhy.Answered({ question, answer }),
          ),
        ),
    })

  /** The tickets the run set aside that the work graph has open again: back in the queue, to resume (H76). */
  const undeferred = Effect.gen(function* () {
    const aside = inPhase(yield* state.current, 'set_aside')
    yield* Effect.forEach(
      aside,
      taken =>
        graph.show(taken.ticket).pipe(
          Effect.flatMap(({ ticket }) =>
            ticket.status === 'open'
              ? Effect.asVoid(
                  state.move({
                    ticket: taken.ticket,
                    to: Phase.cases.queued.make({}),
                    cause: 'undeferred',
                  }),
                )
              : Effect.void,
          ),
          Effect.catchTag('TicketNotFound', () => Effect.void),
        ),
      { discard: true },
    )
  })

  /**
   * Notices tickets merged by hand as Base moves (§13.10, orchestra-nr1v.9): each saved session's
   * ticket out of every worker's and merge's hands whose branch moved past its Base commit and is on
   * Base is counted closed, merged, its claim dropped (what it blocks freed), its worktree removed.
   */
  let baseSeen: CommitHash = started.baseCommit
  const handMerged = Effect.gen(function* () {
    const now = yield* git
      .commitHash({
        repo: config.checkout,
        revision: `refs/heads/${started.base}`,
      })
      .pipe(Effect.orElseSucceed(() => Option.none<CommitHash>()))
    if (Option.isNone(now) || now.value === baseSeen) return
    baseSeen = now.value
    const snapshot = yield* state.current
    const saved = (yield* sessions.all).filter(entry =>
      outOfHand(snapshot, entry.ticket),
    )
    yield* Effect.forEach(
      saved,
      entry =>
        Effect.gen(function* () {
          const commit = yield* mergedOnBase({
            checkout: config.checkout,
            base: started.base,
            ticket: entry.ticket,
            from: entry.base,
          })
          if (Option.isNone(commit)) return
          yield* closeMerged({
            home: config.home,
            ticket: entry.ticket,
            commit: commit.value,
            sessions,
            actor,
            why: `Merged by hand into ${started.base}.`,
          }).pipe(Effect.catch(error => stop('TRACKER_FAILED', error.message)))
          const title = titleOf(snapshot, entry.ticket)
          yield* state.move({
            ticket: entry.ticket,
            to: Phase.cases.merged.make({ commit: commit.value }),
            cause: `merged by hand into ${started.base}`,
          })
          yield* record(log, {
            kind: 'closed',
            ticket: entry.ticket,
            title,
            commit: commit.value,
            detail: `${shortCommit(commit.value)} merged by hand into ${started.base}`,
            text: `  ${entry.ticket} merged by hand into ${started.base} as ${shortCommit(commit.value)}: closed, its worktree and branch removed`,
          })
        }),
      { discard: true },
    )
    if (saved.length > 0) yield* closeEpics
  })

  /**
   * Dispatches the ticket: its record, with what the queue holds, its footprint line and any files it
   * shares with a ticket in progress that may conflict (§13.4), then its worker, forked under its
   * supervision.
   */
  const dispatchOne = (taken: Taken, n: number, queued: number, gated: Gated) =>
    Effect.gen(function* () {
      const { ticket } = taken
      yield* record(log, {
        kind: 'dispatch',
        ticket: ticket.id,
        title: ticket.title,
        n,
        ...Option.match(limit, {
          onNone: () => ({}),
          onSome: most => ({ limit: most }),
        }),
        ...Option.match(project.model, {
          onNone: () => ({}),
          onSome: choice => ({ model: `${choice.provider}/${choice.model}` }),
        }),
        text: dispatchingLine({
          n,
          limit,
          ticket: ticket.id,
          title: ticket.title,
          solo: taken.solo,
        }),
        queued,
        ...heldIn(gated),
      })
      yield* record(log, {
        kind: 'info',
        ticket: ticket.id,
        text: footprintLine({
          ticket: ticket.id,
          parts: footprintParts(taken.footprint),
        }),
      })
      yield* Effect.forEach(
        taken.likely,
        likely =>
          record(log, {
            kind: 'warn',
            ticket: ticket.id,
            text: warningLine({
              tag: 'LIKELY_CONFLICT',
              about: 'ticket',
              text: `${ticket.id} changes ${likely.files.join(', ')}, as ${likely.with} does: the second to merge may conflict`,
            }),
          }),
        { discard: true },
      )
      const session = yield* drawSession
      dispatchedAt.set(ticket.id, yield* Clock.currentTimeMillis)
      const turn = yield* turnOf(ticket.id)
      if (WorkerTurn.$is('Resume')(turn))
        yield* record(log, {
          kind: 'info',
          ticket: ticket.id,
          text: `  ${ticket.id} resumes its session: ${resumeWords(turn.why)}`,
        })
      yield* FiberSet.run(
        workers,
        workOn(ticket, session, turn).pipe(
          Effect.catchCause(cause =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : stop('PANIC', `${ticket.id}: ${Cause.pretty(cause)}`),
          ),
        ),
      )
    })

  /**
   * Keeps each held ticket's reason on its phase, in words, and says it in the log as it changes
   * (H81); a ticket no longer held, and not taken now, goes back to queued.
   */
  const keepHeld = (candidates: ReadonlyArray<Ticket>, gated: Gated) =>
    Effect.gen(function* () {
      const current = yield* state.current
      const held = new Map(gated.held.map(entry => [entry.ticket, entry]))
      const taken = new Set(gated.take.map(({ ticket }) => ticket.id))
      yield* Effect.forEach(
        candidates.filter(ticket => !taken.has(ticket.id)),
        ticket => {
          const phase = current.tickets.get(ticket.id)?.phase
          const entry = held.get(ticket.id)
          if (entry === undefined)
            return phase?._tag === 'held_back'
              ? Effect.asVoid(
                  state.move({
                    ticket: ticket.id,
                    to: Phase.cases.queued.make({}),
                    cause: 'no longer held back',
                  }),
                )
              : Effect.void
          if (
            phase?._tag === 'held_back' &&
            phase.reason === entry.reason &&
            phase.detail === entry.detail
          )
            return Effect.void
          return Effect.andThen(
            state.move({
              ticket: ticket.id,
              to: Phase.cases.held_back.make({
                reason: entry.reason,
                detail: entry.detail,
              }),
              cause: entry.detail,
            }),
            record(log, {
              kind: 'info',
              ticket: ticket.id,
              text: `  ${ticket.id} held back: ${entry.detail}`,
            }),
          )
        },
        { discard: true },
      )
    })

  /** A drain asked or taken back, as its record says it (§13.10). */
  const drainSaid = (reason: WakeReason) =>
    WakeReason.$is('Drain')(reason)
      ? record(
          log,
          reason.draining
            ? {
                kind: 'drain',
                text: 'DRAIN: no new tickets; the running ones finish and merge',
              }
            : {
                kind: 'resume',
                text: 'the drain was taken back: tickets start again',
              },
        )
      : Effect.void

  /** One look: the ready set where its reasons can have moved it, the free slots filled; whether the run ends. */
  let ready: ReadonlyArray<Ticket> = []
  const look = (reasons: ReadonlyArray<WakeReason>) =>
    Effect.gen(function* () {
      yield* Effect.forEach(reasons, drainSaid, { discard: true })
      const starting = reasons.some(reason => WakeReason.$is('Started')(reason))
      if (readsReady(reasons)) {
        yield* handMerged
        if (reasons.some(reason => WakeReason.$is('TicketsChanged')(reason)))
          yield* undeferred
        const reading = readReady(yield* state.current)
        ready = yield* starting
          ? view.steps.during('backlog')(reading)
          : reading
      }
      if (starting)
        yield* record(log, {
          kind: 'info',
          text: `start: the backlog: ${ready.length === 1 ? '1 ticket' : `${ready.length} tickets`} ready`,
        })
      const before = yield* state.current
      const candidates = ready.filter(ticket => dispatchable(before, ticket.id))
      for (const ticket of candidates) {
        const entered = yield* state.enter({
          ticket: ticket.id,
          title: ticket.title,
        })
        const taken = before.tickets.get(ticket.id)
        if (
          !entered &&
          taken !== undefined &&
          (taken.phase._tag === 'waiting' || taken.phase._tag === 'asked')
        )
          yield* state.move({
            ticket: ticket.id,
            to: Phase.cases.queued.make({}),
            cause:
              taken.phase._tag === 'asked'
                ? `${taken.phase.question} answered`
                : 'ready again',
          })
      }
      // Whether the run may take work: one snapshot of plain values, read once for this look (§14).
      const held = yield* holds.current
      const draining = yield* control.draining
      const may = mayTake({ holds: held, draining })
      const gated = yield* footprints.gate({
        ready: candidates,
        snapshot: before,
        free: MayTake.$is('Yes')(may)
          ? project.concurrent - slotsTaken(before)
          : 0,
      })
      yield* keepHeld(candidates, gated)
      const solo = new Set([
        ...gated.take
          .filter(taken => taken.solo)
          .map(({ ticket }) => ticket.id),
        ...Option.toArray(Option.map(gated.solo, ({ ticket }) => ticket)),
      ])
      yield* view.seen(candidates, ticket => solo.has(ticket.id))
      const dispatched = new Set<TicketId>()
      for (const taken of gated.take) {
        const n = yield* state.dispatch({
          ticket: taken.ticket.id,
          title: taken.ticket.title,
          limit,
        })
        if (Option.isNone(n)) continue
        dispatched.add(taken.ticket.id)
        yield* dispatchOne(
          taken,
          n.value,
          candidates.length - dispatched.size,
          gated,
        )
      }
      // Dispatched tickets leave the ready set the look keeps: they are the run's now.
      ready = ready.filter(ticket => !dispatched.has(ticket.id))
      const after = yield* state.current
      if (inProgress(after).length > 0) return Option.none<Ending>()
      // A hold that can lift keeps the run, unless it drains: the tickets it holds back are to come.
      // Read after the state: a ticket's turn counts toward a hold before it leaves its slot.
      if (waitsOnHold(yield* holds.current) && !draining)
        return Option.none<Ending>()
      const limitReached = Option.exists(
        limit,
        most => after.dispatched >= most,
      )
      return Option.some(
        Ending.Done({
          kind: limitReached
            ? 'LIMIT_REACHED'
            : draining
              ? 'DRAINED'
              : 'READY_EMPTY',
        }),
      )
    })

  yield* mergeUpdates.pipe(Stream.runForEach(mergeUpdated), Effect.forkScoped)
  yield* graphChanges.pipe(
    Stream.runForEach(event =>
      Option.exists(
        event.actor,
        by => by._tag === 'engine' && by.engine === config.engine,
      )
        ? Effect.void
        : wakes.wake(WakeReason.TicketsChanged()),
    ),
    Effect.catch(error => Effect.logWarning(error.message)),
    Effect.forkScoped,
  )
  // Each change of the holds after the first: a lift wakes the run, and one that gave up stops it.
  yield* holds.changes.pipe(
    Stream.drop(1),
    Stream.runForEach(snapshot =>
      Option.match(stopping(snapshot), {
        onNone: () => wakes.wake(WakeReason.HoldsChanged()),
        onSome: gaveUp => stop(gaveUp.kind, gaveUp.detail, gaveUp.ticket),
      }),
    ),
    Effect.forkScoped,
  )
  yield* wakes.wake(WakeReason.Started())

  let ending = Option.none<Ending>()
  while (Option.isNone(ending)) {
    const reasons = yield* wakes.next
    const stopped = reasons.find(reason => WakeReason.$is('Stopped')(reason))
    ending =
      stopped !== undefined && WakeReason.$is('Stopped')(stopped)
        ? Option.some(
            Ending.Stop({
              kind: stopped.kind,
              ticket: stopped.ticket,
              detail: stopped.detail,
            }),
          )
        : yield* look(reasons).pipe(
            // The work graph couldn't be read: the run stops (§13.11).
            Effect.catchTag('StoreFailed', error =>
              Effect.succeed(
                Option.some(
                  Ending.Stop({
                    kind: 'TRACKER_FAILED',
                    ticket: Option.none(),
                    detail: error.message,
                  }),
                ),
              ),
            ),
          )
  }
  return yield* endRun({
    ending: ending.value,
    state,
    supervision,
    workers,
    mergeScope,
    merges,
    log,
  })
})

/**
 * The end, in order (§13.9): no further dispatch, every ticket's supervision stopped first, then
 * every worker interrupted at once (their sessions closing side by side, the end waiting for the
 * slowest), the merge queue stopped, the end's steps, the end line and what is left, each ticket's
 * `ticket_end`, and the `end` record with its exit code.
 */
const endRun = Effect.fn('Run.end')(function* (input: {
  readonly ending: Ending
  readonly state: RunStateShape
  readonly supervision: { readonly stop: Effect.Effect<void> }
  readonly workers: FiberSet.FiberSet<void>
  readonly mergeScope: Scope.Closeable
  readonly merges: MergeQueueShape
  readonly log: RunLog['Service']
}) {
  const { ending, state, log } = input
  yield* state.end
  yield* input.supervision.stop
  yield* FiberSet.clear(input.workers)
  yield* Scope.close(input.mergeScope, Exit.void)
  const left = yield* state.current
  yield* Effect.forEach(
    inProgress(left),
    taken =>
      state.move({
        ticket: taken.ticket,
        to: Phase.cases.stopped.make({}),
        cause: 'the run ended',
      }),
    { discard: true },
  )
  const kind: EndKind = ending.kind
  yield* endSteps({
    kind,
    merged: inPhase(left, 'merged').length,
  })
  const waits = [
    ...setupWaitsLines(left),
    ...inPhase(left, 'asked').flatMap(taken =>
      taken.phase._tag === 'asked'
        ? [
            `QUESTIONS_WAITING: ${taken.ticket} waits on the question ${taken.phase.question}`,
          ]
        : [],
    ),
  ]
  yield* Ending.$match(ending, {
    Done: ({ kind: done }) =>
      record(
        log,
        {
          kind: 'done',
          detail: done,
          text: `${done} after ${left.dispatched} ${left.dispatched === 1 ? 'ticket' : 'tickets'}`,
        },
        waits,
      ),
    Stop: ({ kind: stopped, ticket, detail }) =>
      record(
        log,
        {
          kind: 'stop',
          detail: stopped,
          ...Option.match(ticket, {
            onNone: () => ({}),
            onSome: id => ({ ticket: id }),
          }),
          text: `${stopped}: ${detail}`,
        },
        waits,
      ),
  })
  yield* state.endLeft
  const code = exitCodeOf(kind)
  yield* record(log, { kind: 'end', code })
  return { kind, code } satisfies RunEnd
})
