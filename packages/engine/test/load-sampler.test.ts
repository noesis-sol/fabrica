import {
  DateTime,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Stream,
} from 'effect'
import { TestClock } from 'effect/testing'

import { describe, expect, it } from '@effect/vitest'
import {
  Host,
  HostFacts,
  type HostLoad,
  type HostLoadItem,
  ProjectId,
  Resume,
  RunId,
  StreamEpoch,
  TicketId,
} from '@fabrica/contracts'

import {
  type CoreTimes,
  type KernelReading,
  LOAD_INTERVAL,
  LoadProcesses,
  LoadReads,
  LoadSampler,
  SampledTree,
  busyCoresOf,
  firstMemo,
  layerLoadSampler,
  parseDarwinKernel,
  parseLinuxKernel,
  sampleOf,
} from '../src/engine/load'
import {
  type ProcessMemoryRow,
  parseProcessMemoryTable,
} from '../src/process/tree'
import { Telemetry, type TelemetryRow } from '../src/telemetry'

// The host's load (spec §7.4, §18.3): sampled every few seconds, from the kernel's own figures on macOS
// and Linux and one process listing: each worker's process tree and the merge check's memory, served on
// the engine's load stream, a snapshot then each sample, and recorded. Every host fact is injected.

const project = ProjectId.make('prj-load')
const run = RunId.make('run-load')
const ticket = TicketId.make('fa-a1')
const other = TicketId.make('fa-a2')

const GIB = 1024 ** 3

/** The host's facts: 4 cores, 8 GiB, and `load`. */
const facts = (load = 0) =>
  new HostFacts({
    cores: 4,
    memoryBytes: 8 * GIB,
    load,
    home: '/nonexistent/fabrica-test-home',
  })

const kernel = (overrides: Partial<KernelReading> = {}): KernelReading => ({
  availableBytes: 6 * GIB,
  pressure: 'normal',
  pressurePercent: Option.none(),
  swapUsedBytes: Option.none(),
  swaps: Option.none(),
  ...overrides,
})

const row = (
  pid: number,
  ppid: number,
  pgid: number,
  rssBytes: number,
): ProcessMemoryRow => ({ pid, ppid, pgid, zombie: false, rssBytes })

describe('macOS figures', () => {
  const vmstat = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                                   100.',
    'Pages inactive:                               200.',
    'Pages speculative:                             30.',
    'Pages purgeable:                                4.',
    'Swapins:                                      500.',
    'Swapouts:                                      70.',
  ].join('\n')

  it('reads the pressure, the swap and what could be given', () => {
    expect(
      parseDarwinKernel({
        sysctl:
          '2\n82\ntotal = 4096.00M  used = 2428.50M  free = 1667.50M  (encrypted)\n',
        vmstat,
        free: 1,
      }),
    ).toEqual({
      availableBytes: 334 * 16384,
      pressure: 'warn',
      pressurePercent: Option.some(18),
      swapUsedBytes: Option.some(Math.round(2428.5 * 1024 ** 2)),
      swaps: Option.some(570),
    })
  })

  it.each([
    ['1', 'normal'],
    ['2', 'warn'],
    ['4', 'critical'],
  ])('level %s is %s', (level, pressure) => {
    expect(
      parseDarwinKernel({ sysctl: `${level}\n`, vmstat: '', free: 1 }).pressure,
    ).toBe(pressure)
  })

  it('falls back where nothing can be read', () => {
    expect(parseDarwinKernel({ sysctl: '', vmstat: '', free: 9 })).toEqual(
      kernel({ availableBytes: 9 }),
    )
  })
})

