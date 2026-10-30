import {
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Match,
  Option,
  Ref,
  Stream,
} from 'effect'
import { basename, dirname, posix } from 'node:path'

import type { CheckSuite, CommitHash, TicketId } from '@fabrica/contracts'

import { CheckOutcome } from '../checks'
import { readFileText } from '../files'
import type { CantTell, GitFailed, GitShape, Worktree } from '../git'
import { spanText } from '../runlog'
import {
  type Aside,
  putBackChanged,
  removeWrote,
  wroteRecorded,
} from './hygiene'
import type { HandBackKind } from './outcome'
import {
  type MergeSetupShape,
  SetupOutcome,
  setUpRecorded,
  setupFilesBrought,
} from './setup'
import type { MergeTurn } from './turn'

// Hand-backs (spec §13.7, orchestra-nr1v.1, .2, -cgko): a merge's rebase conflict, or its merge check
// failing in the ticket's own code, goes back to the ticket's own worker, `RESOLVING` or `FIXING`, up to
// `hand_backs.resolve` and `hand_backs.fix` times a run, each within `resolve_timeout`. The turn ends as
// it hands back, and the queue goes on with the tickets behind it while the worker works. What the
// worker did is read from git, never taken from its word: a finished rebase, or commits on top of the
// head the check failed on, put the ticket back in line, where its next turn rebases it onto the current
// Base and runs one check; a worker that commits nothing gets that one more check, and no further
// hand-back. A fix or resolution leaving uncommitted or untracked files is rejected, naming them. At the
// deadline, its clock stopped while the run holds for the usage limit or the machine's load, the work
// git shows finished is taken, and otherwise the worker is interrupted and told the hand-back is over
// before its branch is put back, its attempt kept under `refs/fabrica/attempts/`. A check failing
// outside the ticket's code sets it aside, `CHECKS_FAILED`, to be checked once more once Base moves
// (`RECHECK`).

/** What a merge does with a conflict or a failed check. */
export type HandBack = Data.TaggedEnum<{
  /** The ticket is set aside: its rebase aborted, its worktree kept. */
  SetAside: Aside
  /** The ticket is set aside, and checked once more once Base moves on. */
  Recheck: Aside
  /** The ticket goes back to its worker, the rebase left in progress for a conflict. */
  Give: { readonly job: HandBackJob }
}>
export const HandBack = Data.taggedEnum<HandBack>()

/** A hand-back to give the ticket's worker. */
export interface HandBackJob {
  readonly turn: MergeTurn
  readonly kind: HandBackKind
  /** The how-manyth of its kind in the run, from 1. */
  readonly attempt: number
  readonly prompt: string
  /** Where its branch is put back when the hand-back isn't done: its head before the rebase, or the head its check failed on. */
  readonly from: CommitHash
  /** The commit of Base its branch was rebased onto. */
  readonly onto: CommitHash
  /** Why it is handed back, in words: `MERGE_CONFLICT in a.ts`. */
  readonly detail: string
}

/** What a ticket's next turn in the queue comes after. */
export type Awaiting = Data.TaggedEnum<{
  /** Its worker resolved its rebase's conflicts. */
  Resolved: {}
  /** Its worker was handed its check, which failed on `failedAt`; `committed` whether it committed a fix. */
  Fixed: { readonly failedAt: CommitHash; readonly committed: boolean }
  /** It was set aside for a check failing outside its code, and Base has moved since. */
  Recheck: {}
}>
export const Awaiting = Data.taggedEnum<Awaiting>()

/** The suite a turn's merge check runs as, as what it comes after says. */
export const suiteAfter = (awaiting: Option.Option<Awaiting>): CheckSuite =>
  Option.match(awaiting, {
    onNone: () => 'merge',
    onSome: Awaiting.$match({
      Resolved: (): CheckSuite => 'merge',
      Fixed: (): CheckSuite => 'fix',
      Recheck: (): CheckSuite => 'recheck',
    }),
  })

// ---- The worker ---------------------------------------------------------------------------------

/** How a hand-back's worker turn ended. */
export type WorkerAnswer = Data.TaggedEnum<{
  /** Its turn settled: git says what it did. */
  Settled: {}
  /** Its turn ended on the usage limit, the run holding for it by then. */
  AtLimit: {}
  /** It deferred its ticket. */
  Deferred: { readonly reason: string }
  /** Its worker couldn't be given the hand-back: no session to resume, or its resume failed. */
  Unavailable: { readonly reason: string }
}>
export const WorkerAnswer = Data.taggedEnum<WorkerAnswer>()

