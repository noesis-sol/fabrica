import {
  Array,
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  type Scope,
} from 'effect'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { Banner } from '@fabrica/contracts'

import { CommandOutcome, ExitStatus, ProcessRunner } from '../process'

// The battery (spec §7.7, H67): a run that starts on a host with a battery says a closed lid still
// sleeps it, since keeping awake prevents idle sleep only; one that starts on battery says so. While
// it goes, the battery is read once a minute and warned of at 20% and at 10% while discharging: an
// event and a banner each time, and a notification at 10% (tutti-yhjt). Writing the event is the run
// log's (`recordBattery`); the banner and the notification are the run view's and the app's.

/** What the host draws its power from, as read. */
export type Power = Data.TaggedEnum<{
  /** No battery to run on: a desktop, a server, a virtual machine. */
  NoBattery: {}
  /** A battery, its charge in percent, and whether the host is running on it. */
  Battery: { readonly level: number; readonly discharging: boolean }
}>
export const Power = Data.taggedEnum<Power>()

/** The charges warned of while discharging, highest first. */
export const batteryThresholds = [20, 10] as const
export type BatteryThreshold = (typeof batteryThresholds)[number]

/** What the run says of the battery. */
export type BatteryNotice = Data.TaggedEnum<{
  /** The run's start, on a host with a battery: a closed lid still sleeps it. */
  LidSleeps: {}
  /** The run's start, on battery. */
  OnBattery: { readonly level: number }
  /** The battery, discharging, reached a threshold. */
  Low: { readonly level: number; readonly threshold: BatteryThreshold }
}>
export const BatteryNotice = Data.taggedEnum<BatteryNotice>()

/** Whether the app notifies of `notice`, beside its event and banner: the battery at 10%. */
export const batteryNotifies: (notice: BatteryNotice) => boolean =
  BatteryNotice.$match({
    LidSleeps: () => false,
    OnBattery: () => false,
    Low: ({ threshold }) => threshold === 10,
  })

/** The banner over the run's stats row for `notice`: none for the closed lid, said once at the start. */
export const batteryBanner: (notice: BatteryNotice) => Option.Option<Banner> =
  BatteryNotice.$match({
    LidSleeps: () => Option.none(),
    OnBattery: ({ level }) =>
      Option.some(
        new Banner({
          tone: 'warning',
          text: `On battery at ${level}%`,
          lifts: Option.none(),
        }),
      ),
    Low: ({ level }) =>
      Option.some(
        new Banner({
          tone: 'warning',
          text: `Battery at ${level}% and discharging`,
          lifts: Option.none(),
        }),
      ),
  })

/** What a run's start says of `power`. */
export const startNotices = (power: Power): ReadonlyArray<BatteryNotice> =>
  Power.$match(power, {
    NoBattery: () => [],
    Battery: ({ level, discharging }) =>
      discharging
        ? [BatteryNotice.LidSleeps(), BatteryNotice.OnBattery({ level })]
        : [BatteryNotice.LidSleeps()],
  })

/** A reading against the thresholds already warned of: the warning it gives, and those warned of after it. */
export interface Reached {
  readonly notice: Option.Option<BatteryNotice>
  readonly warned: ReadonlySet<BatteryThreshold>
}

/**
 * What `power` reaches, `warned` warned of already: a threshold the charge has risen above is warned
 * of again when it comes down to it; of those reached at once while discharging, the lowest is said.
 */
export const reachedThreshold = (
  power: Power,
  warned: ReadonlySet<BatteryThreshold>,
): Reached =>
  Power.$match(power, {
    NoBattery: () => ({ notice: Option.none(), warned }),
    Battery: ({ level, discharging }) => {
      const armed = batteryThresholds.filter(
        threshold => level <= threshold && !warned.has(threshold),
      )
      const still = batteryThresholds.filter(
        threshold => level <= threshold && warned.has(threshold),
      )
      if (!discharging) return { notice: Option.none(), warned: new Set(still) }
      return {
        notice: Option.map(Array.last(armed), threshold =>
          BatteryNotice.Low({ level, threshold }),
        ),
        warned: new Set([...still, ...armed]),
      }
    },
  })

/** Reads the host's battery. */
export class Battery extends Context.Service<
  Battery,
  {
    /** The host's power as it is now; none where it can't be read. */
    readonly read: Effect.Effect<Option.Option<Power>>
  }
>()('Battery') {}

/** No battery: for a host whose OS says nothing of one. */
export const noBattery: Layer.Layer<Battery> = Layer.succeed(
  Battery,
  Battery.of({ read: Effect.succeedSome(Power.NoBattery()) }),
)

/**
 * `pmset -g batt`'s output as power: `Now drawing from 'Battery Power'` on battery, and a line for
 * each battery (` -InternalBattery-0 (id=…)\t85%; discharging; …`), none on a Mac without one.
 */
export const parsePmsetBatt = (output: string): Option.Option<Power> => {
  const drawing = /Now drawing from '([^']+)'/.exec(output)
  if (drawing === null) return Option.none()
  const level = /InternalBattery[^\n]*?\s(\d{1,3})%/.exec(output)
  if (level === null) return Option.some(Power.NoBattery())
  return Option.some(
    Power.Battery({
      level: Math.min(Number(level[1]), 100),
      discharging: drawing[1] === 'Battery Power',
    }),
  )
}

