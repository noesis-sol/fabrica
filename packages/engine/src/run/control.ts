import { Deferred, Effect, Option, Ref } from 'effect'

import type { RunState } from '@fabrica/contracts'

import type { StartChecked } from './start-checks'
import { WakeReason, type Wakes, makeWakes } from './wakes'

// A run's control from outside it (spec §13.10, §8.1): stop it now, drain it (no new tickets, the
// running ones finish and merge) or take the drain back, and where it stands. Each wakes the run's
// loop with its reason, once per change: a second stop or drain changes nothing. The loop says when
// its start checks have come to an answer, so `run.start` answers with their problems or the run.

export interface RunControl {
  /** The run's wakes: the loop takes them, the control and every part of the run give them. */
  readonly wakes: Wakes
  /** The start checks' answer, given once by the loop as they end. */
  readonly checked: Deferred.Deferred<StartChecked>
  /** Where the run stands: getting ready, running, draining, or winding down to stop. */
  readonly state: Effect.Effect<RunState>
  /** Whether no new ticket is to be dispatched. */
  readonly draining: Effect.Effect<boolean>
  /** Stops the run now: it ends `INTERRUPTED`. */
  readonly stop: Effect.Effect<void>
  readonly drain: Effect.Effect<void>
  readonly undrain: Effect.Effect<void>
}

interface Standing {
  readonly draining: boolean
  readonly stopping: boolean
}

/** A run's control, the run getting ready, not draining. */
export const makeRunControl: Effect.Effect<RunControl> = Effect.gen(
  function* () {
    const wakes = yield* makeWakes
    const checked = yield* Deferred.make<StartChecked>()
    const standing = yield* Ref.make<Standing>({
      draining: false,
      stopping: false,
    })

    /** Sets `draining`, waking the run where it changed. */
    const setDraining = (draining: boolean) =>
      Effect.flatMap(
        Ref.modify(standing, now =>
          now.draining === draining
            ? [false, now]
            : [true, { ...now, draining }],
        ),
        changed =>
          changed ? wakes.wake(WakeReason.Drain({ draining })) : Effect.void,
      )

    return {
      wakes,
      checked,
      state: Effect.gen(function* () {
        const now = yield* Ref.get(standing)
        if (now.stopping) return 'stopping'
        if (!(yield* Deferred.isDone(checked))) return 'starting'
        return now.draining ? 'draining' : 'running'
      }),
      draining: Effect.map(Ref.get(standing), now => now.draining),
      stop: Effect.flatMap(
        Ref.modify(standing, now =>
          now.stopping ? [false, now] : [true, { ...now, stopping: true }],
        ),
        changed =>
          changed
            ? wakes.wake(
                WakeReason.Stopped({
                  kind: 'INTERRUPTED',
                  ticket: Option.none(),
                  detail: 'the run was stopped',
                }),
              )
            : Effect.void,
      ),
      drain: setDraining(true),
      undrain: setDraining(false),
    } satisfies RunControl
  },
)
