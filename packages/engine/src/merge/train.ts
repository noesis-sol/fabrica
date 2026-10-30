import {
  Context,
  Data,
  Effect,
  Fiber,
  Option,
  Ref,
  Scope,
  SynchronizedRef,
} from 'effect'

import type { CheckSuite, CommitHash, TicketId } from '@fabrica/contracts'

import { type CheckInput, CheckOutcome, Checks } from '../checks'
import {
  CantTell,
  Git,
  type GitFailed,
  RebaseOutcome,
  type Worktree,
} from '../git'
import { recordingWrites } from './hygiene'
import { MergeOutcome, MergeUpdate } from './outcome'
import {
  MergeSetup,
  SetupOutcome,
  pendingSetup,
  recordSetup,
  setUpRecorded,
  setupFilesBrought,
} from './setup'
import type { MergeTurn } from './turn'

// The merge train (spec §13.7, orchestra-8qk2): while one ticket's merge check runs, the next ticket in
// line rides beside it: its branch is rebased onto the first's rebased head in its own worktree, set up
// where that rebase, or a setup its worktree waits for, calls for it, and checked there. If the first
// merges as checked, the second's turn takes that check's outcome and merges with no further check;
// otherwise the second's branch is put back where it was, set up again where the ride set it up, and its
// turn prepares it afresh. A stop puts it back without waiting on a setup: the worktree records the
// files, and the ticket's next merge, or its next ride, sets it up. One ticket rides at most, never
// deeper (`merge.train`), and none while the machine budget holds.

/** Whether the machine budget holds (§14.3): no ticket rides while it does. Until it is built, it never holds. */
export const MachineHold = Context.Reference<{
  readonly holds: Effect.Effect<boolean>
}>('@fabrica/engine/MachineHold', {
  defaultValue: () => ({ holds: Effect.succeed(false) }),
})

/** The run of the project's merge check `command` in the turn's worktree, as `suite`: a fix's or a recheck's, or a merge's. */
export const mergeCheckInput = (
  turn: MergeTurn,
  command: string,
  suite: CheckSuite = 'merge',
): CheckInput => ({
  suite,
  ticket: Option.some(turn.worktree.ticket),
  command,
  worktree: turn.worktree.path,
  checkout: turn.config.home.checkout,
  timeLimit: turn.config.checkTimeout,
  cores: turn.config.cores,
  passedAt: Option.none(),
  nice: Option.none(),
})

/** What a ride came to. */
type Ridden = Data.TaggedEnum<{
  /** Its branch was rebased to `head` and checked there. */
  Checked: { readonly head: CommitHash; readonly outcome: CheckOutcome }
  /** It wasn't checked: its rebase stopped, its branch put back by git, or left nothing to merge. */
  NotChecked: {}
  /** The setup its rebase called for failed. */
  SetupFailed: { readonly detail: string }
}>
const Ridden = Data.taggedEnum<Ridden>()

/** The next ticket in line, riding beside the merge check of `first`'s head `onto`. */
interface Ride {
  readonly first: TicketId
  readonly onto: CommitHash
  /** The rider's turn, for its worktree and its check. */
  readonly rider: MergeTurn
  /** The rider's head before the ride: where its branch is put back. */
  readonly from: CommitHash
  /** The setup files the ride set the worktree up for: set up again when it is put back, or recorded as waited for. */
  readonly setUp: Ref.Ref<ReadonlyArray<string>>
  readonly fiber: Fiber.Fiber<Ridden>
}

/** The train's one carriage (H58): changed only by the queue's consumer, through atomic transitions. */
type Carriage = Data.TaggedEnum<{
  Empty: {}
  /** A ride waits on its first's outcome. */
  Riding: { readonly ride: Ride }
  /** The first merged as checked: the ride stands for its rider's turn. */
  Kept: { readonly ride: Ride }
  /** The rider's branch couldn't be put back: its turn ends with `outcome`, never merging the first's commits. */
  Stranded: { readonly ticket: TicketId; readonly outcome: MergeOutcome }
}>
const Carriage = Data.taggedEnum<Carriage>()

/** The rider of a carriage holding one. */
const riderOf = (carriage: Carriage): Option.Option<TicketId> =>
  Carriage.$match(carriage, {
    Empty: () => Option.none(),
    Riding: ({ ride }) => Option.some(ride.rider.worktree.ticket),
    Kept: ({ ride }) => Option.some(ride.rider.worktree.ticket),
    Stranded: ({ ticket }) => Option.some(ticket),
  })

