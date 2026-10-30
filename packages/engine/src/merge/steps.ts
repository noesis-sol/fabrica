import { Data, Effect, Exit, Match, Option } from 'effect'

import {
  CommandSetting,
  type CommitHash,
  type MergeStep,
} from '@fabrica/contracts'

import { CheckOutcome, Leftovers, NotRun } from '../checks'
import {
  CantTell,
  FastForwardOutcome,
  Git,
  type GitFailed,
  RebaseOutcome,
  Worktrees,
} from '../git'
import { StartFailure } from '../process'
import {
  type InvalidTicket,
  type StoreFailed,
  type TicketNotFound,
  WorkGraph,
} from '../workgraph'
import { HandBack, fixCheck, resolveConflict } from './handbacks'
import {
  type Aside,
  Diagnosis,
  afterCheck,
  checkoutReady,
  cleanUp,
  diagnose,
  mayGoRound,
  putBackChanged,
  removeWrote,
  wroteRecorded,
} from './hygiene'
import { MergeOutcome, MergeUpdate } from './outcome'
import {
  MergeSetup,
  SetupOutcome,
  pendingSetup,
  setUpRecorded,
  setupFilesBrought,
} from './setup'
import type { MergeTrain } from './train'
import type { MergeTurn } from './turn'

// A merge as a machine of named steps, one handler each (spec §13.7, H59, H62, H71): enter, locate,
// rebase, check, confirm, fast-forward. Each handler reads what it needs from git and says the next
// step; the turn ends at `Done`. Base is read as a commit, and the branch is rebased onto that commit
// and fast-forwarded to the hash its check passed on, never by a name. A git read that can't tell
// sets the ticket aside as `GIT_FAILED`; an interrupted rebase is aborted; only the fast-forward to
// the end of its notes is uninterruptible.

/** Where a ticket's merge is. `rounds` counts the checks its branch or Base moving sent it back to. */
export type Step = Data.TaggedEnum<{
  /** Its worktree is read: a rebase a killed run left aborted, and uncommitted files refused. */
  Enter: {}
  /** Base and the branch are read: nothing to merge, already on top of Base and set up, or to rebase. */
  Locate: { readonly rounds: number }
  /**
   * The branch is rebased onto `onto`, Base's commit; `since` was their merge base, and `pending` the
   * setup files the worktree waited to be set up for before it.
   */
  Rebase: {
    readonly rounds: number
    readonly onto: CommitHash
    readonly since: Option.Option<CommitHash>
    readonly pending: ReadonlyArray<string>
  }
  /** The merge check runs on `head`, on top of `onto`. */
  Check: {
    readonly rounds: number
    readonly onto: CommitHash
    readonly head: CommitHash
  }
  /** Base and the branch are read again: still `onto` and `checked`, or moved since the check. */
  Confirm: {
    readonly rounds: number
    readonly onto: CommitHash
    readonly checked: CommitHash
    readonly unchecked: boolean
  }
  /** Base is fast-forwarded from `onto` to `checked`, and the ticket recorded merged and closed. */
  FastForward: {
    readonly rounds: number
    readonly onto: CommitHash
    readonly checked: CommitHash
    readonly unchecked: boolean
  }
  /** The turn is over. */
  Done: { readonly outcome: MergeOutcome }
}>
export const Step = Data.taggedEnum<Step>()

/** The steps a merge goes through, by the names the phases give them. */
const STEP_NAMES: { readonly [T in Exclude<Step['_tag'], 'Done'>]: MergeStep } =
  {
    Enter: 'enter',
    Locate: 'locate',
    Rebase: 'rebase',
    Check: 'check',
    Confirm: 'confirm',
    FastForward: 'fast_forward',
  }

/** The name of a step under way. */
export const stepName = (step: Exclude<Step, { readonly _tag: 'Done' }>) =>
  STEP_NAMES[step._tag]

/** What the work graph can refuse or fail with, as the queue records a merge. */
type TrackerError = StoreFailed | TicketNotFound | InvalidTicket

const describeNotRun = NotRun.$match({
  CommandRefused: ({ command }) =>
    `its command ${JSON.stringify(command)} isn't on one line without control characters`,
  DidNotStart: ({ reason }) =>
    StartFailure.$match(reason, {
      NotOnPath: ({ path }) => `its shell isn't on the PATH (${path})`,
      SpawnFailed: ({ message }) => `it didn't start: ${message}`,
    }),
  OutputCut: ({ limit }) => `its output passed ${limit} bytes`,
  LogNotKept: ({ error }) => `its log couldn't be kept: ${error.message}`,
})

