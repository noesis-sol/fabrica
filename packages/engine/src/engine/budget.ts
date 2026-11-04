import {
  Context,
  Effect,
  Ref,
  type Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect'

import { type EngineSettings, Host, machineWorkersOf } from '@fabrica/contracts'

// The machine budget (spec §7.3, §14.3, H35, H56): `machine_workers` caps the workers live across every
// run on the engine, and the machine's cores are divided among what is live. Each run takes a seat with
// the slots its own scheduler counts (`slotsTaken`), so a ticket past its work holding no slot isn't a
// live worker here either; tutti counted tickets waiting to merge, held with a slot free and paused its
// merge train. The engine's own checks, setups and organ sessions aren't workers, so they never hold a
// run, but they take a share of the cores counted among the live workers: in tutti a merge check ran
// with none, and its tests took every core beside the workers' own checks.

/** What is live on the machine at one moment. */
export interface Live {
  /** The slots the runs' schedulers count, across every run. */
  readonly workers: number
  /** The engine's own checks, setups and organ sessions running. */
  readonly commands: number
}

/** The share of `cores` each of what is `live` gets: the cores divided among them, at least 1. */
export const coreShare = (cores: number, live: Live): number =>
  Math.max(1, Math.floor(cores / Math.max(1, live.workers + live.commands)))

/** A run's place in the budget, from its `join` until its scope ends. */
export interface RunSeat {
  /**
   * Takes as many of `wanted` slots as the budget leaves, atomically across the runs, and says how
   * many; each counts until `release`, so two runs can't take the last one.
   */
  readonly claim: (wanted: number) => Effect.Effect<number>
  /** One claimed slot is over: its ticket's slot counts now, or it wasn't dispatched. */
  readonly release: Effect.Effect<void>
  /** The run's slots may have moved: `changes` is told. */
  readonly moved: Effect.Effect<void>
}

export interface MachineBudgetShape {
  /** `machine_workers`. */
  readonly limit: number
  /** Takes a seat for a run whose slots `slots` counts, until the scope ends. */
  readonly join: (
    slots: Effect.Effect<number>,
  ) => Effect.Effect<RunSeat, never, Scope.Scope>
  /** The workers the budget allows beyond those live; none or fewer while it is reached. */
  readonly left: Effect.Effect<number>
  /** Whether the budget is reached: `HOLD: MACHINE` for a run with a free slot. */
  readonly holds: Effect.Effect<boolean>
  /** The live workers now, then each change. */
  readonly changes: Stream.Stream<number>
  /** The share of a worker counted already; `given` where the engine hosts no budget. */
  readonly shareOf: (given: number) => Effect.Effect<number>
  /** Runs `use` with its share, counted among the live while it runs; `given` where the engine hosts no budget. */
  readonly counted: <A, E, R>(
    given: number,
    use: (cores: number) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

/** No budget: where no engine hosts the run, it takes every slot it wants and keeps the share it was given. */
const unbudgeted: MachineBudgetShape = {
  limit: Number.POSITIVE_INFINITY,
  join: () =>
    Effect.succeed({
      claim: Effect.succeed,
      release: Effect.void,
      moved: Effect.void,
    }),
  left: Effect.succeed(Number.POSITIVE_INFINITY),
  holds: Effect.succeed(false),
  changes: Stream.never,
  shareOf: Effect.succeed,
  counted: (given, use) => use(given),
}

/** The engine's budget, which the daemon gives its runs. */
export const MachineBudget = Context.Reference<MachineBudgetShape>(
  '@fabrica/engine/MachineBudget',
  { defaultValue: () => unbudgeted },
)

/** One run's seat. */
interface Seat {
  readonly slots: Effect.Effect<number>
  readonly claimed: Ref.Ref<number>
}

/** The budget of `settings` on the host's cores: `machine_workers`, or half the cores, at least 2. */
export const makeMachineBudget = Effect.fn('MachineBudget.make')(function* (
  settings: EngineSettings,
) {
  const { cores } = yield* (yield* Host).facts
  const limit = machineWorkersOf(settings, cores)
  const seats = yield* Ref.make<ReadonlyArray<Seat>>([])
  const commands = yield* Ref.make(0)
  // Claims and what `changes` says are one at a time: a count read isn't overtaken by a later one.
  const counting = yield* Semaphore.make(1)
  const published = yield* SubscriptionRef.make(0)

  const liveWorkers = Effect.flatMap(Ref.get(seats), all =>
    Effect.map(
      Effect.forEach(
        all,
        seat =>
          Effect.map(
            Effect.all([seat.slots, Ref.get(seat.claimed)]),
            ([slots, claimed]) => slots + claimed,
          ),
        { concurrency: 'unbounded' },
      ),
      counts => counts.reduce((sum, count) => sum + count, 0),
    ),
  )
  const publish = counting.withPermit(
    Effect.flatMap(liveWorkers, live => SubscriptionRef.set(published, live)),
  )
  const share = Effect.map(
    Effect.all([liveWorkers, Ref.get(commands)], {
      concurrency: 'unbounded',
    }),
    ([workers, running]) => coreShare(cores, { workers, commands: running }),
  )
  const left = Effect.map(liveWorkers, live => limit - live)

  const budget: MachineBudgetShape = {
    limit,
    join: slots =>
      Effect.gen(function* () {
        const claimed = yield* Ref.make(0)
        const seat: Seat = { slots, claimed }
        yield* Effect.acquireRelease(
          Effect.andThen(
            Ref.update(seats, all => [...all, seat]),
            publish,
          ),
          () =>
            Effect.andThen(
              Ref.update(seats, all => all.filter(each => each !== seat)),
              publish,
            ),
        )
        return {
          claim: wanted =>
            counting.withPermit(
              Effect.gen(function* () {
                const live = yield* liveWorkers
                const granted = Math.max(0, Math.min(wanted, limit - live))
                yield* Ref.update(claimed, count => count + granted)
                yield* SubscriptionRef.set(published, live + granted)
                return granted
              }),
            ),
          release: Effect.andThen(
            Ref.update(claimed, count => count - 1),
            publish,
          ),
          moved: publish,
        } satisfies RunSeat
      }),
    left,
    holds: Effect.map(left, room => room <= 0),
    changes: SubscriptionRef.changes(published).pipe(Stream.changes),
    shareOf: () => share,
    counted: (_given, use) =>
      Effect.acquireUseRelease(
        Ref.update(commands, count => count + 1),
        () => Effect.flatMap(share, use),
        () => Ref.update(commands, count => count - 1),
      ),
  }
  return budget
})

/** A worker's share of the cores as it starts, its slot counted already (§7.3). */
export const workerShare = (given: number): Effect.Effect<number> =>
  Effect.gen(function* () {
    const budget = yield* MachineBudget
    return yield* budget.shareOf(given)
  })

/** Runs one of the engine's own commands (a check, a setup, an organ's session) with its share, counted among the live (H56). */
export const withCommandShare = <A, E, R>(
  given: number,
  use: (cores: number) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const budget = yield* MachineBudget
    return yield* budget.counted(given, use)
  })