/** A ride's check outcome its rider's turn takes as its own: a pass or a failure, never a time limit or a check that couldn't run, as those may be the ride's. */
const standsFor = CheckOutcome.$match({
  Passed: () => true,
  Failed: () => true,
  TimedOut: () => false,
  CouldNotRun: () => false,
})

export interface MergeTrain {
  /**
   * A turn's step into the queue: waits for the ride its ticket took, so that nothing else works in its
   * worktree; the outcome its turn ends with when its branch couldn't be put back after one.
   */
  readonly arrive: (
    turn: MergeTurn,
  ) => Effect.Effect<Option.Option<MergeOutcome>>
  /**
   * The merge check `command` of the turn's `head` on top of `onto`, its record published: the ride's
   * outcome when the ticket rode to that head and its first merged as checked, else the check run in its
   * worktree as `suite`, the next ticket in line riding beside it.
   */
  readonly check: (input: {
    readonly turn: MergeTurn
    readonly onto: CommitHash
    readonly head: CommitHash
    readonly command: string
    readonly suite: CheckSuite
  }) => Effect.Effect<CheckOutcome, CantTell | GitFailed>
  /** A turn ended with `outcome`: a ride beside it is kept when it merged as checked, and put back otherwise. */
  readonly settle: (outcome: MergeOutcome) => Effect.Effect<void>
}

/**
 * The train of one run's merges: `depth` is `merge.train`, `next` the ticket waiting first in line. Its
 * rides end with the scope, their branches put back.
 */