/**
 * The machine, on the services the engine runs it with and the queue's `train`: `run` takes a ticket's
 * turn to its end.
 */
export const makeMachine = Effect.fnUntraced(function* (train: MergeTrain) {
  const git = yield* Git
  const graph = yield* WorkGraph
  const setup = yield* MergeSetup
  const worktrees = yield* Worktrees

  const done = (outcome: MergeOutcome): Step => Step.Done({ outcome })
  const aside = (turn: MergeTurn, { reason, detail }: Aside): Step =>
    done(
      MergeOutcome.SetAside({ ticket: turn.worktree.ticket, reason, detail }),
    )

  /** The commit a revision names, read in `repo`: can't tell where it names none. */
  const commitOf = (repo: string, revision: string) =>
    Effect.flatMap(git.commitHash({ repo, revision }), hash =>
      Option.match(hash, {
        onNone: () =>
          Effect.fail(
            new CantTell({
              read: 'commitHash',
              reason: `${revision} names no commit`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    )

  /** Base's commit, read in the checkout. */
  const baseOf = (turn: MergeTurn) =>
    commitOf(turn.config.home.checkout, `refs/heads/${turn.config.base}`)

  /** Base's commit and the branch's head, read side by side. */
  const ends = (turn: MergeTurn) =>
    Effect.all(
      {
        base: baseOf(turn),
        head: commitOf(turn.worktree.path, 'HEAD'),
      },
      { concurrency: 'unbounded' },
    )

  const enter = Effect.fn('MergeQueue.enter')(function* (turn: MergeTurn) {
    const { ticket, path } = turn.worktree
    if (CommandSetting.guards.Unset(turn.config.checkFast))
      return done(MergeOutcome.NoMergeCheck({ ticket }))
    const stranded = yield* train.arrive(turn)
    if (Option.isSome(stranded)) return done(stranded.value)
    yield* git.abortRebase({ worktree: path })
    // What the queue's setups and checks changed, on an earlier turn or a ride, isn't its worker's either.
    yield* putBackChanged(git, { worktree: path })
    const { status, wrote } = yield* Effect.all(
      {
        status: git.status({ worktree: path }),
        wrote: wroteRecorded(git, { worktree: path }),
      },
      { concurrency: 'unbounded' },
    )
    // What the queue's setups and checks wrote, on an earlier turn or a ride, isn't its worker's.
    const queues = new Set(wrote)
    const own = [
      ...status.uncommitted,
      ...status.untracked.filter(file => !queues.has(file)),
    ]
    if (own.length > 0) {
      return aside(turn, {
        reason: 'CLOSED_UNCOMMITTED',
        detail: `CLOSED_UNCOMMITTED: ${own.join(', ')}`,
      })
    }
    return Step.Locate({ rounds: 0 })
  })

  const locate = Effect.fn('MergeQueue.locate')(function* (
    turn: MergeTurn,
    { rounds }: { readonly rounds: number },
  ) {
    const repo = turn.worktree.path
    const { base, head } = yield* ends(turn)
    const { since, changed, pending } = yield* Effect.all(
      {
        since: git.mergeBase({ repo, branch: head, base }),
        changed: git.changedFiles({ repo, branch: head, base }),
        pending: pendingSetup(git, { worktree: repo }),
      },
      { concurrency: 'unbounded' },
    )
    if (changed.length === 0)
      return done(MergeOutcome.NoChange({ ticket: turn.worktree.ticket }))
    // A branch on top of Base whose worktree waits for a setup goes through the rebase step, which sets it up.
    if (Option.contains(since, base) && pending.length === 0)
      return Step.Check({ rounds, onto: base, head })
    return Step.Rebase({ rounds, onto: base, since, pending })
  })

  const rebase = Effect.fn('MergeQueue.rebase')(function* (
    turn: MergeTurn,
    {
      rounds,
      onto,
      since,
      pending,
    }: {
      readonly rounds: number
      readonly onto: CommitHash
      readonly since: Option.Option<CommitHash>
      readonly pending: ReadonlyArray<string>
    },
  ) {
    const { ticket, path } = turn.worktree
    const abort = git.abortRebase({ worktree: path })
    const rebased = yield* git.rebase({ worktree: path, onto })
    return yield* RebaseOutcome.$match(rebased, {
      Rebased: ({ head }) =>
        Effect.gen(function* () {
          // Every commit of the branch was on Base already: nothing is left to merge.
          if (head === onto) return done(MergeOutcome.NoChange({ ticket }))
          const brought = yield* setupFilesBrought(git, {
            worktree: path,
            onto,
            since,
            patterns: turn.config.setupFiles,
          })
          const files = [...new Set([...pending, ...brought])]
          if (files.length > 0) {
            const { ready, left } = yield* setUpRecorded(git, setup, {
              ticket,
              worktree: path,
              files,
            })
            if (SetupOutcome.$is('Failed')(ready))
              return done(
                MergeOutcome.SetupFailed({ ticket, detail: ready.detail }),
              )
            const dirty = yield* Leftovers.$match(left, {
              CantTell: ({ reason }) =>
                Effect.succeedSome<Aside>({
                  reason: 'GIT_FAILED',
                  detail: `GIT_FAILED: what the merge's setup left can't be told: ${reason}`,
                }),
              Seen: ({ changed, wrote }) =>
                afterCheck({ turn, by: 'setup', changed, wrote }),
            })
            if (Option.isSome(dirty)) return aside(turn, dirty.value)
          }
          return Step.Check({ rounds, onto, head })
        }),
      Conflict: ({ files }) =>
        Effect.flatMap(resolveConflict({ turn, files }), handBack =>
          HandBack.$match(handBack, {
            SetAside: given => Effect.as(abort, aside(turn, given)),
          }),
        ),
      AlreadyRebasing: () =>
        Effect.succeed(
          aside(turn, {
            reason: 'GIT_FAILED',
            detail: 'GIT_FAILED: a rebase is still in progress after its abort',
          }),
        ),
      Refused: ({ message }) =>
        Effect.succeed(
          aside(turn, {
            reason: 'GIT_FAILED',
            detail: `GIT_FAILED: git refused to rebase onto ${onto}: ${message}`,
          }),
        ),
    })
  })

  /** A rebase cut short, by an interruption or a failure, is aborted, its branch put back. */
  const abortingRebase = (
    turn: MergeTurn,
    step: Parameters<typeof rebase>[1],
  ) =>
    Effect.onExit(rebase(turn, step), exit =>
      Exit.isSuccess(exit)
        ? Effect.void
        : Effect.ignore(git.abortRebase({ worktree: turn.worktree.path })),
    )

  const check = Effect.fn('MergeQueue.check')(function* (
    turn: MergeTurn,
    {
      rounds,
      onto,
      head,
    }: {
      readonly rounds: number
      readonly onto: CommitHash
      readonly head: CommitHash
    },
  ) {
    const { ticket } = turn.worktree
    const confirm = (checked: CommitHash, unchecked: boolean): Step =>
      Step.Confirm({ rounds, onto, checked, unchecked })
    return yield* CommandSetting.match(turn.config.checkFast, {
      Unset: (): Effect.Effect<Step> =>
        Effect.succeed(done(MergeOutcome.NoMergeCheck({ ticket }))),
      None: (): Effect.Effect<Step> => Effect.succeed(confirm(head, true)),
      Command: ({ command }): Effect.Effect<Step, CantTell | GitFailed> =>
        Effect.gen(function* () {
          const outcome = yield* train.check({ turn, onto, head, command })
          return yield* CheckOutcome.$match(outcome, {
            Passed: ({ left }) =>
              Leftovers.$match(left, {
                CantTell: ({ reason }) =>
                  Effect.succeed(
                    aside(turn, {
                      reason: 'GIT_FAILED',
                      detail: `GIT_FAILED: what the merge check left can't be told: ${reason}`,
                    }),
                  ),
                Seen: ({ changed, wrote }) =>
                  Effect.map(
                    afterCheck({ turn, by: 'check', changed, wrote }),
                    left =>
                      Option.match(left, {
                        onNone: () => confirm(head, false),
                        onSome: given => aside(turn, given),
                      }),
                  ),
              }),
            Failed: failed => handedBack(turn, failed),
            TimedOut: timedOut => handedBack(turn, timedOut),
            CouldNotRun: ({ reason }) =>
              Effect.succeed(
                aside(turn, {
                  reason: 'CHECKS_FAILED',
                  detail: `CHECKS_FAILED: the merge check couldn't run: ${describeNotRun(reason)}`,
                }),
              ),
          })
        }),
    })
  })

  /** A failed merge check, handed back. */
  const handedBack = (
    turn: MergeTurn,
    outcome: Extract<CheckOutcome, { readonly _tag: 'Failed' | 'TimedOut' }>,
  ) =>
    Effect.map(fixCheck({ turn, outcome }), handBack =>
      HandBack.$match(handBack, { SetAside: given => aside(turn, given) }),
    )

  /** The turn goes round again from `locate`, while its budget lets it. */
  const goRound = (turn: MergeTurn, rounds: number, moved: string) =>
    Effect.map(mayGoRound({ turn, rounds: rounds + 1 }), may =>
      may
        ? Step.Locate({ rounds: rounds + 1 })
        : aside(turn, {
            reason: 'BASE_KEPT_MOVING',
            detail: `BASE_KEPT_MOVING: ${moved} during each of ${rounds + 1} checks`,
          }),
    )

  const confirm = Effect.fn('MergeQueue.confirm')(function* (
    turn: MergeTurn,
    {
      rounds,
      onto,
      checked,
      unchecked,
    }: {
      readonly rounds: number
      readonly onto: CommitHash
      readonly checked: CommitHash
      readonly unchecked: boolean
    },
  ) {
    const { base, head } = yield* ends(turn)
    if (head !== checked)
      return yield* goRound(turn, rounds, `${turn.worktree.branch} moved on`)
    if (base !== onto)
      return yield* goRound(turn, rounds, `${turn.config.base} moved on`)
    return Step.FastForward({ rounds, onto, checked, unchecked })
  })

  /**
   * Fast-forwards Base to the checked commit once its checkout is clean, and records it: the one step a
   * stop waits for, but in its waits for the checkout and before a refused fast-forward is tried again.
   */
  const fastForward = Effect.fn('MergeQueue.fastForward')(function* (
    turn: MergeTurn,
    {
      rounds,
      onto,
      checked,
      unchecked,
    }: {
      readonly rounds: number
      readonly onto: CommitHash
      readonly checked: CommitHash
      readonly unchecked: boolean
    },
  ) {
    const { ticket } = turn.worktree
    const { actor } = turn.config
    /** The fast-forward, tried again as its refusals are diagnosed: none once it's done, else the next step. */
    const forward = (
      retries: number,
    ): Effect.Effect<Option.Option<Step>, CantTell | GitFailed> =>
      Effect.gen(function* () {
        yield* Effect.interruptible(
          Effect.provideService(checkoutReady(turn), Git, git),
        )
        const outcome = yield* git.fastForward({
          checkout: turn.config.home.checkout,
          base: turn.config.base,
          to: checked,
        })
        if (FastForwardOutcome.$is('FastForwarded')(outcome))
          return Option.none()
        const diagnosis = yield* Effect.interruptible(
          diagnose({
            turn,
            onto,
            checked,
            outcome,
            retries,
            base: baseOf(turn),
          }),
        )
        return yield* Diagnosis.$match(diagnosis, {
          Again: () =>
            Effect.map(
              goRound(turn, rounds, `${turn.config.base} moved on`),
              Option.some,
            ),
          Retry: () => forward(retries + 1),
          SetAside: given => Effect.succeedSome(aside(turn, given)),
          Stop: ({ kind, detail }) =>
            Effect.succeedSome(
              done(MergeOutcome.Stopped({ ticket, kind, detail })),
            ),
        })
      })
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const notMerged = yield* forward(0)
        if (Option.isSome(notMerged)) return notMerged.value
        yield* graph.update({
          id: ticket,
          changes: { mergedCommit: Option.some(checked) },
          actor,
        })
        yield* graph
          .close({
            id: ticket,
            resolution: 'done',
            reason: unchecked
              ? `Merged unchecked as ${checked}: check_fast is none.`
              : `Merged as ${checked}.`,
            actor,
          })
          .pipe(Effect.catchTag('TransitionRefused', () => Effect.void))
        yield* removed(turn)
        return done(MergeOutcome.Merged({ ticket, commit: checked, unchecked }))
      }),
    )
  })

  /** The ticket's worktree and branch removed; a failure is logged, as the ticket is settled already. */
  const removed = (turn: MergeTurn) =>
    cleanUp(turn).pipe(
      Effect.provideService(Worktrees, worktrees),
      Effect.provideService(Git, git),
      Effect.catch(error =>
        Effect.logWarning(
          `Couldn't remove ${turn.worktree.ticket}'s worktree and branch`,
          error,
        ),
      ),
    )

  /** The files the queue wrote in a set-aside ticket's worktree removed; a failure is logged, and they stay recorded. */
  const dropWrote = (turn: MergeTurn) =>
    removeWrote(git, { worktree: turn.worktree.path }).pipe(
      Effect.catch(error =>
        Effect.logWarning(
          `Couldn't remove the files the merge wrote in ${turn.worktree.ticket}'s worktree`,
          error,
        ),
      ),
    )

  /**
   * The tracked files the queue changed in a set-aside ticket's worktree put back: those it put back; a
   * failure is logged, and they stay recorded.
   */
  const putBack = (turn: MergeTurn) =>
    putBackChanged(git, { worktree: turn.worktree.path }).pipe(
      Effect.catch(error =>
        Effect.as(
          Effect.logWarning(
            `Couldn't put back the files the merge changed in ${turn.worktree.ticket}'s worktree`,
            error,
          ),
          [],
        ),
      ),
    )

  /**
   * What an outcome records in the work graph: a ticket with no change closed, one set aside deferred,
   * the files the queue wrote in its worktree removed and those it changed put back first, its note
   * naming those.
   */
  const settle = (turn: MergeTurn, outcome: MergeOutcome) => {
    const { ticket } = turn.worktree
    const { actor } = turn.config
    return MergeOutcome.$match(outcome, {
      NoChange: () =>
        graph
          .close({
            id: ticket,
            resolution: 'no_change',
            reason: 'Its commits change nothing.',
            actor,
          })
          .pipe(
            Effect.catchTag('TransitionRefused', () => Effect.void),
            Effect.andThen(removed(turn)),
            Effect.uninterruptible,
          ),
      SetAside: ({ detail }) =>
        dropWrote(turn).pipe(
          Effect.andThen(putBack(turn)),
          Effect.flatMap(files =>
            graph.note({
              id: ticket,
              body:
                files.length === 0
                  ? detail
                  : `${detail}; the tracked files it changed were put back: ${files.join(', ')}`,
              actor,
            }),
          ),
          Effect.andThen(
            graph.defer({ id: ticket, until: Option.none(), actor }),
          ),
          Effect.catchTag('TransitionRefused', () => Effect.void),
          Effect.asVoid,
          Effect.uninterruptible,
        ),
      Merged: () => Effect.void,
      NoMergeCheck: () => Effect.void,
      SetupFailed: () => Effect.void,
      Interrupted: () => Effect.void,
      Stopped: () => Effect.void,
    })
  }

  /** Runs the handler of `step`; the end, `Done`, stays as it is. */
  const handle = (
    turn: MergeTurn,
    step: Step,
  ): Effect.Effect<Step, CantTell | GitFailed | TrackerError> =>
    Step.$match(step, {
      Enter: () => enter(turn),
      Locate: given => locate(turn, given),
      Rebase: given => abortingRebase(turn, given),
      Check: given => check(turn, given),
      Confirm: given => confirm(turn, given),
      FastForward: given => fastForward(turn, given),
      Done: () => Effect.succeed(step),
    })

  /** The tracker's failure as the turn's end: merging stops. */
  const trackerFailed = (turn: MergeTurn, error: TrackerError) =>
    MergeOutcome.Stopped({
      ticket: turn.worktree.ticket,
      kind: 'TRACKER_FAILED',
      detail: `TRACKER_FAILED: ${error.message}`,
    })

  /** A failure as the turn's end: git's sets the ticket aside, the work graph's stops merging. */
  const failed = (
    turn: MergeTurn,
    error: CantTell | GitFailed | TrackerError,
  ): Step =>
    Match.valueTags(error, {
      CantTell: ({ read, reason }) =>
        aside(turn, {
          reason: 'GIT_FAILED',
          detail: `GIT_FAILED: can't tell ${read}: ${reason}`,
        }),
      GitFailed: ({ command, reason }) =>
        aside(turn, {
          reason: 'GIT_FAILED',
          detail: `GIT_FAILED: git ${command}: ${reason}`,
        }),
      StoreFailed: tracker => done(trackerFailed(turn, tracker)),
      TicketNotFound: tracker => done(trackerFailed(turn, tracker)),
      InvalidTicket: tracker => done(trackerFailed(turn, tracker)),
    })

  /**
   * Takes a ticket's turn from `enter` to its end, publishing each step as it starts, and records its
   * outcome in the work graph. `onStep` hears of each step first, so an interruption can say where it came.
   */
  const run = Effect.fn('MergeQueue.turn')(function* (
    turn: MergeTurn,
    onStep: (step: MergeStep) => Effect.Effect<void>,
  ) {
    const { ticket } = turn.worktree
    let step: Step = Step.Enter()
    let outcome = Option.none<MergeOutcome>()
    while (Option.isNone(outcome)) {
      if (Step.$is('Done')(step)) {
        outcome = Option.some(step.outcome)
      } else {
        const name = stepName(step)
        yield* onStep(name)
        yield* turn.publish(MergeUpdate.Step({ ticket, step: name }))
        step = yield* Effect.catch(handle(turn, step), error =>
          Effect.succeed(failed(turn, error)),
        )
      }
    }
    const ended = outcome.value
    return yield* settle(turn, ended).pipe(
      Effect.as(ended),
      Effect.catch(error => Effect.succeed(trackerFailed(turn, error))),
    )
  })

  return { run }
})
