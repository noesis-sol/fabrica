import { Duration, Effect, Fiber, Option, Queue, Stream } from 'effect'
import { TestClock } from 'effect/testing'

import { describe, expect, it } from '@effect/vitest'

import { frameWaitLimit, frameWithin, perFrame } from '../src/app/frame'

// A page whose window is hidden or minimized (the macOS app's window closed, spec §18.5) gets no
// animation frames: what arrives still goes on, a frame waited on for `frameWaitLimit` at most, so
// the notifications the page decides are told while nobody sees it.

describe('a page with no animation frames', () => {
  it.effect('hands on what arrived once the wait limit has gone by', () =>
    Effect.gen(function* () {
      const input = yield* Queue.unbounded<number>()
      const batches = yield* Queue.unbounded<ReadonlyArray<number>>()
      yield* Stream.fromQueue(input).pipe(
        perFrame(frameWithin(Effect.never, frameWaitLimit)),
        Stream.runForEach(batch => Queue.offer(batches, batch)),
        Effect.forkScoped,
      )
      yield* Queue.offerAll(input, [1, 2])
      yield* Effect.yieldNow
      yield* TestClock.adjust(
        Duration.subtract(frameWaitLimit, Duration.millis(1)),
      )
      expect(yield* Queue.poll(batches)).toEqual(Option.none())
      yield* Queue.offer(input, 3)
      yield* TestClock.adjust(Duration.millis(1))
      expect(yield* Queue.take(batches)).toEqual([1, 2, 3])
    }),
  )

  it.effect('takes the frame where it comes first', () =>
    Effect.gen(function* () {
      const frame = yield* Queue.unbounded<void>()
      const waited = yield* Effect.forkScoped(
        frameWithin(Queue.take(frame), frameWaitLimit),
      )
      yield* Effect.yieldNow
      yield* Queue.offer(frame, undefined)
      // The test clock hasn't moved: the wait ended with the frame.
      yield* Fiber.join(waited)
    }),
  )
})
