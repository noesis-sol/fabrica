import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
  Stream,
} from 'effect'
import { TestClock } from 'effect/testing'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  Banner,
  EngineId,
  Hold,
  type ModelName,
  ProjectId,
  RunHeader,
  RunId,
  RunMode,
  TicketId,
} from '@fabrica/contracts'

import { noSpend } from '../src/cost'
import {
  type HoldsSnapshot,
  holdRows,
  makeHolds,
  makeUsageHold,
} from '../src/holds'
import { ProbeOutcome as ProxyProbe, classify } from '../src/proxy'
import { runProject } from '../src/run'
import type { RunStateShape } from '../src/run'
import { makeRunLog } from '../src/runlog'
import { Battery, Power, watchBattery } from '../src/time'
import {
  type RunViewItem,
  type RunViewSources,
  type ViewInputs,
  makeRunView,
  makeRunViewSources,
  projectView,
} from '../src/view'
import { configOf, options, project, setUpRuns, withRuns } from './run-harness'

// The run view's holds and banners (spec §8.3, §14, §18.3): the holds on, as their one state has them,
// are the view's holds, each with its reason, since when and when it lifts where that is known, and each
// makes a `hold` banner; the battery's warning takes a banner while the host runs on it (§7.7).

const run = RunId.make('2026-10-30T09:00:00+01:00')
const interval = Duration.millis(50)
const start = Date.UTC(2026, 9, 30, 8, 0, 0)

const header = new RunHeader({
  run,
  project: ProjectId.make('work'),
  engine: EngineId.make('engine-1'),
  mode: RunMode.cases.tickets.make({}),
  state: 'running',
  startedAt: DateTime.makeUnsafe(0),
  offline: false,
  autoAnswer: false,
})

const nowhere = (path: string) => ({ path, append: () => Effect.void })

const logInMemory = makeRunLog({
  run,
  events: nowhere('events.jsonl'),
  log: nowhere('run.log'),
})

const hold = (input: {
  readonly kind: Hold['kind']
  readonly reason: string
  readonly provider?: string
}) =>
  new Hold({
    kind: input.kind,
    reason: input.reason,
    since: DateTime.makeUnsafe(start),
    lifts: Option.none(),
    provider: Option.fromUndefinedOr(input.provider),
  })

const inputsOf = (overrides: Partial<ViewInputs>): ViewInputs => ({
  header,
  now: DateTime.makeUnsafe(start),
  tickets: [],
  facts: new Map(),
  slots: 2,
  line: { merging: Option.none(), waiting: [] },
  mergesWait: Option.none(),
  battery: Option.none(),
  workers: [],
  steps: [],
  doneToday: 0,
  spent: new Map(),
  tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
  holds: [],
  attention: [],
  load: Option.none(),
  ...overrides,
})

const noTickets: RunStateShape = {
  current: Effect.succeed({
    tickets: new Map(),
    dispatched: 0,
    ending: false,
  }),
  enter: () => Effect.succeed(false),
  dispatch: () => Effect.succeed(Option.none()),
  move: () => Effect.succeed(Option.none()),
  end: Effect.succeed({ tickets: new Map(), dispatched: 0, ending: false }),
  endLeft: Effect.void,
}

describe('the projection of holds', () => {
  const anthropic = hold({
    kind: 'USAGE_LIMIT',
    reason: "anthropic's usage limit",
    provider: 'anthropic',
  })
  const openai = hold({
    kind: 'USAGE_LIMIT',
    reason: "openai's usage limit",
    provider: 'openai',
  })

  it('keeps every row of two holds of one kind, a provider each, as they were', () => {
    const before = projectView(
      inputsOf({ holds: [anthropic, openai] }),
      Option.none(),
    )
    const after = projectView(
      inputsOf({
        holds: [
          hold({
            kind: 'USAGE_LIMIT',
            reason: "anthropic's usage limit",
            provider: 'anthropic',
          }),
          hold({
            kind: 'USAGE_LIMIT',
            reason: "openai's usage limit",
            provider: 'openai',
          }),
        ],
      }),
      Option.some(before),
    )
    expect(after.holds).toBe(before.holds)
    expect(after.banners).toBe(before.banners)
  })

  it('gives a hold a banner with its reason and lift, and the battery its own after it', () => {
    const lifts = Option.some(DateTime.makeUnsafe(start + 60_000))
    const battery = new Banner({
      tone: 'warning',
      text: 'On battery at 40%',
      lifts: Option.none(),
    })
    const view = projectView(
      inputsOf({
        holds: [new Hold({ ...anthropic, lifts })],
        battery: Option.some(battery),
      }),
      Option.none(),
    )
    expect(view.banners).toEqual([
      new Banner({ tone: 'hold', text: "anthropic's usage limit", lifts }),
      battery,
    ])
  })
})