/** The ticket's worker, as a hand-back reaches it. */
export interface HandBackWorkerShape {
  /**
   * Resumes the ticket's worker in its worktree with `prompt` and waits for its turn to settle, on the
   * model that wrote it; interrupted, its turn is aborted.
   */
  readonly give: (input: {
    readonly ticket: TicketId
    readonly worktree: Worktree
    readonly kind: HandBackKind
    readonly attempt: number
    readonly prompt: string
  }) => Effect.Effect<WorkerAnswer>
  /** Tells the ticket's worker, its turn stopped, that its hand-back ended as `message` says. */
  readonly tell: (input: {
    readonly ticket: TicketId
    readonly message: string
  }) => Effect.Effect<void>
}

/** The workers hand-backs go to; until the run resumes its workers' sessions for them, none can take one. */
export const HandBackWorker = Context.Reference<HandBackWorkerShape>(
  '@fabrica/engine/merge/HandBackWorker',
  {
    defaultValue: () => ({
      give: () =>
        Effect.succeed(
          WorkerAnswer.Unavailable({
            reason: 'no worker session to resume for it',
          }),
        ),
      tell: () => Effect.void,
    }),
  },
)

// ---- The clock ----------------------------------------------------------------------------------

/** How a hand-back's time is counted. */
export interface HandBackClockShape {
  /** Completes once `duration` has passed, in time awake. */
  readonly sleep: (duration: Duration.Duration) => Effect.Effect<void>
  /** Whether the run holds for the usage limit or the machine's load: its value now, then each change. */
  readonly held: Stream.Stream<boolean>
}

/** The hand-backs' clock: a run gives its queue its holds' (`run/holds.ts`); by default the run never holds. */
export const HandBackClock = Context.Reference<HandBackClockShape>(
  '@fabrica/engine/merge/HandBackClock',
  {
    defaultValue: () => ({
      sleep: duration => Effect.sleep(duration),
      held: Stream.concat(Stream.make(false), Stream.never),
    }),
  },
)

/** Completes once `limit` has passed with the run not holding: the clock stops while it holds. */
export const runsOut = (
  clock: HandBackClockShape,
  limit: Duration.Input,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const left = yield* Ref.make(Duration.fromInputUnsafe(limit))
    const countDown = Effect.gen(function* () {
      const from = yield* Clock.currentTimeMillis
      const remaining = yield* Ref.get(left)
      yield* clock
        .sleep(remaining)
        .pipe(
          Effect.onInterrupt(() =>
            Effect.flatMap(Clock.currentTimeMillis, now =>
              Ref.update(left, still =>
                Duration.max(
                  Duration.zero,
                  Duration.subtract(still, Duration.millis(now - from)),
                ),
              ),
            ),
          ),
        )
    })
    yield* clock.held.pipe(
      Stream.changes,
      Stream.switchMap(held =>
        held ? Stream.never : Stream.fromEffect(countDown),
      ),
      Stream.runHead,
    )
  })

// ---- The book -----------------------------------------------------------------------------------

/** What the queue knows of one ticket's hand-backs in the run. */
interface Tally {
  readonly resolve: number
  readonly fix: number
  readonly awaiting: Option.Option<Awaiting>
  readonly job: Option.Option<HandBackJob>
  readonly rechecked: boolean
}

const none: Tally = {
  resolve: 0,
  fix: 0,
  awaiting: Option.none(),
  job: Option.none(),
  rechecked: false,
}

/** The run's hand-backs and rechecks, owned by its merge queue and changed only by atomic transitions (H58). */
export interface HandBackBook {
  /** The ticket's next attempt of `kind`, counted, while it has had fewer than `limit`; none past it. */
  readonly draw: (input: {
    readonly ticket: TicketId
    readonly kind: HandBackKind
    readonly limit: number
  }) => Effect.Effect<Option.Option<number>>
  /** Keeps the job for the queue to give, as its turn ends. */
  readonly hold: (job: HandBackJob) => Effect.Effect<void>
  /** The job the ticket's turn ended handing back, taken. */
  readonly take: (ticket: TicketId) => Effect.Effect<Option.Option<HandBackJob>>
  /** What the ticket's turn comes after. */
  readonly awaiting: (
    ticket: TicketId,
  ) => Effect.Effect<Option.Option<Awaiting>>
  /** What the ticket's next turn comes after. */
  readonly expect: (ticket: TicketId, awaiting: Awaiting) => Effect.Effect<void>
  /** The ticket's turn ended: what it came after is spent. */
  readonly turnEnded: (ticket: TicketId) => Effect.Effect<void>
  /** Keeps the ticket to be checked once more once Base moves on: false when it was once already. */
  readonly keepForRecheck: (worktree: Worktree) => Effect.Effect<boolean>
  /** The tickets kept to be checked once more, taken, each to be once in the run. */
  readonly rechecks: Effect.Effect<ReadonlyArray<Worktree>>
}

