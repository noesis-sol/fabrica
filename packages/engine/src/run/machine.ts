import { Effect, Stream } from 'effect'

import { MachineBudget } from '../engine/budget'
import { type HoldsShape, type HoldsSnapshot, anyOn } from '../holds'

// The run's side of the machine budget (spec §7.3, §14, §14.3): `HOLD: MACHINE` while a run with a free
// slot and a ticket to take finds the engine's live workers at `machine_workers`, lifted as one ends. It
// has side effects, so it runs apart from the question whether the run may take work. The slots a look
// fills are claimed from the budget atomically, as another run's look may want the last one.

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
    /**
     * The slots a look may fill, of the `room` the run has: none while the budget is reached, which
     * holds a run that wants one; a run with no room or nothing to take doesn't wait on the machine.
     */
    free: ({
      room,
      wanted,
    }: {
      readonly room: number
      readonly wanted: boolean
    }) =>
      Effect.gen(function* () {
        if (room <= 0 || !wanted) {
          yield* lift
          return 0
        }
        const left = yield* budget.left
        if (left <= 0) {
          yield* hold
          return 0
        }
        yield* lift
        return Math.min(room, left)
      }),
    /** Claims `wanted` slots: those another run's look took since aren't given, and the run holds for them. */
    claim: (wanted: number) =>
      Effect.tap(seat.claim(wanted), granted =>
        granted < wanted ? hold : Effect.void,
      ),
    release: seat.release,
    moved: seat.moved,
    /** Lifts the hold each time the live workers fall below the budget; runs for the run's life. */
    watch: Stream.runForEach(budget.changes, () =>
      Effect.flatMap(budget.holds, reached => (reached ? Effect.void : lift)),
    ),
  }
})
