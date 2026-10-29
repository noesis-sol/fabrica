import {
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Scope,
  Stream,
} from 'effect'
import { TestClock } from 'effect/testing'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import { RunId } from '@fabrica/contracts'

import { type ByteSink, makeLineStream } from '../src/files'
import {
  type Command,
  CommandOutcome,
  ExitStatus,
  ProcessRunner,
  type Running,
  type StartCommand,
  StartFailed,
  StartFailure,
} from '../src/process'
import {
  RunLog,
  batteryDraft,
  eventsPath,
  logPath,
  makeRunLog,
  recordBattery,
} from '../src/runlog'
import {
  Battery,
  BatteryNotice,
  KeptAwake,
  Power,
  batteryBanner,
  batteryFor,
  batteryNotifies,
  inhibitorFor,
  keepAwake,
  parsePmsetBatt,
  parsePowerSupplies,
  pmsetBattery,
  reachedThreshold,
  sysfsBattery,
  watchBattery,
} from '../src/time'

// Keeping the host awake and watching its battery (spec §7.7, H67), with the commands stubbed at
// the process boundary: a runner that records what it is asked to start and run, answers
// `pmset -g batt` with the output a test gives it, and records each inhibitor's end.

const enginePid = 4242

/** What the stub runner was asked, and the answers it gives. */
interface Stub {
  readonly started: Array<StartCommand>
  readonly ended: Array<number>
  readonly ran: Array<Command>
  /** `pmset -g batt`'s output for the next runs: the last is given again once the others are. */
  readonly batt: Array<string>
}

const stubRunner = (options: {
  readonly stub: Stub
  /** Why `start` fails, where it does. */
  readonly startFails?: StartFailure
}): Layer.Layer<ProcessRunner> =>
  Layer.succeed(
    ProcessRunner,
    ProcessRunner.of({
      run: command =>
        Effect.sync(() => {
          options.stub.ran.push(command)
          const stdout =
            options.stub.batt.length > 1
              ? (options.stub.batt.shift() ?? '')
              : (options.stub.batt[0] ?? '')
          return CommandOutcome.Exited({
            status: ExitStatus.Code({ code: 0 }),
            stdout,
            stderr: '',
          })
        }),
      start: command =>
        Effect.gen(function* () {
          if (options.startFails !== undefined) {
            return yield* new StartFailed({ reason: options.startFails })
          }
          const pid = 5000 + options.stub.started.length
          options.stub.started.push(command)
          const exited = yield* Deferred.make<ExitStatus>()
          const end = Effect.sync(() => {
            options.stub.ended.push(pid)
          })
          yield* Effect.addFinalizer(() => end)
          const running: Running = {
            pid,
            stdout: Stream.empty,
            stderr: Stream.empty,
            write: () => Effect.void,
            closeStdin: Effect.void,
            exit: Deferred.await(exited),
            end,
          }
          return running
        }),
    }),
  )

const newStub = (batt: ReadonlyArray<string> = []): Stub => ({
  started: [],
  ended: [],
  ran: [],
  batt: [...batt],
})

const batt = (level: number, drawing: 'Battery Power' | 'AC Power') =>
  `Now drawing from '${drawing}'\n -InternalBattery-0 (id=37224547)\t${level}%; ${
    drawing === 'Battery Power' ? 'discharging; 3:12 remaining' : 'charging'
  } present: true\n`

const desktopBatt = "Now drawing from 'AC Power'\n"

/** A temporary folder for one test, removed when the test ends. */
const scratch = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), 'fabrica-battery-'))),
  folder => Effect.promise(() => rm(folder, { recursive: true, force: true })),
)

/** A minute of the test's clock, and the fibers it wakes run. */
const minute = Effect.andThen(TestClock.adjust('1 minute'), Effect.yieldNow)

const mac = { platform: 'darwin', pid: enginePid } as const
const linux = { platform: 'linux', pid: enginePid } as const