describe("a run view's holds", () => {
  it.effect(
    'follows the holds as they are raised and lifted, publishing only what changed',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(start)
        const scope = yield* Scope.make()
        const log = yield* logInMemory
        const holds = yield* makeHolds({ log, running: Effect.succeed(0) })
        const view = yield* makeRunView({
          header: Effect.succeed(header),
          interval,
          flush: interval,
          graph: {
            doneSince: () => Effect.succeed(0),
            changes: Effect.succeed(Stream.never),
          },
          attention: Stream.never,
          needsYou: () => Effect.void,
          reviews: () => Effect.void,
          scope,
        })
        const items = yield* Queue.unbounded<RunViewItem>()
        yield* view.watch(Option.none()).pipe(
          Stream.runForEach(item => Queue.offer(items, item)),
          Effect.forkIn(scope),
        )
        yield* Effect.yieldNow
        const patches = Effect.map(Queue.clear(items), all =>
          all.flatMap(item => (item._tag === 'patch' ? [item.value] : [])),
        )
        yield* view.sources.attach({
          state: noTickets,
          holds: holds.current,
          line: Effect.succeed({ merging: Option.none(), waiting: [] }),
          mergesWait: Effect.succeed(Option.none()),
          slots: 2,
          spent: Effect.succeed({
            tickets: new Map(),
            run: { workers: noSpend, untied: noSpend },
          }),
        })
        yield* TestClock.adjust(interval)
        yield* patches

        const reset = start + 3_600_000
        yield* holds.raise({
          hold: 'USAGE_LIMIT',
          provider: 'anthropic',
          why: "anthropic's usage limit",
          lifts: reset,
        })
        yield* holds.raise({
          hold: 'USAGE_LIMIT',
          provider: 'openai',
          why: "openai's usage limit",
        })
        const since = DateTime.makeUnsafe(start + 50)
        const anthropicHold = new Hold({
          kind: 'USAGE_LIMIT',
          reason: "anthropic's usage limit",
          since,
          lifts: Option.some(DateTime.makeUnsafe(reset)),
          provider: Option.some('anthropic'),
        })
        yield* TestClock.adjust(interval)
        const [raised] = yield* patches
        expect(raised?.holds).toEqual([
          anthropicHold,
          new Hold({
            kind: 'USAGE_LIMIT',
            reason: "openai's usage limit",
            since,
            lifts: Option.none(),
            provider: Option.some('openai'),
          }),
        ])
        expect(raised?.banners).toEqual([
          new Banner({
            tone: 'hold',
            text: "anthropic's usage limit",
            lifts: Option.some(DateTime.makeUnsafe(reset)),
          }),
          new Banner({
            tone: 'hold',
            text: "openai's usage limit",
            lifts: Option.none(),
          }),
        ])

        // Nothing changes: nothing is published.
        yield* TestClock.adjust(interval)
        expect(yield* patches).toEqual([])

        // Lifting one leaves the other.
        yield* holds.lift({
          hold: 'USAGE_LIMIT',
          provider: 'openai',
          why: 'it went through',
        })
        yield* TestClock.adjust(interval)
        const [lifted] = yield* patches
        expect(lifted?.holds).toEqual([anthropicHold])
        expect(lifted?.banners?.map(({ text }) => text)).toEqual([
          "anthropic's usage limit",
        ])

        // The battery's warning comes and goes.
        const battery = new Banner({
          tone: 'warning',
          text: 'Battery at 20% and discharging',
          lifts: Option.none(),
        })
        yield* view.sources.warnBattery(Option.some(battery))
        yield* TestClock.adjust(interval)
        const [warned] = yield* patches
        expect(warned?.banners?.at(-1)).toEqual(battery)
        expect(warned?.holds).toBeUndefined()
        yield* view.sources.warnBattery(Option.none())
        yield* TestClock.adjust(interval)
        const [plugged] = yield* patches
        expect(plugged?.banners?.map(({ tone }) => tone)).toEqual(['hold'])
        yield* Scope.close(scope, Exit.void)
      }).pipe(Effect.provide(DateTime.layerCurrentZoneOffset(0))),
  )
})

