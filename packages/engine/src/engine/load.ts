import {
  Clock,
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Stream,
  SubscriptionRef,
} from 'effect'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import * as NodeOs from 'node:os'

import {
  Host,
  type HostFacts,
  HostLoad,
  HostLoadItem,
  type MemoryPressure,
  type ProjectId,
  type Resume,
  ResumePlan,
  type RunId,
  StreamEpoch,
  type TicketId,
  WorkerMemory,
  planResume,
} from '@fabrica/contracts'

import {
  type ProcessMemoryRow,
  listProcessMemory,
  treeOf,
} from '../process/tree'
import { Telemetry, TelemetryRow } from '../telemetry'
import { drawBase36 } from '../workgraph/ids'

// The host's load (spec §7.4, §18.3, §21, orchestra-recj, -556h): sampled every few seconds, from one
// process listing and the kernel's own figures: each worker's process tree and the merge check's memory,
// the kernel's memory pressure (macOS) or pressure-stall information (Linux), swapping, and the 1-minute
// load against the cores. Each sample goes to the engine's load stream, for the console's system stats,
// and to telemetry. Memory used against the total says little on macOS, which keeps spare memory full of
// cache: the pressure level and the swap rate do. What it reads of its host comes through `LoadReads`
// and `Host`, so a test injects them (H55).

/** How often the host is sampled. */
export const LOAD_INTERVAL = Duration.seconds(3)

/** The pages swapped in and out a minute at which swapping is under way (tutti's). */
const SWAPPING_PER_MINUTE = 600
/** The share of the last 10 seconds, in percent, some task (warn) or every task (critical) stalled on memory. */
const STALL_WARN = 10
const STALL_CRITICAL = 10
/** Where a kernel has no pressure-stall information, the share of memory available under which it warns or is critical. */
const AVAILABLE_WARN = 0.1
const AVAILABLE_CRITICAL = 0.05
/** The share of its time a core has to be busy to count as busy. */
const BUSY_CORE = 0.5

/** What the kernel says of the host's memory. */
export interface KernelReading {
  /** What programs could be given now without pressing the others, in bytes. */
  readonly availableBytes: number
  readonly pressure: MemoryPressure
  /** Memory pressure, 0 to 100, where the host reports it. */
  readonly pressurePercent: Option.Option<number>
  readonly swapUsedBytes: Option.Option<number>
  /** Pages swapped in and out since the host started. */
  readonly swaps: Option.Option<number>
}

/** A core's time since the host started, in any one unit. */
export interface CoreTimes {
  readonly busy: number
  readonly idle: number
}

/** The reads of the host a sample is made from, beside `Host`'s facts. */
export class LoadReads extends Context.Service<
  LoadReads,
  {
    readonly kernel: Effect.Effect<KernelReading>
    /** The process listing, with each process's memory; none when `ps` can't tell. */
    readonly processes: Effect.Effect<
      Option.Option<ReadonlyArray<ProcessMemoryRow>>
    >
    readonly cores: Effect.Effect<ReadonlyArray<CoreTimes>>
  }
>()('@fabrica/engine/LoadReads') {}

// ---- The kernel's figures -----------------------------------------------------------------------

/** The number on `text`'s line starting with `name`, as vm_stat, /proc/meminfo and /proc/vmstat give theirs. */
const counter = (text: string, name: string): Option.Option<number> => {
  const line = text.split('\n').find(each => each.startsWith(name))
  const first = line?.slice(name.length).trim().split(/\s+/u)[0]
  return first !== undefined && /^\d+\.?$/u.test(first)
    ? Option.some(Number.parseInt(first, 10))
    : Option.none()
}

/** The two counters' sum, where both are known. */
const sumOf = (
  one: Option.Option<number>,
  other: Option.Option<number>,
): Option.Option<number> =>
  Option.zipWith(one, other, (first, second) => first + second)

const UNITS: Readonly<Record<string, number>> = {
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
}

