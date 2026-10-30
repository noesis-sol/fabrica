import { Effect, Layer, Option } from 'effect'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'

import {
  ProcessRunner,
  type Running,
  type StartCommand,
  StartFailed,
  StartFailure,
} from '../src/process'
import { type RunConfig, runProject } from '../src/run'
import { Battery, type KeepAwakeHost, Power } from '../src/time'
import {
  type Project,
  binFolder,
  configOf,
  eventsOf,
  ofKind,
  options,
  project,
  setUpRuns,
  withRuns,
} from './run-harness'

// A run keeps its host from idle sleep and watches its battery while it goes (spec §7.7, §15.6,
// H67): the inhibitor starts as the run starts and ends with it, unless the engine's `keep_awake` is
// false; an inhibitor that doesn't start is said in the log; the battery's start notices and
// thresholds are the run's records. The run is a whole run on the harness, with no tickets; the
// host is a Linux one whose `systemd-inhibit` is a stub on the run's PATH, and its battery a stand-in.

beforeAll(() => {
  setUpRuns()
  // The inhibitor's stand-in holds until its tree is ended.
  writeFileSync(
    join(binFolder(), 'systemd-inhibit'),
    '#!/bin/sh\nexec sleep 3600\n',
  )
  chmodSync(join(binFolder(), 'systemd-inhibit'), 0o755)
})

const linuxHost: KeepAwakeHost = { platform: 'linux', pid: 4242 }

/** What the run asked the runner to start as its inhibitor, and what started. */
interface Inhibitors {
  readonly asked: Array<StartCommand>
  readonly running: Array<Running>
}

/**
 * The runner the run is given, the services' own, its inhibitor's starts noted: started, or failing
 * for `fails` where given.
 */
const noting = (inhibitors: Inhibitors, fails = Option.none<StartFailure>()) =>
  Layer.effect(
    ProcessRunner,
    Effect.map(ProcessRunner, real =>
      ProcessRunner.of({
        run: real.run,
        start: command => {
          if (command.command !== 'systemd-inhibit') return real.start(command)
          inhibitors.asked.push(command)
          return Option.match(fails, {
            onSome: reason => Effect.fail(new StartFailed({ reason })),
            onNone: () =>
              Effect.tap(real.start(command), running =>
                Effect.sync(() => inhibitors.running.push(running)),
              ),
          })
        },
      }),
    ),
  )

const battery = (power: Power) =>
  Layer.succeed(Battery, Battery.of({ read: Effect.succeedSome(power) }))

const onMains = battery(Power.Battery({ level: 80, discharging: false }))

/** The run of `fixture` with `config`'s changes, its inhibitor's starts noted, on `power`'s battery; its records. */
const runWith = (input: {
  readonly fixture: Project
  readonly inhibitors: Inhibitors
  readonly fails?: StartFailure
  readonly power?: Layer.Layer<Battery>
  readonly config?: Partial<RunConfig>
}) =>
  withRuns(
    input.fixture,
    Effect.gen(function* () {
      const end = yield* runProject({
        ...configOf(input.fixture, options()),
        keepAwakeHost: linuxHost,
        ...input.config,
      }).pipe(
        Effect.provide(
          Layer.merge(
            noting(input.inhibitors, Option.fromUndefinedOr(input.fails)),
            input.power ?? onMains,
          ),
        ),
      )
      expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
      return yield* eventsOf(input.fixture)
    }),
  )

const newInhibitors = (): Inhibitors => ({ asked: [], running: [] })

describe('keeping the host awake during a run', () => {
  it.effect(
    'holds the inhibitor while the run goes and ends it with the run',
    () =>
      Effect.gen(function* () {
        const inhibitors = newInhibitors()
        const events = yield* runWith({ fixture: project(), inhibitors })
        expect(
          inhibitors.asked.map(({ command, args }) => [command, args]),
        ).toEqual([
          [
            'systemd-inhibit',
            [
              '--what=idle',
              '--who=fabrica',
              '--why=A Fabrica run is going',
              '--mode=block',
              'tail',
              '--pid=4242',
              '-f',
              '/dev/null',
            ],
          ],
        ])
        // The run's end ended its tree.
        const [held] = inhibitors.running
        expect(held).toBeDefined()
        if (held !== undefined) yield* held.exit
        expect(
          ofKind(events, 'warn').filter(
            warn => warn.detail === 'KEEP_AWAKE_FAILED',
          ),
        ).toEqual([])
      }),
  )

  it.effect("starts nothing when the engine's keep_awake is false", () =>
    Effect.gen(function* () {
      const fixture = project()
      const inhibitors = newInhibitors()
      const base = configOf(fixture, options())
      yield* runWith({
        fixture,
        inhibitors,
        config: {
          settings: { ...base.settings, engineSettings: { keep_awake: false } },
        },
      })
      expect(inhibitors.asked).toEqual([])
    }),
  )

  it.effect(
    "says so in the log when the inhibitor doesn't start, and the run goes on",
    () =>
      Effect.gen(function* () {
        const events = yield* runWith({
          fixture: project(),
          inhibitors: newInhibitors(),
          fails: StartFailure.SpawnFailed({
            command: 'systemd-inhibit',
            message: 'spawn EACCES',
          }),
        })
        expect(
          ofKind(events, 'warn')
            .filter(warn => warn.detail === 'KEEP_AWAKE_FAILED')
            .map(warn => warn.text),
        ).toEqual([
          "KEEP_AWAKE_FAILED: systemd-inhibit didn't start (spawn EACCES); the host may idle-sleep",
        ])
      }),
  )
})

describe('watching the battery during a run', () => {
  it.effect(
    'records that a closed lid sleeps the host, and the charge on battery, after the start',
    () =>
      Effect.gen(function* () {
        const events = yield* runWith({
          fixture: project(),
          inhibitors: newInhibitors(),
          power: battery(Power.Battery({ level: 15, discharging: true })),
        })
        const start = events.findIndex(event => event.kind === 'start')
        const lid = events.findIndex(
          event => event.kind === 'warn' && event.detail === 'LID_SLEEPS',
        )
        expect(start).toBeGreaterThanOrEqual(0)
        expect(lid).toBeGreaterThan(start)
        expect(
          ofKind(events, 'battery').map(({ level, threshold }) => ({
            level,
            threshold,
          })),
        ).toEqual([
          { level: 15, threshold: undefined },
          { level: 15, threshold: 20 },
        ])
      }),
  )

  it.effect('records nothing of a host without a battery', () =>
    Effect.gen(function* () {
      const events = yield* runWith({
        fixture: project(),
        inhibitors: newInhibitors(),
        power: battery(Power.NoBattery()),
      })
      expect(ofKind(events, 'battery')).toEqual([])
      expect(
        ofKind(events, 'warn').filter(warn => warn.detail === 'LID_SLEEPS'),
      ).toEqual([])
    }),
  )
})
