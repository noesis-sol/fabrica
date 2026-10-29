import { Context, Duration, Effect, Layer } from 'effect'

// How the process runner counts its time limits (spec §7.7): a command's time limit, the grace its
// output gets after it exits, the grace its tree gets between terminate and kill. The wake service
// counts them in time awake, so a host's sleep doesn't spend them; it plugs in by providing this.

export interface DeadlinesShape {
  /** Completes once `duration` has passed, as these deadlines count time. */
  readonly sleep: (duration: Duration.Input) => Effect.Effect<void>
}

export class Deadlines extends Context.Service<Deadlines, DeadlinesShape>()(
  '@fabrica/engine/process/Deadlines',
) {}

/** Deadlines on Effect's own Clock, until the wake service provides time awake. */
export const layerClock: Layer.Layer<Deadlines> = Layer.succeed(Deadlines, {
  sleep: duration => Effect.sleep(duration),
})
