import { Data, type Duration, Effect, Option } from 'effect'

import {
  CommandSetting,
  type CommitHash,
  type Phase,
  type TicketId,
} from '@fabrica/contracts'

import { CheckOutcome, type ChecksShape, notRunReason } from '../checks'
import { type GitShape, Prepared, RebaseOutcome, type Worktree } from '../git'
import {
  type MergeSetupShape,
  SetupOutcome,
  isSetupFile,
  pendingSetup,
  setUpRecorded,
  setupFilesBrought,
} from '../merge'
import { ExitStatus } from '../process'
import type { RunLog } from '../runlog'
import { record } from './records'
import { type RunSnapshot, inPhase } from './state'

// The project's setup in a ticket's worktree (spec §13.8): run in each new worktree before its worker
// starts, and again in a reused one whose rebase changed a setup file, within `check_timeout`, its
// output kept in its log and its `check` record in the run's. The same setup serves the merge queue's
// port (§13.7 step 4). Where a setup is called for, the files it is for are recorded in the worktree's
// git folder until it passes, so one that failed or was cut short runs again. A failing setup puts its
// ticket back until a merge or a probe (`SETUP_FAILED`); those still waiting are named at the run's end
// (`SETUP_WAITS`).

/** The project's setup, as the run's settings give it. */
export interface ProjectSetup {
  /** `setup`: unset or `none`, nothing runs. */
  readonly command: CommandSetting
  /** The project's checkout, whose `.fabrica/run/checks/` keeps the setup's log. */
  readonly checkout: string
  /** `check_timeout`. */
  readonly timeLimit: Duration.Input
  /** A check's share of the machine's cores, at least 1. */
  readonly cores: number
}

/** How a command ended, in words. */
const exited: (status: ExitStatus) => string = ExitStatus.$match({
  Code: ({ code }) => `exited ${code}`,
  Signal: ({ signal }) => `was ended by ${signal}`,
})

/** What a setup's run came to, its failure in words (`SETUP_FAILED`). */
export const setupOutcomeOf: (outcome: CheckOutcome) => SetupOutcome =
  CheckOutcome.$match({
    Passed: () => SetupOutcome.Ready(),
    Failed: ({ status, log }) =>
      SetupOutcome.Failed({
        detail: `SETUP_FAILED: the setup ${exited(status)}; its output is in ${log}`,
      }),
    TimedOut: ({ log }) =>
      SetupOutcome.Failed({
        detail: `SETUP_FAILED: the setup ran past check_timeout; its output is in ${log}`,
      }),
    CouldNotRun: ({ reason }) =>
      SetupOutcome.Failed({
        detail: `SETUP_FAILED: the setup couldn't run: ${notRunReason(reason)}`,
      }),
  })

/**
 * The project's setup, run through the checks in a ticket's worktree, its record written to the run's
 * log: the merge queue's port, and what a dispatch sets its worktree up with.
 */
export const makeProjectSetup = (
  checks: ChecksShape,
  log: RunLog['Service'],
  setup: ProjectSetup,
): MergeSetupShape => ({
  run: ({ ticket, worktree }) =>
    CommandSetting.match(setup.command, {
      Unset: () => Effect.succeed(SetupOutcome.Ready()),
      None: () => Effect.succeed(SetupOutcome.Ready()),
      Command: ({ command }) =>
        checks
          .run({
            suite: 'setup',
            ticket: Option.some(ticket),
            command,
            worktree,
            checkout: setup.checkout,
            timeLimit: setup.timeLimit,
            cores: setup.cores,
            passedAt: Option.none(),
            nice: Option.none(),
          })
          .pipe(
            Effect.tap(outcome => record(log, outcome.record)),
            Effect.map(setupOutcomeOf),
          ),
    }),
})

/** What a new worktree tracking no setup file is set up for: all of it. */
const WHOLE_WORKTREE = '.'

/**
 * The setup files a dispatch's worktree is to be set up for: in a new one, those it tracks (the
 * worktree as a whole where it tracks none, so it is always set up and a setup cut short is known); in a
 * reused one, those its rebase onto `base` brought and those an earlier setup that didn't pass left
 * waiting. None, nothing runs.
 */
