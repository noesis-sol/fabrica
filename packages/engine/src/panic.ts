import { Cause, Effect } from 'effect'

// What a fiber the run can't go on without does with its cause (spec §13.11): anything but an
// interruption is a defect of the engine's, and stops the run `PANIC`.

/**
 * A cause's handler: anything but an interruption is a panic, given to `panicked` in its words; an
 * interruption goes on being one.
 */
export const onPanic =
  <A>(panicked: (detail: string) => Effect.Effect<A>) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<A> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : panicked(Cause.pretty(cause))