export const makeHandBackBook: Effect.Effect<HandBackBook> = Effect.gen(
  function* () {
    const tallies = yield* Ref.make<ReadonlyMap<TicketId, Tally>>(new Map())
    const waiting = yield* Ref.make<ReadonlyArray<Worktree>>([])
    const tallyOf = (all: ReadonlyMap<TicketId, Tally>, ticket: TicketId) =>
      all.get(ticket) ?? none
    const change = (ticket: TicketId, f: (tally: Tally) => Tally) =>
      Ref.update(tallies, all =>
        new Map(all).set(ticket, f(tallyOf(all, ticket))),
      )
    return {
      draw: ({ ticket, kind, limit }) =>
        Ref.modify(tallies, all => {
          const tally = tallyOf(all, ticket)
          if (tally[kind] >= limit) return [Option.none(), all]
          const attempt = tally[kind] + 1
          return [
            Option.some(attempt),
            new Map(all).set(ticket, { ...tally, [kind]: attempt }),
          ]
        }),
      hold: job =>
        change(job.turn.worktree.ticket, tally => ({
          ...tally,
          job: Option.some(job),
        })),
      take: ticket =>
        Ref.modify(tallies, all => {
          const tally = tallyOf(all, ticket)
          return [
            tally.job,
            new Map(all).set(ticket, { ...tally, job: Option.none() }),
          ]
        }),
      awaiting: ticket =>
        Effect.map(Ref.get(tallies), all => tallyOf(all, ticket).awaiting),
      expect: (ticket, awaiting) =>
        change(ticket, tally => ({
          ...tally,
          awaiting: Option.some(awaiting),
        })),
      turnEnded: ticket =>
        change(ticket, tally => ({ ...tally, awaiting: Option.none() })),
      keepForRecheck: worktree =>
        Effect.flatMap(Ref.get(tallies), (all): Effect.Effect<boolean> =>
          tallyOf(all, worktree.ticket).rechecked
            ? Effect.succeed(false)
            : Effect.as(
                Ref.update(waiting, kept => [
                  ...kept.filter(each => each.ticket !== worktree.ticket),
                  worktree,
                ]),
                true,
              ),
        ),
      rechecks: Effect.flatMap(Ref.getAndSet(waiting, []), kept =>
        Effect.as(
          Effect.forEach(
            kept,
            worktree =>
              change(worktree.ticket, tally => ({
                ...tally,
                rechecked: true,
              })),
            { discard: true },
          ),
          kept,
        ),
      ),
    } satisfies HandBackBook
  },
)

// ---- The prompts --------------------------------------------------------------------------------

/** A commit as the prompts name it. */
const short = (commit: CommitHash): string => commit.slice(0, 7)

/** Files git can't merge as text and people write: a conflict in these alone asks for no tests. */
const documentFile = /\.(?:md|mdx|markdown|txt|rst|adoc)$/iu

/** Whether every file of a conflict is a document (the spec, a changelog, …). */
export const documentsOnly = (files: ReadonlyArray<string>): boolean =>
  files.length > 0 && files.every(file => documentFile.test(file))

