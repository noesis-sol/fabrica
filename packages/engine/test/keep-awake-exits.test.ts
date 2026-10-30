import { Deferred, Effect, Fiber, Layer, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'

import {
  Deadlines,
  ExitStatus,
  ProcessRunner,
  type Running,
  layerClock,
} from '../src/process'
import { runProject } from '../src/run'
import { Battery, KeptAwake, Power, keepAwake } from '../src/time'
import {
  binFolder,
  configOf,
  eventsOf,
  ofKind,
  options,
  project,
  setUpRuns,
  withRuns,
} from './run-harness'

// An inhibitor that exits within its first second holds nothing (spec §7.7, H67): `systemd-inhibit`
// with no logind to ask, or refused its lock, exits at once, and the run says the host may sleep
// rather than counting it held. One still going after that second holds.

const linux = { platform: 'linux', pid: 4242 } as const

/** A runner whose inhibitor exits as `exited` completes. */
const inhibitorRunner = (exited: Deferred.Deferred<ExitStatus>) =>
  Layer.succeed(
    ProcessRunner,
    ProcessRunner.of({
      run: () => Effect.die('the inhibitor is only started'),
      start: () =>
        Effect.succeed<Running>({
          pid: 5000,
          stdout: Stream.empty,
          stderr: Stream.empty,
          write: () => Effect.void,
          closeStdin: Effect.void,
          exit: Deferred.await(exited),
          end: Effect.void,
        }),
    }),
  )

/** Deadlines that never pass: only the inhibitor's exit decides. */
const unending = Layer.succeed(Deadlines, { sleep: () => Effect.never })

describe('an inhibitor that exits at once', () => {
  it.effect('holds nothing, and says how it exited', () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<ExitStatus>()
      yield* Deferred.succeed(exited, ExitStatus.Code({ code: 1 }))
      const kept = yield* Effect.scoped(
        keepAwake({ keepAwake: true, overnight: false, host: linux }),
      ).pipe(Effect.provide([inhibitorRunner(exited), unending]))
      expect(kept).toEqual(
        KeptAwake.Ended({
          command: 'systemd-inhibit',
          status: ExitStatus.Code({ code: 1 }),
        }),
      )
    }),
  )

  it.effect('holds once it is still going a second after its start', () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<ExitStatus>()
      const holding = yield* Effect.forkScoped(
        keepAwake({ keepAwake: true, overnight: false, host: linux }).pipe(
          Effect.provide([inhibitorRunner(exited), layerClock]),
        ),
      )
      yield* TestClock.adjust('999 millis')
      expect(holding.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust('1 millis')
      expect(yield* Fiber.join(holding)).toEqual(
        KeptAwake.Holding({ command: 'systemd-inhibit', pid: 5000 }),
      )
    }).pipe(Effect.scoped),
  )
})

describe('a run whose inhibitor exits at once', () => {
  beforeAll(() => {
    setUpRuns()
    // The inhibitor's stand-in is refused its lock, as systemd-inhibit is without logind.
    writeFileSync(
      join(binFolder(), 'systemd-inhibit'),
      '#!/bin/sh\necho "Failed to inhibit: Access denied" >&2\nexit 1\n',
    )
    chmodSync(join(binFolder(), 'systemd-inhibit'), 0o755)
  })

  it.effect('says the host may idle-sleep, and goes on', () =>
    Effect.gen(function* () {
      const fixture = project()
      const events = yield* withRuns(
        fixture,
        Effect.gen(function* () {
          const end = yield* runProject({
            ...configOf(fixture, options()),
            keepAwakeHost: linux,
          }).pipe(
            Effect.provide(
              Layer.succeed(
                Battery,
                Battery.of({ read: Effect.succeedSome(Power.NoBattery()) }),
              ),
            ),
          )
          expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
          return yield* eventsOf(fixture)
        }),
      )
      expect(
        ofKind(events, 'warn')
          .filter(warn => warn.detail === 'KEEP_AWAKE_FAILED')
          .map(warn => warn.text),
      ).toEqual([
        'KEEP_AWAKE_FAILED: systemd-inhibit exited at once (exit 1); the host may idle-sleep',
      ])
    }),
  )
})