describe("when a usage hold's row says it lifts", () => {
  const anthropic = 'anthropic'
  const ticket = TicketId.make('fa-h1')
  const hour = 3_600_000
  const firstReset = start + 2 * hour
  const laterReset = start + 4 * hour
  const refusedUntil = (resetMs: number) =>
    Option.getOrThrow(
      classify({
        status: 429,
        headers: {
          'content-type': 'application/json',
          'anthropic-ratelimit-unified-reset': String(resetMs / 1000),
        },
        wentThrough: true,
        account: Option.none(),
      }),
    )

  it.effect(
    'is its reset as known, and moves as a probe learns another or loses it',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(start)
        const log = yield* logInMemory
        const holds = yield* makeHolds({ log, running: Effect.succeed(1) })
        const answers = yield* Ref.make<ReadonlyArray<ProxyProbe>>([
          ProxyProbe.Refused({ refusal: refusedUntil(laterReset) }),
          ProxyProbe.Failed({ reason: 'the network is down' }),
        ])
        const usage = yield* makeUsageHold({
          holds,
          log,
          run,
          retry: Duration.minutes(15),
          wait: Duration.hours(12),
          events: Stream.never,
          probe: () =>
            Ref.modify(answers, ([next, ...rest]) => [
              next ?? ProxyProbe.Passed(),
              rest,
            ]),
          modelFor: (): Option.Option<ModelName> => Option.some('claude'),
        })
        const rows = Effect.map(holds.current, holdRows)
        yield* usage.refused({
          provider: anthropic,
          model: Option.some('claude'),
          ticket: Option.some(ticket),
          resetAt: DateTime.makeUnsafe(firstReset),
        })
        const [raised] = yield* rows
        expect(raised?.lifts).toEqual(
          Option.some(DateTime.makeUnsafe(firstReset)),
        )
        expect(raised?.reason).toContain('until its reset at 10:00')
        expect(raised?.since).toEqual(DateTime.makeUnsafe(start))
        expect(raised?.provider).toEqual(Option.some(anthropic))

        // At the reset its probe is refused, naming a later one.
        yield* TestClock.adjust(Duration.hours(2))
        const [later] = yield* rows
        expect(later?.lifts).toEqual(
          Option.some(DateTime.makeUnsafe(laterReset)),
        )
        expect(later?.reason).toContain('until its reset at 12:00')
        expect(later?.since).toEqual(DateTime.makeUnsafe(start))

        // At that one its probe fails: no reset is known any more.
        yield* TestClock.adjust(Duration.hours(2))
        const [unknown] = yield* rows
        expect(unknown?.lifts).toEqual(Option.none())
        expect(unknown?.reason).toContain('its reset unknown')
      }).pipe(
        Effect.scoped,
        Effect.provide(DateTime.layerCurrentZoneOffset(0)),
      ),
  )
})

describe('the raised hold revised', () => {
  it.effect('changes the hold alone, and only one that is on', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start)
      const log = yield* logInMemory
      const holds = yield* makeHolds({ log, running: Effect.succeed(0) })
      yield* holds.raise({ hold: 'ENVIRONMENT', why: 'idle tickets' })
      yield* holds.raise({
        hold: 'USAGE_LIMIT',
        provider: 'anthropic',
        why: 'limit',
        lifts: start + 1,
      })
      expect(
        yield* holds.revise({
          hold: 'USAGE_LIMIT',
          provider: 'openai',
          why: 'not on',
        }),
      ).toBe(false)
      expect(
        yield* holds.revise({
          hold: 'USAGE_LIMIT',
          provider: 'anthropic',
          why: 'limit, reset unknown',
        }),
      ).toBe(true)
      const { on }: HoldsSnapshot = yield* holds.current
      expect(on.map(({ hold, why, lifts }) => [hold, why, lifts])).toEqual([
        ['ENVIRONMENT', 'idle tickets', Option.none()],
        ['USAGE_LIMIT', 'limit, reset unknown', Option.none()],
      ])
    }).pipe(Effect.provide(DateTime.layerCurrentZoneOffset(0))),
  )
})

/** A battery reading `readings` in turn, the last again and again. */
const batteryReading = (readings: ReadonlyArray<Option.Option<Power>>) =>
  Layer.effect(
    Battery,
    Effect.map(Ref.make(readings), left =>
      Battery.of({
        read: Ref.modify(left, ([next = Option.none(), ...rest]) => [
          next,
          rest.length === 0 ? [next] : rest,
        ]),
      }),
    ),
  )