/** What the worker is asked to do with its rebase's conflicts. */
export const resolvePrompt = (input: {
  readonly ticket: TicketId
  readonly base: string
  readonly onto: CommitHash
  readonly files: ReadonlyArray<string>
  readonly attempt: number
  readonly limit: number
  readonly setup: Option.Option<string>
}): string => {
  const documents = documentsOnly(input.files)
  return [
    `Hand-back ${input.attempt} of ${input.limit} for ${input.ticket}: rebasing its branch onto ${input.base} at ${short(input.onto)} stopped on conflicts in ${input.files.join(', ')}. The rebase is in progress in your worktree.`,
    'Resolve each conflict keeping what both sides meant, `git add` the files and run `git rebase --continue` until the rebase is done.',
    documents
      ? 'The conflicts are in documents alone: resolve them and finish the rebase, nothing more; the merge check follows.'
      : 'Then run the tests of your change, not the whole check: the merge check follows.',
    ...Option.toArray(input.setup),
    'Leave no uncommitted or untracked files, and call finish once the rebase is done.',
  ].join('\n\n')
}

/** How many lines of a failed check's output the fix prompt quotes, at most. */
const QUOTED_LINES = 40

/** What the worker is asked to fix of its failed merge check. */
export const fixPrompt = (input: {
  readonly ticket: TicketId
  readonly base: string
  readonly onto: CommitHash
  readonly head: CommitHash
  readonly ended: string
  readonly failing: ReadonlyArray<string>
  readonly log: string
  readonly attempt: number
  readonly limit: number
}): string =>
  [
    `Hand-back ${input.attempt} of ${input.limit} for ${input.ticket}: the merge check ${input.ended} on its branch at ${short(input.head)}, rebased onto ${input.base} at ${short(input.onto)}.`,
    input.failing.length === 0
      ? `Its output is in ${input.log}.`
      : [
          'What failed:',
          ...input.failing.slice(0, QUOTED_LINES).map(line => `    ${line}`),
          `Its whole output is in ${input.log}.`,
        ].join('\n'),
    "Fix it in your change and commit the fix on your branch. Run what failed and the tests of your change, not the whole check: the merge check runs once more on what you commit. If the failure isn't your change's, commit nothing, and it is checked once more.",
    'Leave no uncommitted or untracked files, and call finish once the fix is committed.',
  ].join('\n\n')

/** What the worker is told when its hand-back's work is taken as git has it, `why` it ended. */
export const takenMessage = (
  job: HandBackJob,
  at: CommitHash,
  why: string,
): string =>
  `Your hand-back for ${job.turn.worktree.ticket} is over: ${why}. Your branch is taken as it is, at ${short(at)}, and the merge check runs on it. Stop here.`

/** What the worker is given again once the usage limit its turn ended on lifts, its hand-back still open. */
export const carryOnPrompt = (job: HandBackJob): string =>
  `The usage limit has lifted: carry on with hand-back ${job.attempt} for ${job.turn.worktree.ticket}, which asked:\n\n${job.prompt}`

/** What the worker is told when its hand-back is over, its branch put back. */
export const overMessage = (
  job: HandBackJob,
  why: string,
  attempt: Option.Option<string>,
): string =>
  `Your hand-back for ${job.turn.worktree.ticket} is over: ${why}. Your branch is put back at ${short(job.from)} and the ticket set aside${Option.match(attempt, { onNone: () => '', onSome: ref => `; your attempt is kept as ${ref}` })}. Stop here.`

// ---- The decisions ------------------------------------------------------------------------------

/** Why a hand-back of `kind` sets its ticket aside. */
const asideReason = { resolve: 'MERGE_CONFLICT', fix: 'CHECKS_FAILED' } as const

/** A conflict's files, in words. */
const inFiles = (files: ReadonlyArray<string>) =>
  files.length === 0 ? 'the rebase' : files.join(', ')

/**
 * A rebase onto `onto` that stopped on conflicts in `files`, the rebase still in progress: handed back
 * while the ticket has resolve hand-backs left, the setup run first where the rebase brings setup files
 * (spec §13.8), and else set aside, `MERGE_CONFLICT`.
 */