describe('Linux figures', () => {
  const meminfo = [
    'MemTotal:       1000 kB',
    'MemAvailable:    400 kB',
    'SwapTotal:       100 kB',
    'SwapFree:         75 kB',
  ].join('\n')
  const psi = (some: number, full: number) =>
    `some avg10=${some.toFixed(2)} avg60=0.00 avg300=0.00 total=1\nfull avg10=${full.toFixed(2)} avg60=0.00 avg300=0.00 total=1\n`

  it('reads the stalls, the swap and what is available', () => {
    expect(
      parseLinuxKernel({
        pressure: psi(1.5, 0),
        meminfo,
        vmstat: 'pgfault 9\npswpin 12\npswpout 30\n',
        free: 1,
      }),
    ).toEqual({
      availableBytes: 400 * 1024,
      pressure: 'normal',
      pressurePercent: Option.some(1.5),
      swapUsedBytes: Option.some(25 * 1024),
      swaps: Option.some(42),
    })
  })

  it.each([
    [0, 0, 'normal'],
    [10, 0, 'warn'],
    [40, 10, 'critical'],
  ])('stalls of %d and %d are %s', (some, full, pressure) => {
    expect(
      parseLinuxKernel({
        pressure: psi(some, full),
        meminfo: '',
        vmstat: '',
        free: 1,
      }).pressure,
    ).toBe(pressure)
  })

  it.each([
    [400, 'normal'],
    [80, 'warn'],
    [40, 'critical'],
  ])(
    'with no stall information, %d of 1000 kB available is %s',
    (available, pressure) => {
      expect(
        parseLinuxKernel({
          pressure: '',
          meminfo: `MemTotal: 1000 kB\nMemAvailable: ${available} kB\n`,
          vmstat: '',
          free: 1,
        }).pressure,
      ).toBe(pressure)
    },
  )

  it('takes what Node says where /proc says nothing', () => {
    expect(
      parseLinuxKernel({ pressure: '', meminfo: '', vmstat: '', free: 9 }),
    ).toEqual(kernel({ availableBytes: 9 }))
  })
})

describe('the process listing', () => {
  it('reads each process with its memory, skipping what it cannot read', () => {
    expect(
      parseProcessMemoryTable(
        '  10     1    10 S+     2048\nnot a line\n  11    10    10 Z        0\n',
      ),
    ).toEqual([
      { pid: 10, ppid: 1, pgid: 10, zombie: false, rssBytes: 2048 * 1024 },
      { pid: 11, ppid: 10, pgid: 10, zombie: true, rssBytes: 0 },
    ])
  })
})

describe('a sample', () => {
  const made = (input: Partial<Parameters<typeof sampleOf>[0]> = {}) =>
    sampleOf({
      at: 60_000,
      facts: facts(1.5),
      kernel: kernel(),
      cores: [],
      measured: [],
      memo: firstMemo,
      ...input,
    })

  it('says the memory used and total, and the load against the cores', () => {
    const { load } = made({ kernel: kernel({ pressure: 'critical' }) })
    expect(load.memory).toEqual({
      used: 2 * GIB,
      total: 8 * GIB,
      pressure: 'critical',
    })
    expect(load.load1).toBe(1.5)
    expect(load.cores).toBe(4)
    expect(load.mergeCheck).toEqual(Option.none())
  })

  it('never says less than none used', () => {
    expect(
      made({ kernel: kernel({ availableBytes: 9 * GIB }) }).load.memory.used,
    ).toBe(0)
  })

  it('sums a ticket and the merge checks, tree by tree', () => {
    const { load } = made({
      measured: [
        {
          tree: SampledTree.Worker({ project, run, ticket, pid: 1 }),
          bytes: 100,
        },
        {
          tree: SampledTree.Worker({ project, run, ticket, pid: 2 }),
          bytes: 50,
        },
        {
          tree: SampledTree.Worker({ project, run, ticket: other, pid: 3 }),
          bytes: 7,
        },
        { tree: SampledTree.MergeCheck({ project, run, pid: 4 }), bytes: 30 },
        { tree: SampledTree.MergeCheck({ project, run, pid: 5 }), bytes: 2 },
      ],
    })
    expect(
      load.workers.map(worker => [worker.project, worker.ticket, worker.bytes]),
    ).toEqual([
      [project, ticket, 150],
      [project, other, 7],
    ])
    expect(load.mergeCheck).toEqual(Option.some(32))
  })

  it('counts a core busy when most of its time since the last read was', () => {
    const before: ReadonlyArray<CoreTimes> = [
      { busy: 0, idle: 0 },
      { busy: 0, idle: 0 },
      { busy: 5, idle: 5 },
    ]
    const now: ReadonlyArray<CoreTimes> = [
      { busy: 60, idle: 40 },
      { busy: 10, idle: 90 },
      { busy: 5, idle: 5 },
    ]
    expect(busyCoresOf(before, now)).toBe(1)
    expect(busyCoresOf([], now)).toBe(0)
  })

  it('says swapping from the rate since the last sample', () => {
    const first = made({ kernel: kernel({ swaps: Option.some(1000) }) })
    expect(first.load.swapping).toBe(false)
    const rate = (swaps: number) =>
      made({
        at: 120_000,
        kernel: kernel({ swaps: Option.some(swaps) }),
        memo: first.memo,
      }).load.swapping
    expect(rate(1599)).toBe(false)
    expect(rate(1600)).toBe(true)
  })
})