describe('keeping the host awake', () => {
  it.effect('holds caffeinate on macOS for as long as the run goes', () =>
    Effect.gen(function* () {
      const stub = newStub()
      const scope = yield* Scope.make()
      const kept = yield* keepAwake({
        keepAwake: true,
        overnight: false,
        host: mac,
      }).pipe(Scope.provide(scope), Effect.provide(stubRunner({ stub })))
      expect(kept).toEqual(
        KeptAwake.Holding({ command: '/usr/bin/caffeinate', pid: 5000 }),
      )
      expect(stub.started).toEqual([
        {
          command: '/usr/bin/caffeinate',
          args: ['-i', '-w', String(enginePid)],
          cwd: '/',
          stdin: 'null',
        },
      ])
      expect(stub.ended).toEqual([])
      yield* Scope.close(scope, Exit.void)
      expect(stub.ended).toEqual([5000])
    }),
  )

  it.effect('holds an idle lock on Linux that ends with the engine', () =>
    Effect.gen(function* () {
      const stub = newStub()
      const kept = yield* Effect.scoped(
        keepAwake({ keepAwake: true, overnight: false, host: linux }),
      ).pipe(Effect.provide(stubRunner({ stub })))
      expect(KeptAwake.$is('Holding')(kept)).toBe(true)
      expect(stub.started.map(command => command.command)).toEqual([
        'systemd-inhibit',
      ])
      const args = stub.started[0]?.args ?? []
      expect(args).toContain('--what=idle')
      expect(args.slice(-4)).toEqual([
        'tail',
        `--pid=${enginePid}`,
        '-f',
        '/dev/null',
      ])
      expect(stub.ended).toEqual([5000])
    }),
  )

  it.effect('starts nothing where keep_awake is false', () =>
    Effect.gen(function* () {
      const stub = newStub()
      const kept = yield* Effect.scoped(
        keepAwake({ keepAwake: false, overnight: false, host: mac }),
      ).pipe(Effect.provide(stubRunner({ stub })))
      expect(kept).toEqual(KeptAwake.NotAsked())
      expect(stub.started).toEqual([])
    }),
  )

  it.effect('keeps an overnight run awake whatever keep_awake says', () =>
    Effect.gen(function* () {
      const stub = newStub()
      const kept = yield* Effect.scoped(
        keepAwake({ keepAwake: false, overnight: true, host: mac }),
      ).pipe(Effect.provide(stubRunner({ stub })))
      expect(KeptAwake.$is('Holding')(kept)).toBe(true)
      expect(stub.started).toHaveLength(1)
      expect(stub.ended).toEqual([5000])
    }),
  )

  it.effect('does nothing where there is no sleep to prevent', () =>
    Effect.gen(function* () {
      const stub = newStub()
      const elsewhere = yield* Effect.scoped(
        keepAwake({
          keepAwake: true,
          overnight: false,
          host: { platform: 'freebsd', pid: enginePid },
        }),
      ).pipe(Effect.provide(stubRunner({ stub })))
      expect(elsewhere).toEqual(KeptAwake.NothingToPrevent())
      expect(stub.started).toEqual([])
      expect(inhibitorFor({ platform: 'win32', pid: 1 })).toEqual(Option.none())
      const noSystemd = yield* Effect.scoped(
        keepAwake({ keepAwake: true, overnight: false, host: linux }),
      ).pipe(
        Effect.provide(
          stubRunner({
            stub,
            startFails: StartFailure.NotOnPath({
              command: 'systemd-inhibit',
              path: '/usr/bin:/bin',
            }),
          }),
        ),
      )
      expect(noSystemd).toEqual(KeptAwake.NothingToPrevent())
    }),
  )

  it.effect('says when the inhibitor would not start', () =>
    Effect.gen(function* () {
      const kept = yield* Effect.scoped(
        keepAwake({ keepAwake: true, overnight: false, host: mac }),
      ).pipe(
        Effect.provide(
          stubRunner({
            stub: newStub(),
            startFails: StartFailure.SpawnFailed({
              command: '/usr/bin/caffeinate',
              message: 'EACCES',
            }),
          }),
        ),
      )
      expect(kept).toEqual(
        KeptAwake.Failed({ command: '/usr/bin/caffeinate', reason: 'EACCES' }),
      )
    }),
  )
})