/**
 * macOS's figures: `sysctl -n kern.memorystatus_vm_pressure_level kern.memorystatus_level vm.swapusage`,
 * a line each, and vm_stat's page counts; `free`, where vm_stat can't be read. Either is `""` where it
 * can't be read.
 */
export const parseDarwinKernel = (input: {
  readonly sysctl: string
  readonly vmstat: string
  readonly free: number
}): KernelReading => {
  const [level, percentFree, swap] = input.sysctl
    .split('\n')
    .map(line => line.trim())
  const page = /\(page size of (\d+) bytes\)/u.exec(input.vmstat)?.[1]
  const pages = [
    'Pages free:',
    'Pages inactive:',
    'Pages speculative:',
    'Pages purgeable:',
  ].map(name => counter(input.vmstat, name))
  const used = /used = ([\d.]+)([KMG])/u.exec(swap ?? '')
  const unit = UNITS[used?.[2] ?? '']
  return {
    availableBytes:
      page !== undefined && pages.every(Option.isSome)
        ? pages.reduce(
            (sum, count) => sum + Option.getOrElse(count, () => 0),
            0,
          ) * Number(page)
        : input.free,
    pressure: level === '4' ? 'critical' : level === '2' ? 'warn' : 'normal',
    pressurePercent:
      percentFree !== undefined && /^\d+$/u.test(percentFree)
        ? Option.some(100 - Number(percentFree))
        : Option.none(),
    swapUsedBytes:
      used === null || unit === undefined
        ? Option.none()
        : Option.some(Math.round(Number(used[1]) * unit)),
    swaps: sumOf(
      counter(input.vmstat, 'Swapins:'),
      counter(input.vmstat, 'Swapouts:'),
    ),
  }
}

/** The avg10 on the line of /proc/pressure/memory starting with `kind`. */
const stall = (
  pressure: string,
  kind: 'some' | 'full',
): Option.Option<number> => {
  const line = pressure.split('\n').find(each => each.startsWith(`${kind} `))
  const value = /avg10=([\d.]+)/u.exec(line ?? '')?.[1]
  return value === undefined ? Option.none() : Option.some(Number(value))
}

/**
 * Linux's figures from /proc/pressure/memory, /proc/meminfo and /proc/vmstat, each `""` where it can't
 * be read; `free`, where /proc/meminfo can't say. Without pressure-stall information, the pressure is
 * read from the share of memory available.
 */
export const parseLinuxKernel = (input: {
  readonly pressure: string
  readonly meminfo: string
  readonly vmstat: string
  readonly free: number
}): KernelReading => {
  const kib = (name: string) =>
    Option.map(counter(input.meminfo, name), count => count * 1024)
  const available = Option.getOrElse(kib('MemAvailable:'), () => input.free)
  const some = stall(input.pressure, 'some')
  const full = stall(input.pressure, 'full')
  const share = Option.map(kib('MemTotal:'), total =>
    total > 0 ? available / total : 1,
  )
  const pressure: MemoryPressure =
    Option.isSome(some) || Option.isSome(full)
      ? Option.exists(full, stalled => stalled >= STALL_CRITICAL)
        ? 'critical'
        : Option.exists(some, stalled => stalled >= STALL_WARN)
          ? 'warn'
          : 'normal'
      : Option.exists(share, each => each < AVAILABLE_CRITICAL)
        ? 'critical'
        : Option.exists(share, each => each < AVAILABLE_WARN)
          ? 'warn'
          : 'normal'
  return {
    availableBytes: available,
    pressure,
    pressurePercent: some,
    swapUsedBytes: Option.zipWith(
      kib('SwapTotal:'),
      kib('SwapFree:'),
      (total, free) => total - free,
    ),
    swaps: sumOf(
      counter(input.vmstat, 'pswpin'),
      counter(input.vmstat, 'pswpout'),
    ),
  }
}

/** The cores busy between two reads of their times; none before there are two. */
export const busyCoresOf = (
  before: ReadonlyArray<CoreTimes>,
  now: ReadonlyArray<CoreTimes>,
): number =>
  now.filter((core, index) => {
    const earlier = before[index]
    if (earlier === undefined) return false
    const busy = core.busy - earlier.busy
    const total = busy + core.idle - earlier.idle
    return total > 0 && busy / total >= BUSY_CORE
  }).length