/** The battery as `pmset -g batt` gives it: macOS's. */
export const pmsetBattery: Layer.Layer<Battery, never, ProcessRunner> =
  Layer.effect(
    Battery,
    Effect.gen(function* () {
      const runner = yield* ProcessRunner
      return Battery.of({
        read: Effect.gen(function* () {
          const outcome = yield* runner.run({
            command: '/usr/bin/pmset',
            args: ['-g', 'batt'],
            cwd: '/',
            timeLimit: Duration.seconds(10),
          })
          const power = CommandOutcome.$match(outcome, {
            Exited: ({ status, stdout }) =>
              ExitStatus.$match(status, {
                Code: ({ code }) =>
                  code === 0 ? parsePmsetBatt(stdout) : Option.none(),
                Signal: () => Option.none(),
              }),
            TimedOut: () => Option.none(),
            Cut: () => Option.none(),
            FailedToStart: () => Option.none(),
          })
          if (Option.isNone(power)) {
            yield* Effect.logDebug('pmset -g batt gave no reading', outcome)
          }
          return power
        }).pipe(Effect.withSpan('Battery.read')),
      })
    }),
  )

/** One power supply as the kernel describes it under `/sys/class/power_supply/<name>/`. */
export interface PowerSupply {
  readonly type: Option.Option<string>
  readonly scope: Option.Option<string>
  readonly capacity: Option.Option<string>
  readonly status: Option.Option<string>
}

/**
 * The host's power from its power supplies: the batteries that power it (not a mouse's or a
 * headset's, whose scope is `Device`), their charges averaged, discharging when any is.
 */
export const parsePowerSupplies = (
  supplies: ReadonlyArray<PowerSupply>,
): Power => {
  const batteries = Array.getSomes(
    supplies.map(supply => {
      const powersHost =
        Option.contains(supply.type, 'Battery') &&
        !Option.contains(supply.scope, 'Device')
      const level = Option.flatMap(supply.capacity, capacity =>
        /^\d{1,3}$/.test(capacity)
          ? Option.some(Math.min(Number(capacity), 100))
          : Option.none(),
      )
      return powersHost
        ? Option.map(level, charge => ({
            level: charge,
            discharging: Option.contains(supply.status, 'Discharging'),
          }))
        : Option.none()
    }),
  )
  if (!Array.isArrayNonEmpty(batteries)) return Power.NoBattery()
  const total = batteries.reduce((sum, battery) => sum + battery.level, 0)
  return Power.Battery({
    level: Math.round(total / batteries.length),
    discharging: batteries.some(battery => battery.discharging),
  })
}

const readAttribute = (folder: string, name: string) =>
  Effect.promise(() =>
    readFile(join(folder, name), 'utf8').then(
      text => Option.some(text.trim()),
      () => Option.none<string>(),
    ),
  )

/**
 * The battery as the kernel gives it under `root` (`/sys/class/power_supply` on Linux): no battery
 * where there is no such folder, as in a container.
 */
export const sysfsBattery = (root: string): Layer.Layer<Battery> =>
  Layer.succeed(
    Battery,
    Battery.of({
      read: Effect.gen(function* () {
        const names = yield* Effect.promise(() =>
          readdir(root).then(
            found => found,
            () => [],
          ),
        )
        const supplies = yield* Effect.forEach(
          names,
          name =>
            Effect.all({
              type: readAttribute(join(root, name), 'type'),
              scope: readAttribute(join(root, name), 'scope'),
              capacity: readAttribute(join(root, name), 'capacity'),
              status: readAttribute(join(root, name), 'status'),
            }),
          { concurrency: 'unbounded' },
        )
        return Option.some(parsePowerSupplies(supplies))
      }).pipe(Effect.withSpan('Battery.read')),
    }),
  )

/** The battery `platform` reads: pmset's on macOS, the kernel's on Linux, none elsewhere. */
export const batteryFor = (
  platform: NodeJS.Platform,
): Layer.Layer<Battery, never, ProcessRunner> => {
  if (platform === 'darwin') return pmsetBattery
  if (platform === 'linux') return sysfsBattery('/sys/class/power_supply')
  return noBattery
}

/** How often a run reads the battery. */
export const batteryInterval = Duration.minutes(1)

/**
 * Watches the battery for a run: reads it once as the run starts and reports what the start says
 * and any threshold it is already at, then reads it every minute while the scope is open, reporting
 * each threshold reached. Returns the start's reading.
 */
export const watchBattery = <R>(
  report: (notice: BatteryNotice) => Effect.Effect<void, never, R>,
): Effect.Effect<Option.Option<Power>, never, Battery | Scope.Scope | R> =>
  Effect.gen(function* () {
    const battery = yield* Battery
    const warned = yield* Ref.make<ReadonlySet<BatteryThreshold>>(new Set())
    const check = (power: Power) =>
      Effect.flatMap(
        Ref.modify(warned, before => {
          const reached = reachedThreshold(power, before)
          return [reached.notice, reached.warned]
        }),
        notice =>
          Option.match(notice, { onNone: () => Effect.void, onSome: report }),
      )
    const checkRead = Effect.flatMap(battery.read, power =>
      Option.match(power, { onNone: () => Effect.void, onSome: check }),
    )
    const first = yield* battery.read
    yield* Option.match(first, {
      onNone: () => Effect.void,
      onSome: power =>
        Effect.andThen(
          Effect.forEach(startNotices(power), report, { discard: true }),
          check(power),
        ),
    })
    yield* Effect.forkScoped(
      Effect.forever(Effect.delay(checkRead, batteryInterval)),
    )
    return first
  }).pipe(Effect.withSpan('Battery.watch'))