describe('reading the battery', () => {
  it('reads pmset -g batt', () => {
    expect(parsePmsetBatt(batt(85, 'Battery Power'))).toEqual(
      Option.some(Power.Battery({ level: 85, discharging: true })),
    )
    expect(parsePmsetBatt(batt(100, 'AC Power'))).toEqual(
      Option.some(Power.Battery({ level: 100, discharging: false })),
    )
    expect(parsePmsetBatt(desktopBatt)).toEqual(Option.some(Power.NoBattery()))
    expect(parsePmsetBatt('')).toEqual(Option.none())
  })

  it('reads the kernel power supplies, a mouse’s battery left out', () => {
    const supply = (fields: {
      readonly type: string
      readonly capacity?: string
      readonly status?: string
      readonly scope?: string
    }) => ({
      type: Option.some(fields.type),
      scope: Option.fromUndefinedOr(fields.scope),
      capacity: Option.fromUndefinedOr(fields.capacity),
      status: Option.fromUndefinedOr(fields.status),
    })
    expect(
      parsePowerSupplies([
        supply({ type: 'Mains' }),
        supply({ type: 'Battery', capacity: '40', status: 'Discharging' }),
        supply({ type: 'Battery', capacity: '60', status: 'Unknown' }),
        supply({
          type: 'Battery',
          capacity: '5',
          status: 'Discharging',
          scope: 'Device',
        }),
      ]),
    ).toEqual(Power.Battery({ level: 50, discharging: true }))
    expect(parsePowerSupplies([supply({ type: 'Mains' })])).toEqual(
      Power.NoBattery(),
    )
    expect(parsePowerSupplies([])).toEqual(Power.NoBattery())
  })

  it.effect('reads the kernel’s folder, none where it is missing', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* scratch
        const bat0 = join(root, 'BAT0')
        const ac = join(root, 'AC')
        yield* Effect.promise(async () => {
          await mkdir(bat0)
          await mkdir(ac)
          await writeFile(join(bat0, 'type'), 'Battery\n')
          await writeFile(join(bat0, 'capacity'), '17\n')
          await writeFile(join(bat0, 'status'), 'Discharging\n')
          await writeFile(join(ac, 'type'), 'Mains\n')
        })
        const read = Effect.gen(function* () {
          return yield* (yield* Battery).read
        })
        expect(yield* Effect.provide(read, sysfsBattery(root))).toEqual(
          Option.some(Power.Battery({ level: 17, discharging: true })),
        )
        expect(
          yield* Effect.provide(read, sysfsBattery(join(root, 'missing'))),
        ).toEqual(Option.some(Power.NoBattery()))
      }),
    ),
  )

  it.effect('reads pmset on macOS through the runner, and none elsewhere', () =>
    Effect.gen(function* () {
      const stub = newStub([batt(64, 'Battery Power')])
      const read = Effect.gen(function* () {
        return yield* (yield* Battery).read
      })
      const power = yield* read.pipe(
        Effect.provide(batteryFor('darwin')),
        Effect.provide(stubRunner({ stub })),
      )
      expect(power).toEqual(
        Option.some(Power.Battery({ level: 64, discharging: true })),
      )
      expect(stub.ran.map(({ command, args }) => [command, ...args])).toEqual([
        ['/usr/bin/pmset', '-g', 'batt'],
      ])
      expect(
        yield* read.pipe(
          Effect.provide(batteryFor('win32')),
          Effect.provide(stubRunner({ stub })),
        ),
      ).toEqual(Option.some(Power.NoBattery()))
    }),
  )
})