export const makeTrain = Effect.fn('MergeTrain.make')(function* ({
  depth,
  next,
}: {
  readonly depth: number
  readonly next: Effect.Effect<Option.Option<Worktree>>
}) {
  const git = yield* Git
  const checks = yield* Checks
  const setup = yield* MergeSetup
  const scope = yield* Scope.Scope
  const carriage = yield* SynchronizedRef.make<Carriage>(Carriage.Empty())

  /** The commit HEAD is at in `worktree`. */
  const headOf = (worktree: string) =>
    Effect.flatMap(
      git.commitHash({ repo: worktree, revision: 'HEAD' }),
      Option.match({
        onNone: () =>
          Effect.fail(
            new CantTell({
              read: 'commitHash',
              reason: 'HEAD names no commit',
            }),
          ),
        onSome: Effect.succeed,
      }),
    )

  /**
   * Runs a turn's merge check as `suite` and publishes its record, marked as the train's where `train`;
   * the untracked files it writes are recorded as the queue's, however it ends.
   */
  const runCheck = (
    turn: MergeTurn,
    command: string,
    train: boolean,
    suite: CheckSuite = 'merge',
  ) =>
    recordingWrites(
      git,
      turn.worktree.path,
      checks.run(mergeCheckInput(turn, command, suite)),
    ).pipe(
      Effect.map(({ value }) => value),
      Effect.tap(outcome =>
        turn.publish(
          MergeUpdate.Check({
            ticket: turn.worktree.ticket,
            record: train ? { ...outcome.record, train: true } : outcome.record,
          }),
        ),
      ),
    )

  /** The rider's branch rebased onto `onto`, set up and checked. */
  const ride = Effect.fn('MergeTrain.ride')(function* ({
    rider,
    onto,
    from,
    command,
    setUp,
  }: {
    readonly rider: MergeTurn
    readonly onto: CommitHash
    readonly from: CommitHash
    readonly command: string
    readonly setUp: Ref.Ref<ReadonlyArray<string>>
  }) {
    const { ticket, path } = rider.worktree
    const { since, pending } = yield* Effect.all(
      {
        since: git.mergeBase({ repo: path, branch: from, base: onto }),
        pending: pendingSetup(git, { worktree: path }),
      },
      { concurrency: 'unbounded' },
    )
    const rebased = yield* git.rebase({ worktree: path, onto })
    if (!RebaseOutcome.$is('Rebased')(rebased)) {
      yield* git.abortRebase({ worktree: path })
      return Ridden.NotChecked()
    }
    const { head } = rebased
    if (head === onto) return Ridden.NotChecked()
    const brought = yield* setupFilesBrought(git, {
      worktree: path,
      onto,
      since,
      patterns: rider.config.setupFiles,
    })
    // A worktree that waited for a setup is set up before its ride's check, as its own turn's would be.
    const files = [...new Set([...pending, ...brought])]
    if (files.length > 0) {
      yield* Ref.set(setUp, files)
      const { ready } = yield* setUpRecorded(git, setup, {
        ticket,
        worktree: path,
        files,
      })
      if (SetupOutcome.$is('Failed')(ready))
        return Ridden.SetupFailed({ detail: ready.detail })
    }
    const outcome = yield* runCheck(rider, command, true)
    return Ridden.Checked({ head, outcome })
  })

  /**
   * Ends a ride and puts its rider's branch back where it was, any rebase aborted; set up again for the
   * files the ride set it up for where `setUpAgain`, and else recorded as waiting for that setup. Empty,
   * or stranded when git can't put it back.
   */
  const putBack = (
    ride: Ride,
    { setUpAgain }: { readonly setUpAgain: boolean },
  ) => {
    const { ticket, path } = ride.rider.worktree
    return Effect.gen(function* () {
      yield* Fiber.interrupt(ride.fiber)
      const files = yield* Ref.get(ride.setUp)
      // A record that can't be written leaves the setup to chance, never the branch where the ride took it.
      if (!setUpAgain && files.length > 0)
        yield* recordSetup(git, { worktree: path, files }).pipe(
          Effect.catch(error =>
            Effect.logWarning(
              `Couldn't record the setup ${ticket}'s worktree waits for`,
              error,
            ),
          ),
        )
      yield* git.abortRebase({ worktree: path })
      if ((yield* headOf(path)) !== ride.from)
        yield* git.resetTo({ worktree: path, to: ride.from })
      if (!setUpAgain || files.length === 0) return Carriage.Empty()
      const { ready } = yield* setUpRecorded(git, setup, {
        ticket,
        worktree: path,
        files,
      })
      return SetupOutcome.$match(ready, {
        Ready: () => Carriage.Empty(),
        Failed: ({ detail }) =>
          Carriage.Stranded({
            ticket,
            outcome: MergeOutcome.SetupFailed({ ticket, detail }),
          }),
      })
    }).pipe(
      Effect.catch((error: CantTell | GitFailed) =>
        Effect.succeed(
          Carriage.Stranded({
            ticket,
            outcome: MergeOutcome.SetAside({
              ticket,
              reason: 'GIT_FAILED',
              detail: `GIT_FAILED: the merge train couldn't put ${ride.rider.worktree.branch} back at ${ride.from}: ${error.message}`,
            }),
          }),
        ),
      ),
    )
  }

  /** The next ticket in line boards beside the check of `turn`'s `head`, where the train may take it. */
  const board = Effect.fn('MergeTrain.board')(function* (
    current: Carriage,
    {
      turn,
      head,
      command,
    }: {
      readonly turn: MergeTurn
      readonly head: CommitHash
      readonly command: string
    },
  ) {
    if (!Carriage.$is('Empty')(current) || depth < 1) return current
    if (yield* (yield* MachineHold).holds) return current
    const waiting = yield* next
    if (Option.isNone(waiting)) return current
    const rider: MergeTurn = { ...turn, worktree: waiting.value }
    const from = yield* Effect.option(headOf(rider.worktree.path))
    if (Option.isNone(from)) return current
    const setUp = yield* Ref.make<ReadonlyArray<string>>([])
    const fiber = yield* ride({
      rider,
      onto: head,
      from: from.value,
      command,
      setUp,
    }).pipe(
      Effect.catch(() => Effect.succeed(Ridden.NotChecked())),
      Effect.forkIn(scope),
    )
    return Carriage.Riding({
      ride: {
        first: turn.worktree.ticket,
        onto: head,
        rider,
        from: from.value,
        setUp,
        fiber,
      },
    })
  })

  /** The ride's outcome the turn takes for its check of `head` on top of `onto`, the ride then over. */
  const taken = (
    current: Carriage,
    {
      turn,
      onto,
      head,
    }: {
      readonly turn: MergeTurn
      readonly onto: CommitHash
      readonly head: CommitHash
    },
  ): Effect.Effect<readonly [Option.Option<CheckOutcome>, Carriage]> => {
    if (
      !Carriage.$is('Kept')(current) ||
      current.ride.rider.worktree.ticket !== turn.worktree.ticket
    )
      return Effect.succeed([Option.none(), current])
    const { ride } = current
    return Effect.map(Fiber.join(ride.fiber), ridden => [
      ride.onto === onto &&
      Ridden.$is('Checked')(ridden) &&
      ridden.head === head &&
      standsFor(ridden.outcome)
        ? Option.some(ridden.outcome)
        : Option.none(),
      Carriage.Empty(),
    ])
  }

  const check: MergeTrain['check'] = Effect.fn('MergeTrain.check')(function* ({
    turn,
    onto,
    head,
    command,
    suite,
  }) {
    const ahead = yield* SynchronizedRef.modifyEffect(carriage, current =>
      taken(current, { turn, onto, head }),
    )
    if (Option.isSome(ahead)) return ahead.value
    yield* SynchronizedRef.updateEffect(carriage, current =>
      Carriage.$is('Riding')(current) &&
      current.ride.first === turn.worktree.ticket
        ? current.ride.onto === head
          ? Effect.succeed(current)
          : Effect.flatMap(putBack(current.ride, { setUpAgain: true }), after =>
              board(after, { turn, head, command }),
            )
        : board(current, { turn, head, command }),
    )
    return yield* runCheck(turn, command, false, suite)
  })

  const arrive: MergeTrain['arrive'] = Effect.fn('MergeTrain.arrive')(
    function* (turn) {
      const { ticket } = turn.worktree
      const current = yield* SynchronizedRef.get(carriage)
      // The ride is waited for outside the carriage, so a stop can put back what it holds meanwhile.
      if (
        Carriage.$is('Kept')(current) &&
        current.ride.rider.worktree.ticket === ticket
      )
        yield* Fiber.join(current.ride.fiber)
      return yield* SynchronizedRef.modifyEffect(carriage, now =>
        Carriage.$match(now, {
          Empty: () => Effect.succeed([Option.none(), now] as const),
          Riding: () => Effect.succeed([Option.none(), now] as const),
          Kept: ({ ride }) =>
            ride.rider.worktree.ticket !== ticket
              ? Effect.succeed([Option.none(), now] as const)
              : Effect.map(Fiber.join(ride.fiber), ridden =>
                  Ridden.$is('SetupFailed')(ridden)
                    ? ([
                        Option.some(
                          MergeOutcome.SetupFailed({
                            ticket,
                            detail: ridden.detail,
                          }),
                        ),
                        Carriage.Empty(),
                      ] as const)
                    : ([Option.none(), now] as const),
                ),
          Stranded: given =>
            Effect.succeed(
              given.ticket === ticket
                ? ([Option.some(given.outcome), Carriage.Empty()] as const)
                : ([Option.none(), now] as const),
            ),
        }),
      )
    },
  )

  const settle: MergeTrain['settle'] = Effect.fn('MergeTrain.settle')(
    function* (outcome) {
      const { ticket } = outcome
      yield* SynchronizedRef.updateEffect(carriage, current => {
        if (Carriage.$is('Riding')(current) && current.ride.first === ticket) {
          const { ride } = current
          const asChecked =
            MergeOutcome.$is('Merged')(outcome) &&
            !outcome.unchecked &&
            outcome.commit === ride.onto
          return asChecked
            ? Effect.succeed(Carriage.Kept({ ride }))
            : putBack(ride, { setUpAgain: true })
        }
        if (!Option.contains(riderOf(current), ticket))
          return Effect.succeed(current)
        return Carriage.$is('Kept')(current) || Carriage.$is('Riding')(current)
          ? Effect.as(Fiber.interrupt(current.ride.fiber), Carriage.Empty())
          : Effect.succeed(Carriage.Empty())
      })
    },
  )

  // A ride the scope ends before its first merged is put back; its setup is recorded for the ticket's next merge.
  yield* Effect.addFinalizer(() =>
    Effect.flatMap(SynchronizedRef.get(carriage), current =>
      Carriage.$match(current, {
        Empty: () => Effect.void,
        Riding: ({ ride }) =>
          Effect.asVoid(putBack(ride, { setUpAgain: false })),
        Kept: ({ ride }) => Fiber.interrupt(ride.fiber),
        Stranded: () => Effect.void,
      }),
    ),
  )

  return { arrive, check, settle } satisfies MergeTrain
})
