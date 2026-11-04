import { Data, type Duration, Effect, Option, Ref, Semaphore } from 'effect'

import type { CommitHash, Requirement } from '@fabrica/contracts'

import { Git } from '../git'
import type { ProcessRunner } from '../process'
import {
  RequirementsList,
  checkRequirements,
  foundWords,
  missingItems,
  requirementsAt,
  sameRequirements,
} from '../requirements'
import { type RunLog, warningLine } from '../runlog'
import type { Steps } from '../view/steps'
import { record } from './records'

// The requires list in a run (spec §17): checked as a start check before the first ticket and any worker
// carried over, and again once a merge, the run's or anyone's, changed the list on Base, before the next ticket starts. What is
// still missing stops the run `REQUIREMENTS_MISSING`, exit 2, with one list, each with its instruction: at
// the start at once, after a merge once the running tickets finish. Only Base's list runs, read from
// Base's commit (§12.6): a branch's entry is its worker's until it merges.

/** What a run's check of its requirements works from. */
export interface RequirementsInput {
  /** The project's checkout. */
  readonly checkout: string
  /** `check_timeout`. */
  readonly installLimit: Duration.Input
  readonly log: RunLog['Service']
  /** The run view's steps, which show an install under way. */
  readonly steps: Pick<Steps, 'during'>
  /** What each line is said under: `start: the requirements check`. */
  readonly saidAs: string
}

/** The one line a stop says what is missing in. */
export const missingLine = (items: ReadonlyArray<string>): string =>
  `${items.join('; ')}; meet ${items.length === 1 ? 'it' : 'them'} (each entry of \`requires\` in .fabrica/settings.json says how), then run again`

/** Checks `list`, each install said and shown as a step as it runs. */
export const checkInRun = (
  list: ReadonlyArray<Requirement>,
  input: RequirementsInput,
) =>
  checkRequirements({
    list,
    checkout: input.checkout,
    installLimit: input.installLimit,
    installing:
      ({ name, command }) =>
      install =>
        Effect.andThen(
          record(input.log, {
            kind: 'info',
            text: `${input.saidAs}: installing ${name}: ${command}`,
          }),
          input.steps.during('install')(install),
        ),
  })

/** Whether the run may start tickets, for its requirements. */
export type RequirementsGate = Data.TaggedEnum<{
  /** The list on Base was found met. */
  Clear: {}
  /** A merge changed the list, and it is being checked: no new tickets until it is. */
  Checking: {}
  /** The list on Base was found wanting: no new tickets, and the run stops once the running ones finish. */
  Missing: { readonly detail: string }
}>
export const RequirementsGate = Data.taggedEnum<RequirementsGate>()

/** The list as the run has it: `generation` counts its changes, and only the last's check counts. */
interface Watched {
  readonly list: ReadonlyArray<Requirement>
  readonly generation: number
  readonly gate: RequirementsGate
}

/**
 * What takes a merge's change of the list on Base: the run's own list and what it found of it, one change
 * at a time, with its checks one at a time (`fork` runs each beside the run, and `wake` says it ended).
 */
export const makeRequirementsWatch = Effect.fn('Run.requirementsWatch')(
  function* (input: {
    readonly list: ReadonlyArray<Requirement>
    readonly base: string
    /** Base's commit that `list` was read from. */
    readonly baseCommit: CommitHash
    readonly run: RequirementsInput
    readonly wake: Effect.Effect<void>
    /** The checkout went off Base during the run: it stops, `OFF_BRANCH` (§13.11). */
    readonly offBase: (detail: string) => Effect.Effect<void>
    readonly fork: (check: Effect.Effect<void>) => Effect.Effect<unknown>
  }) {
    const { run, base } = input
    const services = yield* Effect.context<ProcessRunner | Git>()
    const watched = yield* Ref.make<Watched>({
      list: input.list,
      generation: 0,
      gate: RequirementsGate.Clear(),
    })
    const reading = yield* Semaphore.make(1)
    let seen = input.baseCommit
    const checking = yield* Semaphore.make(1)

    const checkTurn = (list: ReadonlyArray<Requirement>, generation: number) =>
      checking.withPermit(
        Effect.gen(function* () {
          if ((yield* Ref.get(watched)).generation !== generation) return
          // Its commands run in the checkout: off Base, a branch's scripts would run, as at the start.
          const branch = yield* (yield* Git)
            .currentBranch({ repo: run.checkout })
            .pipe(Effect.orElseSucceed(() => Option.none<string>()))
          if (!Option.contains(branch, base))
            return yield* input.offBase(
              `the checkout ${run.checkout} went off ${base}, so the changed requires list wasn't checked: put it back on ${base}, then run again`,
            )
          const found = yield* checkInRun(list, run)
          const items = missingItems(found)
          const gate =
            items.length === 0
              ? RequirementsGate.Clear()
              : RequirementsGate.Missing({ detail: missingLine(items) })
          const current = yield* Ref.modify(watched, now =>
            now.generation === generation
              ? [true, { ...now, gate }]
              : [false, now],
          )
          if (!current) return
          yield* record(
            run.log,
            items.length === 0
              ? {
                  kind: 'info',
                  text: `${run.saidAs}: ${foundWords(found)}`,
                }
              : {
                  kind: 'warn',
                  text: warningLine({
                    tag: 'REQUIREMENTS_MISSING',
                    about: 'run',
                    text: `${missingLine(items)}; no new tickets, and the run stops once the running ones finish`,
                  }),
                },
          )
          yield* input.wake
        }),
      )

    return {
      /**
       * Takes Base's list as it is now, where Base moved since the last time: where the list changed, the
       * gate closes until it is checked. Only Base's commit is read where it didn't move, so a run asks
       * this as each merge ends and in each look, which nothing wakes for a merge the run didn't make.
       */
      baseMoved: reading
        .withPermit(
          Effect.gen(function* () {
            const git = yield* Git
            const revision = `refs/heads/${base}`
            const commit = yield* git
              .commitHash({ repo: run.checkout, revision })
              .pipe(Effect.orElseSucceed(() => Option.none<CommitHash>()))
            if (Option.isNone(commit) || commit.value === seen) return
            seen = commit.value
            const read = yield* requirementsAt({
              repo: run.checkout,
              revision: commit.value,
            })
            if (RequirementsList.$is('Unreadable')(read)) {
              yield* record(run.log, {
                kind: 'warn',
                text: warningLine({
                  tag: 'REQUIREMENTS_UNREAD',
                  about: 'run',
                  text: `the requires list on ${base} couldn't be read, so the run keeps the one it has: ${read.reason}`,
                }),
              })
              return
            }
            const changed = yield* Ref.modify(watched, now => {
              if (sameRequirements(now.list, read.list))
                return [Option.none<number>(), now] as const
              const generation = now.generation + 1
              return [
                Option.some(generation),
                {
                  list: read.list,
                  generation,
                  gate: RequirementsGate.Checking(),
                },
              ] as const
            })
            if (Option.isNone(changed)) return
            yield* record(run.log, {
              kind: 'info',
              text: `${run.saidAs}: the list changed on ${base}: checking it before the next ticket starts`,
            })
            yield* input.fork(
              Effect.provideContext(
                checkTurn(read.list, changed.value),
                services,
              ),
            )
          }),
        )
        .pipe(Effect.provideContext(services)),
      gate: Effect.map(Ref.get(watched), ({ gate }) => gate),
      /** The list as the run holds it now: the start's, or the last that a merge changed it to. */
      list: Effect.map(Ref.get(watched), ({ list }) => list),
    }
  },
)
