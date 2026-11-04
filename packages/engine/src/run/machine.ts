import { Effect, Stream } from 'effect'

import { MachineBudget } from '../engine/budget'
import { type HoldsShape, type HoldsSnapshot, anyOn } from '../holds'

// The run's side of the machine budget (spec §7.3, §14, §14.3): `HOLD: MACHINE` while a run with a ticket
// it would take finds the engine's live workers at `machine_workers`, lifted as one ends; a run with none
// (at its limit, or with every ticket held back) doesn't wait on the machine, and ends as it would. It has
// side effects, so it runs apart from the question whether the run may take work. The slots a look fills
// are claimed from the budget atomically, as another run's look may want the last one.

/** The holds the question whether the run may take work reads: the machine's is decided apart. */
export const apartFromMachine = (holds: HoldsSnapshot): HoldsSnapshot => ({
  ...holds,
  on: holds.on.filter(on => on.hold !== 'MACHINE'),
})

/** The run's seat in the budget, its slots counted by `slots`, and `holds`' machine hold, for its scope. */
export const makeRunMachine = Effect.fn('RunMachine.make')(function* (input: {
  readonly holds: HoldsShape
  readonly slots: Effect.Effect<number>
}) {
  const budget = yield* MachineBudget
  const seat = yield* budget.join(input.slots)
  // A hold's raise or lift publishes the holds whether it changed them or not, and each publication wakes
  // the run: asked of a hold already so, a look would wake the next one, for good.
  const isOn = Effect.map(input.holds.current, holds => anyOn(holds, 'MACHINE'))
  const lift = Effect.flatMap(isOn, on =>
    on
      ? Effect.asVoid(
          input.holds.lift({
            hold: 'MACHINE',
            why: 'a worker ended, below machine_workers',
          }),
        )
      : Effect.void,
  )
  /** Holds the run while the budget is reached; a worker ended before its raise lifts it again. */
  const hold = Effect.gen(function* () {
    if (!(yield* isOn))
      yield* input.holds.raise({
        hold: 'MACHINE',
        why: `${budget.limit} workers live across the engine's runs (machine_workers)`,
      })
    if (!(yield* budget.holds)) yield* lift
  })
  return {
    /** The workers the budget allows beyond those live, for what is weighed before the slots are claimed. */
    left: budget.left,
    /** Claims as many of the `wanted` slots a look would fill as the budget leaves: another run's look may want the last one. */
    claim: seat.claim,
    release: seat.release,
    /**
     * The look's slots are filled, `short` of what it would have taken for the budget: it holds, so that
     * a worker's end in any run wakes it, and otherwise doesn't wait on the machine.
     */
    settle: (short: boolean) => (short ? hold : lift),
    moved: seat.moved,
    /** Lifts the hold each time the live workers are counted below the budget; runs for the run's life. */
    watch: Stream.runForEach(budget.changes, () =>
      Effect.flatMap(budget.holds, reached => (reached ? Effect.void : lift)),
    ),
  }
})