describe('watching the battery', () => {
  /** Watches the battery `pmset -g batt` gives as `outputs`, collecting what the run is told. */
  const watch = (outputs: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const stub = newStub(outputs)
      const told: Array<BatteryNotice> = []
      const first = yield* watchBattery(notice =>
        Effect.sync(() => {
          told.push(notice)
        }),
      ).pipe(Effect.provide(pmsetBattery), Effect.provide(stubRunner({ stub })))
      return { stub, told, first }
    })

  it.effect(
    'warns at 20% and at 10% while discharging, read once a minute',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { stub, told, first } = yield* watch([
            batt(25, 'Battery Power'),
            batt(21, 'Battery Power'),
            batt(20, 'Battery Power'),
            batt(15, 'Battery Power'),
            batt(10, 'Battery Power'),
            batt(9, 'Battery Power'),
          ])
          expect(first).toEqual(
            Option.some(Power.Battery({ level: 25, discharging: true })),
          )
          expect(told).toEqual([
            BatteryNotice.LidSleeps(),
            BatteryNotice.OnBattery({ level: 25 }),
          ])
          yield* TestClock.adjust('59 seconds')
          expect(stub.ran).toHaveLength(1)
          yield* minute
          expect(stub.ran).toHaveLength(2)
          expect(told).toHaveLength(2)
          yield* minute
          expect(told.slice(2)).toEqual([
            BatteryNotice.Low({ level: 20, threshold: 20 }),
          ])
          yield* minute
          expect(told).toHaveLength(3)
          yield* minute
          const ten = BatteryNotice.Low({ level: 10, threshold: 10 })
          expect(told.slice(3)).toEqual([ten])
          expect(batteryNotifies(ten)).toBe(true)
          expect(batteryNotifies(told[2] ?? ten)).toBe(false)
          yield* minute
          yield* minute
          expect(told).toHaveLength(4)
          expect(stub.ran).toHaveLength(7)
        }),
      ),
  )

  it.effect('stops reading as the run’s scope closes', () =>
    Effect.gen(function* () {
      const { stub } = yield* Effect.scoped(watch([batt(80, 'Battery Power')]))
      yield* minute
      yield* minute
      expect(stub.ran).toHaveLength(1)
    }),
  )

  it.effect('says nothing of a host without a battery', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { told, first } = yield* watch([desktopBatt])
        yield* minute
        expect(first).toEqual(Option.some(Power.NoBattery()))
        expect(told).toEqual([])
      }),
    ),
  )

  it.effect('says only the closed lid on a laptop plugged in', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { told } = yield* watch([
          batt(30, 'AC Power'),
          batt(15, 'AC Power'),
        ])
        yield* minute
        yield* minute
        expect(told).toEqual([BatteryNotice.LidSleeps()])
      }),
    ),
  )

  it.effect('warns again once the battery has charged above a threshold', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { told } = yield* watch([
          batt(30, 'Battery Power'),
          batt(19, 'Battery Power'),
          batt(19, 'AC Power'),
          batt(19, 'Battery Power'),
          batt(25, 'AC Power'),
          batt(20, 'Battery Power'),
        ])
        for (let i = 0; i < 5; i += 1) yield* minute
        expect(told.slice(2)).toEqual([
          BatteryNotice.Low({ level: 19, threshold: 20 }),
          BatteryNotice.Low({ level: 20, threshold: 20 }),
        ])
      }),
    ),
  )

  it.effect('says the lowest of the thresholds it passes at once', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { told } = yield* watch([
          batt(8, 'Battery Power'),
          batt(5, 'Battery Power'),
        ])
        yield* minute
        expect(told).toEqual([
          BatteryNotice.LidSleeps(),
          BatteryNotice.OnBattery({ level: 8 }),
          BatteryNotice.Low({ level: 8, threshold: 10 }),
        ])
        expect(
          reachedThreshold(
            Power.Battery({ level: 3, discharging: true }),
            new Set([20, 10]),
          ).notice,
        ).toEqual(Option.none())
      }),
    ),
  )

  it.effect('goes on where the battery can’t be read', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { told, first } = yield* watch(['', batt(20, 'Battery Power')])
        expect(first).toEqual(Option.none())
        expect(told).toEqual([])
        yield* minute
        expect(told).toEqual([BatteryNotice.Low({ level: 20, threshold: 20 })])
      }),
    ),
  )

  it('gives a banner for being on battery and for each warning', () => {
    expect(batteryBanner(BatteryNotice.LidSleeps())).toEqual(Option.none())
    expect(
      Option.map(
        batteryBanner(BatteryNotice.Low({ level: 9, threshold: 10 })),
        banner => [banner.tone, banner.text],
      ),
    ).toEqual(Option.some(['warning', 'Battery at 9% and discharging']))
    expect(
      Option.map(
        batteryBanner(BatteryNotice.OnBattery({ level: 70 })),
        banner => banner.text,
      ),
    ).toEqual(Option.some('On battery at 70%'))
  })
})