// ---- A sample -----------------------------------------------------------------------------------

/** A process tree the sampler measures, until it is gone from the process listing. */
export type SampledTree = Data.TaggedEnum<{
  /** A worker's agent, or a command it runs through the engine, its `check_own`. */
  Worker: {
    readonly project: ProjectId
    readonly run: RunId
    readonly ticket: TicketId
    readonly pid: number
  }
  /** A merge check, the train's among them. */
  MergeCheck: {
    readonly project: ProjectId
    readonly run: RunId
    readonly pid: number
  }
}>
export const SampledTree = Data.taggedEnum<SampledTree>()

/** Where the engine's runs say which trees to measure; where no engine hosts them, nothing is measured. */
export const LoadProcesses = Context.Reference<{
  readonly track: (tree: SampledTree) => Effect.Effect<void>
}>('@fabrica/engine/LoadProcesses', {
  defaultValue: () => ({ track: () => Effect.void }),
})

/** A tree's memory as one listing found it; none where none of it is left. */
const memoryOf = (
  rows: ReadonlyArray<ProcessMemoryRow>,
  { pid }: SampledTree,
): Option.Option<number> => {
  // Started in a group of its own: what it leaves in the group is its still, its parent gone.
  const tree = treeOf({ rows, pids: new Set([pid]), groups: new Set([pid]) })
  return tree.length === 0
    ? Option.none()
    : Option.some(tree.reduce((sum, row) => sum + row.rssBytes, 0))
}

/** The trees of a listing, each with its memory, and those gone from it; with no listing, neither. */
export const measureTrees = (
  trees: ReadonlyArray<SampledTree>,
  listing: Option.Option<ReadonlyArray<ProcessMemoryRow>>,
): {
  readonly measured: ReadonlyArray<{
    readonly tree: SampledTree
    readonly bytes: number
  }>
  readonly gone: ReadonlyArray<SampledTree>
} => {
  if (Option.isNone(listing)) return { measured: [], gone: [] }
  const rows = listing.value
  const read = trees.map(tree => ({ tree, bytes: memoryOf(rows, tree) }))
  return {
    measured: read.flatMap(({ tree, bytes }) =>
      Option.match(bytes, {
        onNone: () => [],
        onSome: value => [{ tree, bytes: value }],
      }),
    ),
    gone: read
      .filter(({ bytes }) => Option.isNone(bytes))
      .map(({ tree }) => tree),
  }
}

/** What a sample keeps for the next: the cores' times and the swap count with when it was read, for their rates. */
export interface SampleMemo {
  readonly cores: ReadonlyArray<CoreTimes>
  readonly swaps: Option.Option<{ readonly count: number; readonly at: number }>
}

export const firstMemo: SampleMemo = { cores: [], swaps: Option.none() }

/** The sample from one set of reads, and what to keep for the next. */
export const sampleOf = (input: {
  readonly at: number
  readonly facts: HostFacts
  readonly kernel: KernelReading
  readonly cores: ReadonlyArray<CoreTimes>
  readonly measured: ReadonlyArray<{
    readonly tree: SampledTree
    readonly bytes: number
  }>
  readonly memo: SampleMemo
}): { readonly load: HostLoad; readonly memo: SampleMemo } => {
  const { at, facts, kernel, measured, memo } = input
  const workers = new Map<
    string,
    { project: ProjectId; ticket: TicketId; bytes: number }
  >()
  let mergeCheck = Option.none<number>()
  for (const { tree, bytes } of measured)
    SampledTree.$match(tree, {
      Worker: ({ project, ticket }) => {
        const key = `${project} ${ticket}`
        workers.set(key, {
          project,
          ticket,
          bytes: (workers.get(key)?.bytes ?? 0) + bytes,
        })
      },
      MergeCheck: () => {
        mergeCheck = Option.some(Option.getOrElse(mergeCheck, () => 0) + bytes)
      },
    })
  const swapping = Option.exists(
    Option.zipWith(memo.swaps, kernel.swaps, (earlier, count) => ({
      moved: count - earlier.count,
      minutes: (at - earlier.at) / 60_000,
    })),
    ({ moved, minutes }) =>
      minutes > 0 && moved / minutes >= SWAPPING_PER_MINUTE,
  )
  return {
    load: new HostLoad({
      sampledAt: DateTime.makeUnsafe(at),
      memory: {
        used: Math.max(0, facts.memoryBytes - kernel.availableBytes),
        total: facts.memoryBytes,
        pressure: kernel.pressure,
      },
      swapping,
      load1: facts.load,
      cores: facts.cores,
      busyCores: busyCoresOf(memo.cores, input.cores),
      workers: Array.from(workers.values(), worker => new WorkerMemory(worker)),
      mergeCheck,
    }),
    memo: {
      cores: input.cores,
      swaps: Option.map(kernel.swaps, count => ({ count, at })),
    },
  }
}

