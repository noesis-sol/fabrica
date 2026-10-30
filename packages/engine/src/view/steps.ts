import { DateTime, Effect, Option, Ref } from 'effect'

import { EngineStep, type StepKind, type TicketId } from '@fabrica/contracts'

// The engine's steps under way in a run (spec §8.3, H80): every step that may take more than a second
// (the start's checks, the backlog, the carry-over, a setup, the merge check, the full check and its
// setup, the report, an install, a breakdown) is in the run view from its start, with its start time,
// so a client shows what the run is doing and for how long. A step leaves the view as it ends, however
// it ends.

export interface Steps {
  /** Runs `effect` as the step `kind`, for `ticket` where it has one, in the view while it runs. */
  readonly during: (
    kind: StepKind,
    ticket?: TicketId,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** The steps under way, oldest first. */
  readonly current: Effect.Effect<ReadonlyArray<EngineStep>>
}

/** No steps under way. */
export const makeSteps: Effect.Effect<Steps> = Effect.gen(function* () {
  const under = yield* Ref.make<ReadonlyArray<EngineStep>>([])

  const during =
    (kind: StepKind, ticket?: TicketId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const step = new EngineStep({
            step: kind,
            ticket: Option.fromUndefinedOr(ticket),
            startedAt: yield* DateTime.now,
          })
          yield* Ref.update(under, steps => [...steps, step])
          return step
        }),
        () => effect,
        step => Ref.update(under, steps => steps.filter(each => each !== step)),
      )

  return { during, current: Ref.get(under) } satisfies Steps
})

/** How long `step` has been under way at `now`, in whole milliseconds, never negative (H55). */
export const stepElapsedMillis = (
  step: EngineStep,
  now: DateTime.Utc,
): number =>
  Math.max(
    0,
    DateTime.toEpochMillis(now) - DateTime.toEpochMillis(step.startedAt),
  )