export const resolveConflict = Effect.fnUntraced(function* ({
  turn,
  files,
  onto,
  since,
  from,
  book,
  git,
  setup,
}: {
  readonly turn: MergeTurn
  readonly files: ReadonlyArray<string>
  readonly onto: CommitHash
  readonly since: Option.Option<CommitHash>
  readonly from: CommitHash
  readonly book: HandBackBook
  readonly git: GitShape
  readonly setup: MergeSetupShape
}) {
  const { ticket, path } = turn.worktree
  const { resolve: limit } = turn.config.handBacks
  const detail = `MERGE_CONFLICT in ${inFiles(files)}`
  const attempt = yield* book.draw({ ticket, kind: 'resolve', limit })
  if (Option.isNone(attempt))
    return HandBack.SetAside({
      reason: 'MERGE_CONFLICT',
      detail:
        limit === 0
          ? detail
          : `${detail}; its ${limit === 1 ? 'hand-back' : `${limit} hand-backs`} to resolve used up`,
    })
  const brought = yield* setupFilesBrought(git, {
    worktree: path,
    onto,
    since,
    patterns: turn.config.setupFiles,
  })
  // The worker tests its resolution in a worktree set up for what the rebase brings (§13.8).
  const setUp =
    brought.length === 0
      ? Option.none<string>()
      : yield* Effect.map(
          setUpRecorded(git, setup, { ticket, worktree: path, files: brought }),
          ({ ready }) =>
            SetupOutcome.$match(ready, {
              Ready: () => Option.none<string>(),
              Failed: ({ detail: failed }) =>
                Option.some(
                  `The setup the rebase calls for (${brought.join(', ')} changed) failed: ${failed}. Run it again once the conflicts are resolved.`,
                ),
            }),
        )
  return HandBack.Give({
    job: {
      turn,
      kind: 'resolve',
      attempt: attempt.value,
      prompt: resolvePrompt({
        ticket,
        base: turn.config.base,
        onto,
        files,
        attempt: attempt.value,
        limit,
        setup: setUp,
      }),
      from,
      onto,
      detail,
    },
  })
})

/** A line of a check's output saying something failed. */
const failingLine = /fail|error|✗|×|✘|panic/iu