// ---- The sampler --------------------------------------------------------------------------------

export interface LoadSamplerShape {
  /** The latest sample; none before the first. */
  readonly latest: Effect.Effect<Option.Option<HostLoad>>
  /** The load stream (§8.3): a snapshot of the latest sample, then each sample as a patch. */
  readonly watch: (resume: Option.Option<Resume>) => Stream.Stream<HostLoadItem>
}

export class LoadSampler extends Context.Service<
  LoadSampler,
  LoadSamplerShape
>()('@fabrica/engine/LoadSampler') {}

/** A numbered sample. */
interface Numbered {
  readonly seq: number
  readonly load: HostLoad
}

/** The sampler, sampling from now until its scope ends, and where the engine's runs say what to measure. */
export const makeLoadSampler = Effect.fn('LoadSampler.make')(function* () {
  const [host, reads, telemetry] = yield* Effect.all([
    Host,
    LoadReads,
    Telemetry,
  ])
  const epoch = StreamEpoch.make(`load-${yield* drawBase36(12)}`)
  const trees = yield* Ref.make<ReadonlyArray<SampledTree>>([])
  const latest = yield* SubscriptionRef.make(Option.none<Numbered>())
  const memo = yield* Ref.make(firstMemo)

  const sample = Effect.gen(function* () {
    // Read before the listing: what was tracked by then has started, so a tree not listed has gone.
    const tracked = yield* Ref.get(trees)
    const [facts, kernel, processes, cores, at] = yield* Effect.all(
      [
        host.facts,
        reads.kernel,
        reads.processes,
        reads.cores,
        Clock.currentTimeMillis,
      ],
      { concurrency: 'unbounded' },
    )
    const { measured, gone } = measureTrees(tracked, processes)
    yield* Ref.update(trees, all => all.filter(tree => !gone.includes(tree)))
    const made = sampleOf({
      at,
      facts,
      kernel,
      cores,
      measured,
      memo: yield* Ref.get(memo),
    })
    yield* Ref.set(memo, made.memo)
    yield* SubscriptionRef.update(latest, last =>
      Option.some({
        seq: Option.match(last, {
          onNone: () => 0,
          onSome: ({ seq }) => seq + 1,
        }),
        load: made.load,
      }),
    )
    yield* telemetry.record(
      TelemetryRow.HostSample({
        load: facts.load,
        cores: facts.cores,
        memoryPressure: Option.getOrUndefined(kernel.pressurePercent),
        swapUsedBytes: Option.getOrUndefined(kernel.swapUsedBytes),
      }),
    )
    yield* Effect.forEach(
      measured,
      ({ tree, bytes }) =>
        telemetry.record(
          TelemetryRow.ProcessSample({
            project: tree.project,
            run: tree.run,
            ...SampledTree.$match(tree, {
              Worker: ({ ticket }) => ({
                ticket,
                process: 'worker' as const,
              }),
              MergeCheck: () => ({ process: 'check' as const }),
            }),
            rssBytes: bytes,
          }),
        ),
      { discard: true },
    )
  }).pipe(
    Effect.withSpan('LoadSampler.sample'),
    // A defect reading the host loses that sample, not the stream.
    Effect.catchCause(cause =>
      Effect.logWarning("the host's load couldn't be sampled", cause),
    ),
  )
  yield* Effect.forever(
    Effect.andThen(sample, Effect.sleep(LOAD_INTERVAL)),
  ).pipe(Effect.forkScoped)

  const watch = (resume: Option.Option<Resume>) =>
    SubscriptionRef.changes(latest).pipe(
      Stream.flatMap(numbered => Stream.fromIterable(Option.toArray(numbered))),
      Stream.mapAccum(
        () => false,
        (
          sent,
          { seq, load },
        ): readonly [boolean, ReadonlyArray<HostLoadItem>] =>
          sent
            ? [true, [HostLoadItem.cases.patch.make({ seq, value: load })]]
            : [
                true,
                ResumePlan.$match(
                  // Each sample is whole, so the stream keeps no patches.
                  planResume({ resume, epoch, oldest: seq + 1, latest: seq }),
                  {
                    Snapshot: () => [
                      HostLoadItem.cases.snapshot.make({
                        epoch,
                        seq,
                        value: load,
                      }),
                    ],
                    PatchesAfter: () => [],
                  },
                ),
              ],
      ),
    )

  return {
    sampler: LoadSampler.of({
      latest: Effect.map(
        SubscriptionRef.get(latest),
        Option.map(({ load }) => load),
      ),
      watch,
    }),
    processes: {
      track: (tree: SampledTree) => Ref.update(trees, all => [...all, tree]),
    },
  }
})

