import { Array, Duration, Effect, Queue, Stream } from 'effect'

// Updates applied at most once per animation frame (spec §8.3, §18.5): a stream's items are gathered
// as they arrive and handed on together at the next frame, so a burst of patches costs one `update`
// and one render, and no frame is waited on while nothing arrives. A page whose window is hidden or
// minimized gets no animation frames, and still takes in what arrives (the notifications it decides,
// with the macOS app's window closed): a frame is waited on for `frameWaitLimit` at most.

/** The longest a frame is waited on before what arrived goes on without one. */
export const frameWaitLimit = Duration.millis(100)

/** `frame`, or `limit` gone by, whichever comes first. */
export const frameWithin = (
  frame: Effect.Effect<void>,
  limit: Duration.Duration,
): Effect.Effect<void> => Effect.raceFirst(frame, Effect.sleep(limit))

/** Waits for the browser's next animation frame, or `frameWaitLimit` where none comes first. */
export const nextAnimationFrame: Effect.Effect<void> = frameWithin(
  Effect.callback(resume => {
    const frame = requestAnimationFrame(() => resume(Effect.void))
    return Effect.sync(() => cancelAnimationFrame(frame))
  }),
  frameWaitLimit,
)

/**
 * `stream`'s items, gathered between frames: after an item arrives, everything that arrives until
 * `nextFrame` ends goes on as one array, in order. The stream's end or failure follows its last items.
 */
export const perFrame =
  (nextFrame: Effect.Effect<void>) =>
  <A, E, R>(
    stream: Stream.Stream<A, E, R>,
  ): Stream.Stream<Array.NonEmptyReadonlyArray<A>, E, R> =>
    Stream.unwrap(
      Effect.map(Stream.toQueue(stream, { capacity: 'unbounded' }), queue =>
        Stream.fromEffectRepeat(
          Effect.gen(function* () {
            const first = yield* Queue.takeAll(queue)
            yield* nextFrame
            const rest = yield* Queue.clear(queue)
            return Array.appendAll(first, rest)
          }),
        ),
      ),
    )