describe('the battery in the run log', () => {
  const run = RunId.make('2026-10-29T14:00:00.000+02:00')

  /** A sink keeping every byte written to it. */
  const keepingSink = () => {
    const held: Array<Uint8Array> = []
    const sink: ByteSink = {
      write: bytes =>
        Effect.sync(() => {
          held.push(bytes)
          return bytes.length
        }),
    }
    return { sink, text: () => Buffer.concat(held).toString('utf8') }
  }

  it('makes a warn record of the closed lid and battery records of the rest', () => {
    expect(batteryDraft(BatteryNotice.LidSleeps())).toEqual({
      kind: 'warn',
      detail: 'LID_SLEEPS',
      text: 'LID_SLEEPS: keeping awake prevents idle sleep only: a closed lid still sleeps this host on battery or without an external display',
    })
    expect(batteryDraft(BatteryNotice.OnBattery({ level: 85 }))).toEqual({
      kind: 'battery',
      level: 85,
      text: 'BATTERY: on battery at 85%',
    })
    expect(
      batteryDraft(BatteryNotice.Low({ level: 10, threshold: 10 })),
    ).toEqual({
      kind: 'battery',
      level: 10,
      threshold: 10,
      text: 'BATTERY: 10% and discharging; plug the host in before it sleeps',
    })
  })

  it.effect('writes the start’s records and each warning’s', () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 9, 29, 12, 0, 0))
        const events = keepingSink()
        const log = keepingSink()
        const runLog = yield* makeRunLog({
          run,
          events: yield* makeLineStream({
            path: eventsPath,
            sink: events.sink,
            endsWithNewline: true,
          }),
          log: yield* makeLineStream({
            path: logPath,
            sink: log.sink,
            endsWithNewline: true,
          }),
        })
        const stub = newStub([
          batt(21, 'Battery Power'),
          batt(20, 'Battery Power'),
        ])
        yield* recordBattery.pipe(
          Effect.provideService(RunLog, runLog),
          Effect.provide(pmsetBattery),
          Effect.provide(stubRunner({ stub })),
        )
        yield* minute
        const records = events
          .text()
          .trim()
          .split('\n')
          .map(line => JSON.parse(line))
        expect(
          records.map(record => [record.kind, record.level, record.threshold]),
        ).toEqual([
          ['warn', undefined, undefined],
          ['battery', 21, undefined],
          ['battery', 20, 20],
        ])
        expect(log.text()).toContain(
          '2026-10-29 14:00:00 +0200 BATTERY: on battery at 21%',
        )
      }),
    ).pipe(Effect.provide(DateTime.layerCurrentZoneOffset(2 * 60 * 60 * 1000))),
  )
})