/** The sampler and where its trees are told, sampling while the layer's scope lasts. */
export const layerLoadSampler = Layer.effectContext(
  Effect.map(makeLoadSampler(), ({ sampler, processes }) =>
    Context.make(LoadSampler, sampler).pipe(
      Context.add(LoadProcesses, processes),
    ),
  ),
)

// ---- This host ----------------------------------------------------------------------------------

/** A command's output on the host, `""` where it can't be had. */
const outputOf = (file: string, args: ReadonlyArray<string>) =>
  Effect.callback<string>(resume => {
    execFile(
      file,
      [...args],
      { env: { LC_ALL: 'C' }, timeout: 10_000 },
      (error, stdout) => {
        resume(Effect.succeed(error === null ? stdout : ''))
      },
    )
  })

/** A file of the host, `""` where it can't be read. */
const contentsOf = (path: string) =>
  Effect.promise(() => readFile(path, 'utf8').catch(() => ''))

const darwinKernel = Effect.map(
  Effect.all(
    [
      outputOf('/usr/sbin/sysctl', [
        '-n',
        'kern.memorystatus_vm_pressure_level',
        'kern.memorystatus_level',
        'vm.swapusage',
      ]),
      outputOf('/usr/bin/vm_stat', []),
    ],
    { concurrency: 'unbounded' },
  ),
  ([sysctl, vmstat]) =>
    parseDarwinKernel({ sysctl, vmstat, free: NodeOs.freemem() }),
)

const linuxKernel = Effect.map(
  Effect.all(
    [
      contentsOf('/proc/pressure/memory'),
      contentsOf('/proc/meminfo'),
      contentsOf('/proc/vmstat'),
    ],
    { concurrency: 'unbounded' },
  ),
  ([pressure, meminfo, vmstat]) =>
    parseLinuxKernel({ pressure, meminfo, vmstat, free: NodeOs.freemem() }),
)

/** The reads of this machine: macOS's and Linux's own figures; elsewhere only what Node gives. */
export const layerNodeLoadReads: Layer.Layer<LoadReads> = Layer.succeed(
  LoadReads,
  LoadReads.of({
    kernel: process.platform === 'darwin' ? darwinKernel : linuxKernel,
    processes: listProcessMemory,
    cores: Effect.sync(() =>
      NodeOs.cpus().map(({ times }) => ({
        busy: times.user + times.nice + times.sys + times.irq,
        idle: times.idle,
      })),
    ),
  }),
)