/** A path in a line of output: a file with an extension, as `src/a.ts`, `src/a.ts:10:5` or `src/a.ts(10,5)`. */
const pathToken =
  /(?:^|[\s'"`([<])((?:\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z][\w]*)(?=$|[\s'"`)\]>:,(])/gu

/** The lines of a check's output that say something failed. */
export const failingLines = (output: string): ReadonlyArray<string> =>
  output
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => failingLine.test(line))

/** The tracked files the lines name, as paths from the repository's root. */
export const namedFiles = (
  lines: ReadonlyArray<string>,
  {
    worktree,
    tracked,
  }: { readonly worktree: string; readonly tracked: ReadonlySet<string> },
): ReadonlyArray<string> => {
  const found = new Set<string>()
  for (const line of lines)
    for (const [, token] of line.matchAll(pathToken)) {
      if (token === undefined) continue
      const inside = token.startsWith(`${worktree}/`)
        ? token.slice(worktree.length + 1)
        : token
      const path = posix.normalize(inside)
      if (tracked.has(path)) found.add(path)
    }
  return [...found]
}

/**
 * Whether a check failing on `named` files is in the ticket's own code: it names one of the folders its
 * commits change (`changed`), or names no file at all, so that only its worker can tell.
 */
export const inOwnCode = ({
  named,
  changed,
}: {
  readonly named: ReadonlyArray<string>
  readonly changed: ReadonlyArray<string>
}): boolean => {
  if (named.length === 0) return true
  const folders = new Set(changed.map(file => posix.dirname(file)))
  return named.some(
    file => changed.includes(file) || folders.has(posix.dirname(file)),
  )
}

/** How a failed check's detail says it ended. */
const ended = { Failed: 'failed', TimedOut: 'timed out' } as const

/** A check's output, read from its log; nothing where it can't be read. */
const outputOf = (log: string) =>
  readFileText({ root: dirname(log), path: basename(log) }).pipe(
    Effect.orElseSucceed(() => ''),
  )

/**
 * A merge check that failed or timed out on `head`, the ticket's branch on top of `onto`. A check after
 * a fix its worker committed nothing for, or a recheck, sets it aside; one failing in its own code goes
 * back to its worker while it has fix hand-backs left; one failing outside it, or timing out, sets it
 * aside to be checked once more once Base moves on, once in the run.
 */
export const fixCheck = Effect.fnUntraced(function* ({
  turn,
  outcome,
  onto,
  head,
  book,
  git,
}: {
  readonly turn: MergeTurn
  readonly outcome: Extract<
    CheckOutcome,
    { readonly _tag: 'Failed' | 'TimedOut' }
  >
  readonly onto: CommitHash
  readonly head: CommitHash
  readonly book: HandBackBook
  readonly git: GitShape
}) {
  const { ticket, path } = turn.worktree
  const { fix: limit } = turn.config.handBacks
  const detail = `CHECKS_FAILED: the merge check ${ended[outcome._tag]}; its output is in ${outcome.log}`
  const awaiting = yield* book.awaiting(ticket)
  const after = Option.getOrUndefined(awaiting)
  if (after !== undefined && Awaiting.$is('Recheck')(after))
    return HandBack.SetAside({
      reason: 'CHECKS_FAILED',
      detail: `${detail}; it failed again once ${turn.config.base} moved on`,
    })
  if (after !== undefined && Awaiting.$is('Fixed')(after) && !after.committed)
    return HandBack.SetAside({
      reason: 'CHECKS_FAILED',
      detail: `${detail}; its worker found nothing to fix, and it failed again`,
    })
  const recheck = () =>
    Effect.map(book.keepForRecheck(turn.worktree), kept =>
      kept
        ? HandBack.Recheck({
            reason: 'CHECKS_FAILED',
            detail: `${detail}; checked once more if ${turn.config.base} moves on`,
          })
        : HandBack.SetAside({ reason: 'CHECKS_FAILED', detail }),
    )
  // A time limit says nothing of where it failed: a loaded machine, as often as its code.
  if (CheckOutcome.$is('TimedOut')(outcome)) return yield* recheck()
  const [output, tracked, changed] = yield* Effect.all(
    [
      outputOf(outcome.log),
      git.trackedFiles({ repo: path, revision: head }),
      git.changedFiles({ repo: path, branch: head, base: onto }),
    ],
    { concurrency: 'unbounded' },
  )
  const failing = failingLines(output)
  const named = namedFiles(failing, {
    worktree: path,
    tracked: new Set(tracked),
  })
  if (!inOwnCode({ named, changed }))
    return yield* Effect.map(recheck(), handBack =>
      HandBack.$is('Recheck')(handBack)
        ? HandBack.Recheck({
            reason: handBack.reason,
            detail: `${handBack.detail}: it failed in ${named.join(', ')}, outside its own code`,
          })
        : handBack,
    )
  const attempt = yield* book.draw({ ticket, kind: 'fix', limit })
  if (Option.isNone(attempt))
    return HandBack.SetAside({
      reason: 'CHECKS_FAILED',
      detail:
        limit === 0
          ? detail
          : `${detail}; its ${limit === 1 ? 'hand-back' : `${limit} hand-backs`} to fix used up`,
    })
  return HandBack.Give({
    job: {
      turn,
      kind: 'fix',
      attempt: attempt.value,
      prompt: fixPrompt({
        ticket,
        base: turn.config.base,
        onto,
        head,
        ended: ended[outcome._tag],
        failing:
          failing.length > 0
            ? failing
            : output.split('\n').slice(-QUOTED_LINES),
        log: outcome.log,
        attempt: attempt.value,
        limit,
      }),
      from: head,
      onto,
      detail,
    },
  })
})

// ---- Following a hand-back ----------------------------------------------------------------------

/** What came of a hand-back. */
export type Followed = Data.TaggedEnum<{
  /** Its work is taken: the ticket goes back in line, its next turn after `awaiting`. */
  Requeue: { readonly awaiting: Awaiting; readonly detail: string }
  /** The ticket is set aside, its branch put back. */
  SetAside: Aside
}>
export const Followed = Data.taggedEnum<Followed>()

/** What git shows of a hand-back's work. */
type Work = Data.TaggedEnum<{
  /** Done: the rebase finished, or the branch on top of the head the check failed on. */
  Done: { readonly head: CommitHash; readonly committed: boolean }
  /** Done, but leaving files its commits don't hold. */
  Rejected: { readonly why: string }
  /** Not done. */
  NotDone: { readonly why: string }
}>
const Work = Data.taggedEnum<Work>()

/** Why a hand-back set its ticket aside, and the ref its attempt is kept as, in words. */
const keptWords = (why: string, kept: Option.Option<string>): string =>
  Option.match(kept, {
    onNone: () => why,
    onSome: ref => `${why}; its attempt is kept as ${ref}`,
  })

/** What attending a hand-back's worker came to. */
type Attended = Data.TaggedEnum<{
  /** Its turn ended as `answer` says, never on the usage limit. */
  Answered: {
    readonly answer: Exclude<WorkerAnswer, { readonly _tag: 'AtLimit' }>
  }
  /** At the usage limit, git showed its work done: taken. */
  Taken: { readonly head: CommitHash; readonly committed: boolean }
}>
const Attended = Data.taggedEnum<Attended>()

/** Work the hand-back asked for, finished: a rebase done, or a fix committed; a fix with no commit isn't. */
const finished = (
  kind: HandBackKind,
  work: Work,
): work is Extract<Work, { readonly _tag: 'Done' }> =>
  Work.$is('Done')(work) && (kind === 'resolve' || work.committed)

/** The ref a hand-back's attempt is kept under. */
const attemptRef = (job: HandBackJob) =>
  `refs/fabrica/attempts/${job.turn.worktree.ticket}/${job.kind}-${job.attempt}`

/**
 * Follows a hand-back: the worktree given back without what the queue's check wrote and changed, the
 * worker given the job within its time (the clock stopped while the run holds), and its work read from
 * git. Done, the ticket goes back in line; otherwise its branch is put back, the attempt kept, and it is
 * set aside.
 */
export const follow = Effect.fnUntraced(function* ({
  job,
  git,
  worker,
  clock,
}: {
  readonly job: HandBackJob
  readonly git: GitShape
  readonly worker: HandBackWorkerShape
  readonly clock: HandBackClockShape
}) {
  const { turn, kind } = job
  const { ticket, path, branch } = turn.worktree
  const reason = asideReason[kind]
  const aside = (why: string) =>
    Followed.SetAside({ reason, detail: `${job.detail}; ${why}` })

  /** What git shows the worker did. */
  const work: Effect.Effect<Work, CantTell | GitFailed> = Effect.gen(
    function* () {
      yield* putBackChanged(git, { worktree: path })
      const { rebasing, onBranch, head, status, wrote } = yield* Effect.all(
        {
          rebasing: git.isRebasing({ worktree: path }),
          onBranch: git.currentBranch({ repo: path }),
          head: git.commitHash({ repo: path, revision: 'HEAD' }),
          status: git.status({ worktree: path }),
          wrote: wroteRecorded(git, { worktree: path }),
        },
        { concurrency: 'unbounded' },
      )
      if (rebasing)
        return Work.NotDone({ why: 'the rebase is still in progress' })
      if (!Option.contains(onBranch, branch))
        return Work.NotDone({
          why: `${branch} isn't checked out in its worktree`,
        })
      if (Option.isNone(head))
        return Work.NotDone({ why: 'HEAD names no commit' })
      const at = head.value
      const over = kind === 'resolve' ? job.onto : job.from
      const since = yield* git.mergeBase({ repo: path, branch: at, base: over })
      if (!Option.contains(since, over))
        return Work.NotDone({
          why:
            kind === 'resolve'
              ? `${branch} isn't on top of ${turn.config.base} at ${short(job.onto)}`
              : `${branch} no longer holds ${short(job.from)}, the commit its check failed on`,
        })
      const queues = new Set(wrote)
      const untracked = status.untracked.filter(file => !queues.has(file))
      if (status.uncommitted.length > 0)
        return Work.Rejected({
          why: `it left uncommitted changes to ${status.uncommitted.join(', ')}`,
        })
      if (untracked.length > 0)
        return Work.Rejected({
          why: `it left untracked files: ${untracked.join(', ')}`,
        })
      return Work.Done({ head: at, committed: at !== job.from })
    },
  )

  /** The worker's attempt, where its HEAD is neither where its branch is put back nor Base, kept: the ref it is kept as. */
  const keepAttempt = Effect.gen(function* () {
    const head = yield* git.commitHash({ repo: path, revision: 'HEAD' })
    // A rebase stopped on its first commit has nothing of the worker's on top of Base yet.
    if (
      Option.isNone(head) ||
      head.value === job.from ||
      head.value === job.onto
    )
      return Option.none<string>()
    const ref = attemptRef(job)
    yield* git.keepCommit({ repo: path, ref, commit: head.value })
    return Option.some(ref)
  })

  /** The branch put back where the hand-back found it: any rebase aborted, then reset to it. */
  const restore = Effect.gen(function* () {
    yield* git.abortRebase({ worktree: path })
    const head = yield* git.commitHash({ repo: path, revision: 'HEAD' })
    if (!Option.contains(head, job.from))
      yield* git.resetTo({ worktree: path, to: job.from })
  })

  /** The attempt kept and the branch put back: the ticket set aside, saying why and where the attempt is. */
  const putBack = (why: string) =>
    Effect.map(
      Effect.tap(keepAttempt, () => restore),
      kept => aside(keptWords(why, kept)),
    )

  /** Done work taken: the ticket back in line. */
  const requeue = (head: CommitHash, committed: boolean) =>
    Followed.Requeue({
      awaiting:
        kind === 'resolve'
          ? Awaiting.Resolved()
          : Awaiting.Fixed({ failedAt: job.from, committed }),
      detail:
        kind === 'resolve'
          ? `its conflicts resolved, at ${short(head)}`
          : committed
            ? `its fix committed, at ${short(head)}`
            : 'its worker committed no fix: checked once more',
    })

  /**
   * The worker given `prompt` until its turn ends: on the usage limit, its work is taken where git shows
   * it done, and else it is given the hand-back again once the hold lifts, the clock stopped meanwhile.
   */
  const attend = (
    prompt: string,
  ): Effect.Effect<Attended, CantTell | GitFailed> =>
    Effect.flatMap(
      worker.give({
        ticket,
        worktree: turn.worktree,
        kind,
        attempt: job.attempt,
        prompt,
      }),
      (answer): Effect.Effect<Attended, CantTell | GitFailed> =>
        WorkerAnswer.$is('AtLimit')(answer)
          ? Effect.flatMap(work, done =>
              finished(kind, done)
                ? Effect.succeed(
                    Attended.Taken({
                      head: done.head,
                      committed: done.committed,
                    }),
                  )
                : Effect.andThen(
                    clock.held.pipe(
                      Stream.filter(held => !held),
                      Stream.runHead,
                    ),
                    attend(carryOnPrompt(job)),
                  ),
            )
          : Effect.succeed(Attended.Answered({ answer })),
    )

  const followed: Effect.Effect<Followed, CantTell | GitFailed> = Effect.gen(
    function* () {
      // A check's leavings aren't its worker's (fab-mgi.34, .95); a conflict's setup is for its worker.
      if (kind === 'fix') {
        yield* removeWrote(git, { worktree: path })
        yield* putBackChanged(git, { worktree: path })
      }
      const answer = yield* Effect.raceFirst(
        Effect.map(attend(job.prompt), Option.some),
        Effect.as(runsOut(clock, turn.config.handBacks.timeout), Option.none()),
      )
      if (Option.isNone(answer)) {
        const limit = spanText(
          Duration.fromInputUnsafe(turn.config.handBacks.timeout),
        )
        const late = `its hand-back ran past resolve_timeout (${limit})`
        const done = yield* work
        if (finished(kind, done)) {
          yield* worker.tell({
            ticket,
            message: takenMessage(job, done.head, 'its time ran out'),
          })
          return requeue(done.head, done.committed)
        }
        // Told before its branch is put back, so that it doesn't work on under it.
        const kept = yield* keepAttempt
        yield* worker.tell({ ticket, message: overMessage(job, late, kept) })
        yield* restore
        return aside(keptWords(late, kept))
      }
      if (Attended.$is('Taken')(answer.value)) {
        const { head, committed } = answer.value
        yield* worker.tell({
          ticket,
          message: takenMessage(job, head, 'its turn ended on the usage limit'),
        })
        return requeue(head, committed)
      }
      return yield* Match.valueTags(answer.value.answer, {
        Unavailable: ({ reason: why }) => putBack(`not handed back: ${why}`),
        Deferred: ({ reason: why }) =>
          Effect.as(
            Effect.tap(keepAttempt, () => restore),
            Followed.SetAside({
              reason: 'DEFERRED',
              detail: `its worker deferred it during its hand-back: ${why}`,
            }),
          ),
        Settled: () =>
          Effect.flatMap(work, done =>
            Work.$match(done, {
              Done: ({ head, committed }) =>
                Effect.succeed(requeue(head, committed)),
              Rejected: ({ why }) =>
                putBack(
                  `its ${kind === 'resolve' ? 'resolution' : 'fix'} was rejected: ${why}`,
                ),
              NotDone: ({ why }) =>
                putBack(`its worker ended its hand-back undone: ${why}`),
            }),
          ),
      })
    },
  )
  return yield* followed.pipe(
    Effect.catch(error =>
      Effect.succeed(
        Followed.SetAside({
          reason: 'GIT_FAILED',
          detail: `GIT_FAILED: after its hand-back: ${error.message}`,
        }),
      ),
    ),
  )
})
