import { Duration, Effect, Option, Ref } from 'effect'
import { spawn } from 'node:child_process'

import { describe, expect, it } from '@effect/vitest'

import { endTree } from '../src/process'

// A tree's end looks for it gone on the host's deadlines, as its grace counts (spec §7.7): where the process
// boundary's deadlines are on another clock than the run's (a whole run's tests, TestClock under live
// processes), a tree that outlives its first look still ends as soon as it is gone, not when its grace does.

const GRACE = Duration.minutes(1)

describe("a tree's end", () => {
  it.effect('polls for it gone on the deadlines, the clock not moving', () =>
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
          deadlines: {
            sleep: duration =>
              Duration.equals(Duration.fromInputUnsafe(duration), GRACE)
                ? Effect.never
                : Ref.update(polls, n => n + 1),
          },
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