describe("the battery's banner", () => {
  const on = (level: number) =>
    Option.some(Power.Battery({ level, discharging: true }))
  const charging = (level: number) =>
    Option.some(Power.Battery({ level, discharging: false }))
  const minute = Effect.andThen(TestClock.adjust('1 minute'), Effect.yieldNow)

  it.effect(
    'says the charge as read while the host runs on it, and goes when it no longer does',
    () =>
      Effect.gen(function* () {
        const told: Array<Option.Option<string>> = []
        const notices: Array<string> = []
        yield* watchBattery(
          notice =>
            Effect.sync(() => {
              notices.push(notice._tag)
            }),
          banner =>
            Effect.sync(() => {
              told.push(Option.map(banner, ({ text }) => text))
            }),
        ).pipe(
          Effect.provide(
            batteryReading([
              on(40),
              on(39),
              on(20),
              on(19),
              Option.none(),
              charging(21),
              on(21),
            ]),
          ),
        )
        for (let n = 0; n < 6; n++) yield* minute
        expect(told).toEqual([
          Option.some('On battery at 40%'),
          Option.some('On battery at 39%'),
          Option.some('Battery at 20% and discharging'),
          Option.some('Battery at 19% and discharging'),
          // A reading that fails leaves the banner as it is.
          Option.none(),
          // Unplugged again above every threshold: nothing to warn of until the next one.
          Option.none(),
        ])
        expect(notices).toEqual(['LidSleeps', 'OnBattery', 'Low'])
      }).pipe(Effect.scoped),
  )

  it.effect(
    'comes back when the host is unplugged below a threshold warned of already',
    () =>
      Effect.gen(function* () {
        const told: Array<Option.Option<string>> = []
        const notices: Array<string> = []
        yield* watchBattery(
          notice =>
            Effect.sync(() => {
              notices.push(notice._tag)
            }),
          banner =>
            Effect.sync(() => {
              told.push(Option.map(banner, ({ text }) => text))
            }),
        ).pipe(Effect.provide(batteryReading([on(19), charging(19), on(19)])))
        for (let n = 0; n < 2; n++) yield* minute
        expect(told).toEqual([
          Option.some('Battery at 19% and discharging'),
          Option.none(),
          Option.some('Battery at 19% and discharging'),
        ])
        // Warned of once: no record again until it has risen above the threshold.
        expect(notices).toEqual(['LidSleeps', 'OnBattery', 'Low'])
      }).pipe(Effect.scoped),
  )

  it.effect('says nothing of a host that runs on no battery', () =>
    Effect.gen(function* () {
      const told: Array<Option.Option<Banner>> = []
      yield* watchBattery(
        () => Effect.void,
        banner =>
          Effect.sync(() => {
            told.push(banner)
          }),
      ).pipe(Effect.provide(batteryReading([Option.some(Power.NoBattery())])))
      expect(told).toEqual([Option.none()])
    }).pipe(Effect.scoped),
  )
})

describe('a run writes its holds and battery into its view', () => {
  beforeAll(setUpRuns)

  it.effect('attaches its holds, and tells the battery it starts on', () => {
    const fixture = project()
    return withRuns(
      fixture,
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        const sources = yield* makeRunViewSources({ flush: interval, scope })
        const attached = yield* Deferred.make<Effect.Effect<HoldsSnapshot>>()
        const warnings = yield* Ref.make<ReadonlyArray<string>>([])
        const viewed: RunViewSources = {
          ...sources.sources,
          attach: parts =>
            Effect.andThen(
              Deferred.succeed(attached, parts.holds),
              sources.sources.attach(parts),
            ),
          warnBattery: banner =>
            Ref.update(warnings, seen => [
              ...seen,
              ...Option.toArray(banner).map(({ text }) => text),
            ]),
        }
        const end = yield* runProject(
          configOf(fixture, options()),
          undefined,
          viewed,
        ).pipe(
          Effect.provide(
            batteryReading([
              Option.some(Power.Battery({ level: 70, discharging: true })),
            ]),
          ),
        )
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        const holds = yield* Effect.flatten(Deferred.await(attached))
        expect(holdRows(holds)).toEqual([])
        expect(yield* Ref.get(warnings)).toEqual(['On battery at 70%'])
      }),
    )
  })
})