export const filesToSetUp = Effect.fn('Run.filesToSetUp')(function* (
  git: GitShape,
  {
    prepared,
    base,
    patterns,
  }: {
    readonly prepared: Prepared
    readonly base: CommitHash
    readonly patterns: ReadonlyArray<string>
  },
) {
  const worktree = prepared.worktree.path
  return yield* Prepared.$match(prepared, {
    Created: () =>
      Effect.map(
        git.trackedFiles({ repo: worktree, revision: 'HEAD' }),
        tracked => {
          const files = tracked.filter(file => isSetupFile(file, patterns))
          return files.length > 0 ? files : [WHOLE_WORKTREE]
        },
      ),
    Reused: ({ rebase }) =>
      Effect.gen(function* () {
        const pending = yield* pendingSetup(git, { worktree })
        if (!RebaseOutcome.$is('Rebased')(rebase)) return pending
        const since = yield* git.mergeBase({
          repo: worktree,
          branch: rebase.from,
          base,
        })
        const brought = yield* setupFilesBrought(git, {
          worktree,
          onto: base,
          since,
          patterns,
        })
        return [...new Set([...pending, ...brought])]
      }),
  })
})

/**
 * Sets up the worktree a dispatch prepared from the Base commit `base`, before its worker starts:
 * the project's setup, where one is set and the worktree has files to be set up for.
 */
export const setUpWorktree = Effect.fn('Run.setUpWorktree')(function* (
  git: GitShape,
  setup: MergeSetupShape,
  {
    ticket,
    prepared,
    base,
    command,
    patterns,
  }: {
    readonly ticket: TicketId
    readonly prepared: Prepared
    readonly base: CommitHash
    readonly command: CommandSetting
    readonly patterns: ReadonlyArray<string>
  },
) {
  if (!CommandSetting.guards.Command(command)) return SetupOutcome.Ready()
  const files = yield* filesToSetUp(git, { prepared, base, patterns })
  if (files.length === 0) return SetupOutcome.Ready()
  const { ready } = yield* setUpRecorded(git, setup, {
    ticket,
    worktree: prepared.worktree.path,
    files,
  })
  return ready
})

/** Whether a ticket in `phase` waits for a merge or a probe because its setup failed. */
export const waitsForSetup = (phase: Phase): boolean =>
  phase._tag === 'waiting' && phase.for._tag === 'setup'

/** The tickets of `snapshot` waiting because their setup failed. */
export const setupWaiting = (snapshot: RunSnapshot): ReadonlyArray<TicketId> =>
  inPhase(snapshot, 'waiting').flatMap(taken =>
    waitsForSetup(taken.phase) ? [taken.ticket] : [],
  )

/** The end line's word for each ticket left waiting because its setup failed (§13.9, `SETUP_WAITS`). */
export const setupWaitsLines = (snapshot: RunSnapshot): ReadonlyArray<string> =>
  setupWaiting(snapshot).map(
    ticket =>
      `SETUP_WAITS: ${ticket} waits for a merge or a probe: its setup failed`,
  )

/** What a merge does for a ticket waiting because its setup failed (§13.8). */
export type SetupRetry = Data.TaggedEnum<{
  /** Its worker's setup failed: back in the queue, set up again as it is dispatched. */
  Requeue: { readonly ticket: TicketId }
  /** Its merge's setup failed: back in line to merge, set up at its rebase step. */
  Remerge: { readonly worktree: Worktree }
  /** Its merge's setup failed and its worktree isn't there: it stays waiting. */
  Stays: { readonly ticket: TicketId }
}>
export const SetupRetry = Data.taggedEnum<SetupRetry>()

/**
 * What a merge does for each ticket `waiting` because its setup failed: those `failedAtMerge` go back
 * in line to merge in their worktree, as `worktrees` lists them; the others back in the queue.
 */
export const setupRetries = ({
  waiting,
  failedAtMerge,
  worktrees,
}: {
  readonly waiting: ReadonlyArray<TicketId>
  readonly failedAtMerge: ReadonlySet<TicketId>
  readonly worktrees: ReadonlyArray<Worktree>
}): ReadonlyArray<SetupRetry> =>
  waiting.map(ticket => {
    if (!failedAtMerge.has(ticket)) return SetupRetry.Requeue({ ticket })
    const found = worktrees.find(worktree => worktree.ticket === ticket)
    return found === undefined
      ? SetupRetry.Stays({ ticket })
      : SetupRetry.Remerge({
          worktree: {
            ticket: found.ticket,
            path: found.path,
            branch: found.branch,
          },
        })
  })