describe('the sampler', () => {
  const rows = (listing: ReadonlyArray<ProcessMemoryRow>) => listing

  /** A sampler on injected reads: `listing`, and telemetry kept in `recorded`. */
  const sampling = (input: {
    readonly listing: Ref.Ref<Option.Option<ReadonlyArray<ProcessMemoryRow>>>
    readonly recorded: Ref.Ref<ReadonlyArray<TelemetryRow>>
  }) =>
    layerLoadSampler.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Host, Host.of({ facts: Effect.succeed(facts()) })),
          Layer.succeed(
            LoadReads,
            LoadReads.of({
              kernel: Effect.succeed(
                kernel({
                  pressurePercent: Option.some(18),
                  swapUsedBytes: Option.some(5),
                }),
              ),
              processes: Ref.get(input.listing),
              cores: Effect.succeed([]),
            }),
          ),
          Layer.succeed(
            Telemetry,
            Telemetry.of({
              record: row => Ref.update(input.recorded, all => [...all, row]),
              flush: Effect.void,
            }),
          ),
        ),
      ),
    )

  const setUp = Effect.gen(function* () {
    const listing = yield* Ref.make(
      Option.some<ReadonlyArray<ProcessMemoryRow>>([]),
    )
    const recorded = yield* Ref.make<ReadonlyArray<TelemetryRow>>([])
    return { listing, recorded, layer: sampling({ listing, recorded }) }
  })

  /** The items of the load stream, as they come. */
  const watching = (resume: Option.Option<Resume> = Option.none()) =>
    Effect.gen(function* () {
      const items = yield* Queue.unbounded<HostLoadItem>()
      const sampler = yield* LoadSampler
      const fiber = yield* sampler.watch(resume).pipe(
        Stream.runForEach(item => Queue.offer(items, item)),
        Effect.forkScoped,
      )
      return { items, fiber }
    })

  const next = Effect.andThen(TestClock.adjust(LOAD_INTERVAL), Effect.yieldNow)

  const valueOf = (item: HostLoadItem): HostLoad => item.value

  it.effect('sends a snapshot, then each sample as a patch', () =>
    Effect.gen(function* () {
      const { layer } = yield* setUp
      yield* Effect.gen(function* () {
        const { items } = yield* watching()
        const first = yield* Queue.take(items)
        expect(first._tag).toBe('snapshot')
        expect(first.seq).toBe(0)
        expect(valueOf(first).cores).toBe(4)
        expect(DateTime.toEpochMillis(valueOf(first).sampledAt)).toBe(0)

        yield* next
        const second = yield* Queue.take(items)
        expect(second._tag).toBe('patch')
        expect(second.seq).toBe(1)
        expect(DateTime.toEpochMillis(valueOf(second).sampledAt)).toBe(3000)
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.scoped),
  )

  it.effect('sends a new subscriber a snapshot of the latest sample', () =>
    Effect.gen(function* () {
      const { layer } = yield* setUp
      yield* Effect.gen(function* () {
        const sampler = yield* LoadSampler
        yield* Effect.yieldNow
        yield* next
        yield* next
        const { items } = yield* watching()
        const first = yield* Queue.take(items)
        expect(first._tag).toBe('snapshot')
        expect(first.seq).toBe(2)
        expect(Option.isSome(yield* sampler.latest)).toBe(true)
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.scoped),
  )

  it.effect(
    'sends a client at the latest sample only what comes, and any other a snapshot',
    () =>
      Effect.gen(function* () {
        const { layer } = yield* setUp
        yield* Effect.gen(function* () {
          const first = yield* watching()
          const snapshot = yield* Queue.take(first.items)
          if (snapshot._tag !== 'snapshot') throw new Error('not a snapshot')
          yield* Fiber.interrupt(first.fiber)

          const current = yield* watching(
            Option.some(new Resume({ epoch: snapshot.epoch, after: 0 })),
          )
          const elsewhere = yield* watching(
            Option.some(
              new Resume({ epoch: StreamEpoch.make('another'), after: 0 }),
            ),
          )
          expect((yield* Queue.take(elsewhere.items))._tag).toBe('snapshot')
          yield* Effect.yieldNow
          expect(yield* Queue.size(current.items)).toBe(0)

          yield* next
          const item = yield* Queue.take(current.items)
          expect(item._tag).toBe('patch')
          expect(item.seq).toBe(1)
        }).pipe(Effect.provide(layer))
      }).pipe(Effect.scoped),
  )

  it.effect(
    'measures what the runs track until it has gone, and records it',
    () =>
      Effect.gen(function* () {
        const { layer, listing, recorded } = yield* setUp
        yield* Effect.gen(function* () {
          const { items } = yield* watching()
          const processes = yield* LoadProcesses
          yield* Queue.take(items)

          yield* processes.track(
            SampledTree.Worker({ project, run, ticket, pid: 10 }),
          )
          yield* processes.track(
            SampledTree.MergeCheck({ project, run, pid: 20 }),
          )
          yield* Ref.set(
            listing,
            Option.some(
              rows([
                // The agent, what it started, and what its group holds, its parent gone.
                row(10, 1, 10, 100),
                row(11, 10, 11, 20),
                row(12, 1, 10, 3),
                row(20, 1, 20, 40),
                // Nobody's.
                row(30, 1, 30, 900),
              ]),
            ),
          )
          yield* next
          const load = valueOf(yield* Queue.take(items))
          expect(
            load.workers.map(({ ticket, bytes }) => [ticket, bytes]),
          ).toEqual([[ticket, 123]])
          expect(load.mergeCheck).toEqual(Option.some(40))
          expect(
            (yield* Ref.get(recorded)).filter(
              row => row._tag === 'ProcessSample',
            ),
          ).toMatchObject([
            { project, run, ticket, process: 'worker', rssBytes: 123 },
            { project, run, process: 'check', rssBytes: 40 },
          ])

          // A listing that can't be had says nothing of them.
          yield* Ref.set(listing, Option.none())
          yield* next
          expect(valueOf(yield* Queue.take(items)).workers).toEqual([])

          // Gone from one that can: not looked for again, should its PID come back.
          yield* Ref.set(listing, Option.some([]))
          yield* next
          yield* Queue.take(items)
          yield* Ref.set(listing, Option.some([row(10, 1, 10, 100)]))
          yield* next
          const later = valueOf(yield* Queue.take(items))
          expect(later.workers).toEqual([])
          expect(later.mergeCheck).toEqual(Option.none())
        }).pipe(Effect.provide(layer))
      }).pipe(Effect.scoped),
  )

  it.effect('records each sample of the host', () =>
    Effect.gen(function* () {
      const { layer, recorded } = yield* setUp
      yield* Effect.gen(function* () {
        const { items } = yield* watching()
        yield* Queue.take(items)
        yield* Effect.yieldNow
        expect(
          (yield* Ref.get(recorded)).filter(row => row._tag === 'HostSample'),
        ).toMatchObject([
          { load: 0, cores: 4, memoryPressure: 18, swapUsedBytes: 5 },
        ])
      }).pipe(Effect.provide(layer))
    }).pipe(Effect.scoped),
  )
})
