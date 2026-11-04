import { Duration, Effect, Option, Ref } from 'effect'
import { spawn } from 'node:child_process'

import { describe, expect, it } from '@effect/vitest'

import { endTree } from '../src/process'

// A tree's end looks for it gone with its host's poll: a test with live processes under TestClock gives
// one on the live clock, and a tree that outlives its first look ends as soon as it is gone, not when its
// grace does.

const GRACE = Duration.minutes(1)

describe("a tree's end", () => {
  it.effect(
    "polls for it gone with its host's poll, the clock not moving",
    () =>
      Effect.gen(function* () {
        const child = spawn(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'],
          {
            detached: true,
            stdio: 'ignore',
          },
        )
        const pid = child.pid ?? 0
        const row = { pid, ppid: process.pid, pgid: pid, zombie: false }
        // The table shows it for the signal's look and two more, and then not.
        const lists = yield* Ref.make(0)
        const polls = yield* Ref.make(0)
        yield* endTree({
          host: {
            listProcesses: Effect.map(
              Ref.getAndUpdate(lists, n => n + 1),
              n => Option.some(n < 3 ? [row] : []),
            ),
            deadlines: { sleep: () => Effect.never },
            poll: Ref.update(polls, n => n + 1),
            self: process.pid,
          },
          pid,
          holders: [],
          grace: GRACE,
        })
        expect(yield* Ref.get(polls)).toBe(2)
      }),
  )
})
