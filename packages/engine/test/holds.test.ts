import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Ref,
  Stream,
} from 'effect'
import { TestClock } from 'effect/testing'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  type RunEvent,
  RunId,
  TicketId,
  exitCodeOf,
} from '@fabrica/contracts'

import {
  ENV_PROBE,
  EnvironmentProbe,
  ProbeOutcome,
  Settle,
  anyOn,
  banners,
  clockHeld,
  counted,
  makeHolds,
  noCount,
  stopping,
  tripped,
} from '../src/holds'
import { WorkerEnd, makeRunControl, runProject } from '../src/run'
import {
  MayTake,
  makeEnvironmentHold,
  mayTake,
  settleOf,
  supervisorHolds,
} from '../src/run/holds'
import { RunLog, layerRunLog, readEvents } from '../src/runlog'
import { WorkGraph } from '../src/workgraph'
import {
  configOf,
  eventsOf,
  file,
  ofKind,
  options,
  project,
  setUpRuns,
  settings,
  withRuns,
} from './run-harness'

// The holds as one state and the environment hold (spec §14, §14.1, H58): lifting one hold never lifts
// another, whether the run may take work is read from one snapshot, and the environment hold trips on
// tickets in a row settling idle or failing their setups, sessions that don't start among them, probes
// the machine after `env_probe`, and goes on (`PROBE_OK`) or ends the run with exit 7; a wait for a
// ticket not merged and a refused credential aren't counted.

beforeAll(setUpRuns)

const run = RunId.make('run-holds')
const maintainer: Actor = { _tag: 'maintainer' }
const one = TicketId.make('fa-a1')
const two = TicketId.make('fa-a2')
const three = TicketId.make('fa-a3')
const four = TicketId.make('fa-a4')
const idle = (ticket: TicketId) =>
  Settle.Idle({ ticket, why: 'its worker settled with no outcome' })

/** A run log of its own in a fresh folder, and its records read back. */
const withLog = <A, E>(
  body: (log: RunLog['Service']) => Effect.Effect<A, E, RunLog>,
) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fab-holds-')))
  return Effect.gen(function* () {
    const result = yield* body(yield* RunLog)
    const read = yield* readEvents({ root, run: Option.some(run) })
    return { result, events: read.events }
  }).pipe(
    Effect.provide(
      layerRunLog({ root, run }).pipe(
        Layer.provide(DateTime.layerCurrentZoneOffset(0)),
      ),
    ),
  )
}

const holdTexts = (events: ReadonlyArray<RunEvent>) =>
  events.flatMap(event =>
    event.kind === 'hold' || event.kind === 'probed' ? [event.text] : [],
  )

describe('the holds as one state', () => {
  it.effect('lifts one hold without lifting another', () =>
    Effect.gen(function* () {
      const { result, events } = yield* withLog(log =>
        Effect.gen(function* () {
          const holds = yield* makeHolds({ log, running: Effect.succeed(2) })
          const seen: Array<MayTake['_tag']> = []
          const look = Effect.map(holds.current, snapshot => {
            const may = mayTake({ holds: snapshot, draining: false })
            seen.push(may._tag)
            return may
          })
          expect(
            yield* holds.raise({
              hold: 'ENVIRONMENT',
              why: '3 tickets in a row settled idle',
            }),
          ).toBe(true)
          expect(
            yield* holds.raise({
              hold: 'USAGE_LIMIT',
              provider: 'anthropic',
              why: "anthropic's usage limit",
            }),
          ).toBe(true)
          expect(
            yield* holds.raise({
              hold: 'CREDENTIALS',
              provider: 'openai',
              why: "openai's key was refused",
            }),
          ).toBe(true)
          // Raised again, it is on already: nothing changes, no record.
          expect(
            yield* holds.raise({ hold: 'ENVIRONMENT', why: 'again' }),
          ).toBe(false)
          expect(clockHeld(yield* holds.current)).toBe(true)

          expect(
            yield* holds.lift({ hold: 'ENVIRONMENT', why: 'PROBE_OK' }),
          ).toBe(true)
          const afterProbe = yield* holds.current
          expect(afterProbe.on.map(({ hold }) => hold)).toEqual([
            'USAGE_LIMIT',
            'CREDENTIALS',
          ])
          expect(yield* look).toEqual(
            MayTake.Held({
              hold: 'USAGE_LIMIT',
              why: "anthropic's usage limit",
            }),
          )
          // Another provider's hold of the same kind isn't this one.
          expect(
            yield* holds.lift({
              hold: 'CREDENTIALS',
              provider: 'anthropic',
              why: 'a new key',
            }),
          ).toBe(false)
          expect(
            yield* holds.lift({
              hold: 'USAGE_LIMIT',
              provider: 'anthropic',
              why: "anthropic's reset passed",
            }),
          ).toBe(true)
          const afterReset = yield* holds.current
          expect(clockHeld(afterReset)).toBe(false)
          expect(banners(afterReset)).toEqual([
            "HOLD: CREDENTIALS (openai): openai's key was refused",
          ])
          expect((yield* look)._tag).toBe('Held')
          yield* holds.lift({
            hold: 'CREDENTIALS',
            provider: 'openai',
            why: 'a new key',
          })
          expect(yield* look).toEqual(MayTake.Yes())
          return seen
        }),
      )
      expect(result).toEqual(['Held', 'Held', 'Yes'])
      expect(holdTexts(events)).toEqual([
        'HOLD: ENVIRONMENT: 3 tickets in a row settled idle; no new tickets while the 2 running finish',
        "HOLD: USAGE_LIMIT: anthropic's usage limit; no new tickets while the 2 running finish",
        "HOLD: CREDENTIALS: openai's key was refused; no new tickets while the 2 running finish",
        'ENVIRONMENT lifted: PROBE_OK',
        "USAGE_LIMIT lifted: anthropic's reset passed",
        'CREDENTIALS lifted: a new key',
      ])
      expect(ofKind(events, 'hold').map(({ provider }) => provider)).toEqual([
        undefined,
        'anthropic',
        'openai',
        undefined,
        'anthropic',
        'openai',
      ])
    }),
  )

  it('takes no work while draining, and names the first hold raised before the drain', () => {
    const none = { on: [], gaveUp: Option.none() }
    expect(mayTake({ holds: none, draining: false })).toEqual(MayTake.Yes())
    expect(mayTake({ holds: none, draining: true })._tag).toBe('Held')
    expect(
      mayTake({
        holds: {
          on: [
            {
              hold: 'MACHINE',
              provider: Option.none(),
              why: 'the machine is full',
              since: 0,
            },
          ],
          gaveUp: Option.none(),
        },
        draining: true,
      }),
    ).toEqual(MayTake.Held({ hold: 'MACHINE', why: 'the machine is full' }))
  })

  it.effect('keeps the first hold to give up as the run stopping', () =>
    Effect.gen(function* () {
      const { result } = yield* withLog(log =>
        Effect.gen(function* () {
          const holds = yield* makeHolds({ log, running: Effect.succeed(0) })
          expect(Option.isNone(stopping(yield* holds.current))).toBe(true)
          expect(
            yield* holds.giveUp({
              kind: 'ENVIRONMENT',
              ticket: Option.none(),
              detail: 'the probe failed',
            }),
          ).toBe(true)
          expect(
            yield* holds.giveUp({
              kind: 'USAGE_LIMIT',
              ticket: Option.none(),
              detail: 'later',
            }),
          ).toBe(false)
          return stopping(yield* holds.current)
        }),
      )
      expect(Option.map(result, ({ kind }) => kind)).toEqual(
        Option.some('ENVIRONMENT'),
      )
    }),
  )
})

describe("the environment hold's count", () => {
  it('trips on tickets in a row settling idle, a session not starting among them', () => {
    const count = [
      idle(one),
      Settle.Idle({ ticket: two, why: "its session didn't start: no Pi" }),
    ].reduce(counted, noCount)
    expect(Option.isNone(tripped(count))).toBe(true)
    const trip = tripped(counted(count, idle(three)))
    expect(Option.map(trip, ({ tickets }) => tickets)).toEqual(
      Option.some([one, two, three]),
    )
  })

  it('trips on setups failing one after another', () => {
    const count = [one, two, three]
      .map(ticket => Settle.SetupFailed({ ticket }))
      .reduce(counted, noCount)
    expect(
      Option.map(tripped(count), ({ why, tickets }) => ({ why, tickets })),
    ).toEqual(
      Option.some({
        why: "3 tickets' setups failed one after another",
        tickets: [one, two, three],
      }),
    )
  })

  it('ends a series on a ticket that worked, and counts nothing it leaves uncounted', () => {
    const broken = [idle(one), idle(two), Settle.Worked(), idle(three)].reduce(
      counted,
      noCount,
    )
    expect(Option.isNone(tripped(broken))).toBe(true)
    const kept = [idle(one), idle(two), Settle.Uncounted(), idle(three)].reduce(
      counted,
      noCount,
    )
    expect(Option.isSome(tripped(kept))).toBe(true)
  })

  it("counts an end as the hold's rules say", () => {
    const of = (
      end: WorkerEnd,
      facts: Partial<{
        quick: boolean
        changed: boolean
        providerHeld: boolean
      }> = {},
    ) =>
      settleOf({
        ticket: one,
        end,
        quick: true,
        changed: false,
        providerHeld: false,
        ...facts,
      })._tag
    expect(of(WorkerEnd.Unfinished())).toBe('Idle')
    expect(of(WorkerEnd.Unfinished(), { changed: true })).toBe('Worked')
    expect(of(WorkerEnd.Unfinished(), { quick: false })).toBe('Worked')
    // A refused credential, or a usage limit, holding the run: not counted.
    expect(of(WorkerEnd.Unfinished(), { providerHeld: true })).toBe('Uncounted')
    // A ticket stopped by a blocker closed and not merged waits for it: not counted.
    expect(of(WorkerEnd.WaitsFor({ ticket: two, needs: 'its API' }))).toBe(
      'Uncounted',
    )
    expect(of(WorkerEnd.SetupFailed({ detail: 'exit 1' }))).toBe('SetupFailed')
    expect(of(WorkerEnd.Deferred({ reason: 'a decision' }))).toBe('Worked')
    // A start failure is the supervisor's to count, once no model is left.
    expect(of(WorkerEnd.NotStarted({ reason: 'no Pi' }))).toBe('Uncounted')
  })
})

/** The environment hold over a fresh run log, its probe answering `answer`, what it did kept. */
const environmentHold = (answer: ProbeOutcome) =>
  Effect.gen(function* () {
    const log = yield* RunLog
    const holds = yield* makeHolds({ log, running: Effect.succeed(0) })
    const reopened = yield* Ref.make<ReadonlyArray<TicketId>>([])
    const probes = yield* Ref.make(0)
    const freed = yield* Ref.make(0)
    const freedOnce = yield* Deferred.make<void>()
    const environment = yield* makeEnvironmentHold({
      holds,
      log,
      sleep: Effect.sleep,
      agent: Effect.die('the minimal agent is the probe override'),
      reopen: tickets => Ref.update(reopened, kept => [...kept, ...tickets]),
      probed: Effect.andThen(
        Ref.update(freed, n => n + 1),
        Deferred.succeed(freedOnce, undefined),
      ),
    }).pipe(
      Effect.provideService(EnvironmentProbe, {
        probe: () =>
          Effect.as(
            Ref.update(probes, n => n + 1),
            answer,
          ),
      }),
    )
    return { holds, environment, reopened, probes, freed, freedOnce }
  })

describe('the environment hold', () => {
  it.effect(
    'holds the run, probes after env_probe and lifts on PROBE_OK, leaving the usage limit on',
    () =>
      Effect.gen(function* () {
        const { result, events } = yield* withLog(() =>
          Effect.gen(function* () {
            const { holds, environment, reopened, probes, freed, freedOnce } =
              yield* environmentHold(ProbeOutcome.Passed())
            yield* environment.settled(idle(one))
            yield* environment.settled(idle(two))
            expect((yield* holds.current).on).toEqual([])
            yield* environment.settled(idle(three))
            expect((yield* holds.current).on.map(({ hold }) => hold)).toEqual([
              'ENVIRONMENT',
            ])
            expect(yield* Ref.get(reopened)).toEqual([one, two, three])
            // While it holds, an idle ticket waits for the probe too.
            yield* environment.settled(idle(four))
            expect(yield* Ref.get(reopened)).toEqual([one, two, three, four])
            yield* holds.raise({
              hold: 'USAGE_LIMIT',
              provider: 'anthropic',
              why: "anthropic's usage limit",
            })
            yield* TestClock.adjust(
              Duration.subtract(ENV_PROBE, Duration.seconds(1)),
            )
            expect(yield* Ref.get(probes)).toBe(0)
            yield* TestClock.adjust('1 second')
            yield* Deferred.await(freedOnce)
            yield* holds.lifted({ hold: 'ENVIRONMENT' })
            expect(yield* Ref.get(probes)).toBe(1)
            expect(yield* Ref.get(freed)).toBe(1)
            return (yield* holds.current).on.map(({ hold }) => hold)
          }).pipe(Effect.scoped),
        )
        expect(result).toEqual(['USAGE_LIMIT'])
        expect(holdTexts(events)).toEqual([
          'HOLD: ENVIRONMENT: 3 tickets in a row settled within minutes without changing anything (the last, fa-a3: its worker settled with no outcome); probing the machine in 10m',
          "HOLD: USAGE_LIMIT: anthropic's usage limit",
          'PROBE_OK',
          "ENVIRONMENT lifted: PROBE_OK: the probe's agent started and its model answered",
        ])
      }),
  )

  it.effect('gives up when the probe fails: the run stops, exit 7', () =>
    Effect.gen(function* () {
      const { result } = yield* withLog(() =>
        Effect.gen(function* () {
          const { holds, environment, freed } = yield* environmentHold(
            ProbeOutcome.Failed({ reason: 'Pi did not start' }),
          )
          for (const ticket of [one, two, three])
            yield* environment.settled(Settle.SetupFailed({ ticket }))
          yield* TestClock.adjust(ENV_PROBE)
          yield* holds.lifted({ hold: 'ENVIRONMENT' })
          expect(yield* Ref.get(freed)).toBe(0)
          return yield* holds.current
        }).pipe(Effect.scoped),
      )
      const gaveUp = Option.getOrThrow(stopping(result))
      expect(gaveUp.kind).toBe('ENVIRONMENT')
      expect(gaveUp.detail).toBe(
        'the environment probe failed: Pi did not start',
      )
      expect(exitCodeOf(gaveUp.kind)).toBe(7)
      // It stays on: the run ends holding.
      expect(result.on.map(({ hold }) => hold)).toEqual(['ENVIRONMENT'])
    }),
  )

  it.effect(
    "counts a session that didn't start, and not a refused credential",
    () =>
      Effect.gen(function* () {
        yield* withLog(() =>
          Effect.gen(function* () {
            const { holds, environment, reopened } = yield* environmentHold(
              ProbeOutcome.Passed(),
            )
            const scope = yield* Effect.scope
            const routed = supervisorHolds({
              holds,
              environment,
              usage: { refused: () => Effect.void, waitOut: () => Effect.void },
              retry: Duration.minutes(15),
              sleep: Effect.sleep,
              fork: effect => Effect.asVoid(Effect.forkIn(effect, scope)),
            })
            yield* environment.settled(idle(one))
            yield* routed.startFailed({ ticket: two, reason: 'no Pi' })
            // The refused credential holds the run for its provider, its worker waiting on the hold.
            const waiting = yield* Effect.forkScoped(
              routed.credentialRefused({
                ticket: three,
                provider: 'anthropic',
                reason: 'OAuth session expired',
              }),
            )
            yield* holds.changes.pipe(
              Stream.filter(snapshot => anyOn(snapshot, 'CREDENTIALS')),
              Stream.runHead,
            )
            expect((yield* holds.current).on.map(({ hold }) => hold)).toEqual([
              'CREDENTIALS',
            ])
            expect(yield* Ref.get(reopened)).toEqual([])
            yield* routed.startFailed({ ticket: four, reason: 'no Pi' })
            expect((yield* holds.current).on.map(({ hold }) => hold)).toEqual([
              'CREDENTIALS',
              'ENVIRONMENT',
            ])
            expect(yield* Ref.get(reopened)).toEqual([one, two, four])
            yield* TestClock.adjust(Duration.minutes(15))
            yield* Fiber.join(waiting)
            // The credentials' lift leaves the environment hold on.
            expect((yield* holds.current).on.map(({ hold }) => hold)).toEqual([
              'ENVIRONMENT',
            ])
          }).pipe(Effect.scoped),
        )
      }),
  )
})

/** Waits for the first record from `records` that `found` takes. */
const until = (
  records: PubSub.Subscription<RunEvent>,
  found: (event: RunEvent) => boolean,
) =>
  Effect.gen(function* () {
    while (true) if (found(yield* PubSub.take(records))) return
  })

/**
 * Runs the project with its probe answering as `probe` does: once the environment hold is on, the
 * clock moves on past `env_probe` until it has probed; the run's end.
 */
const runHeld = (
  fixture: ReturnType<typeof project>,
  probe: Effect.Effect<ProbeOutcome, never, WorkGraph>,
) =>
  Effect.gen(function* () {
    const graph = yield* WorkGraph
    const records = yield* (yield* RunLog).subscribe
    const running = yield* Effect.forkChild(
      runProject(configOf(fixture, options()), yield* makeRunControl).pipe(
        Effect.provideService(EnvironmentProbe, {
          probe: () => Effect.provideService(probe, WorkGraph, graph),
        }),
      ),
    )
    yield* until(
      records,
      event => event.kind === 'hold' && event.hold === 'ENVIRONMENT',
    )
    // The probe's wait begins as the hold's tickets are put back: the clock moves on until it probed.
    const probed = yield* Effect.forkChild(
      until(records, event => event.kind === 'probed' || event.kind === 'stop'),
    )
    while (probed.pollUnsafe() === undefined) {
      yield* TestClock.adjust(ENV_PROBE)
      yield* TestClock.withLive(Effect.sleep('50 millis'))
    }
    return yield* Fiber.join(running)
  })

describe('a run held for its environment', () => {
  it.effect(
    'ends with exit 7 when the probe fails',
    () => {
      const fixture = project({ ...settings, concurrent: 3 })
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const tickets = yield* Effect.forEach(
            ['One', 'Two', 'Three'],
            title => Effect.map(file(title, 'nothing'), ({ id }) => id),
          )
          const end = yield* runHeld(
            fixture,
            Effect.succeed(ProbeOutcome.Failed({ reason: 'Pi did not start' })),
          )
          expect(end).toEqual({ kind: 'ENVIRONMENT', code: 7 })
          const events = yield* eventsOf(fixture)
          expect(ofKind(events, 'hold').map(({ hold }) => hold)).toEqual([
            'ENVIRONMENT',
          ])
          expect(
            ofKind(events, 'reopened')
              .map(({ ticket }) => ticket)
              .toSorted(),
          ).toEqual([...tickets].toSorted())
          expect(ofKind(events, 'dispatch')).toHaveLength(3)
          expect(ofKind(events, 'stop').map(({ text }) => text)).toEqual([
            'ENVIRONMENT: the environment probe failed: Pi did not start',
          ])
        }),
      )
    },
    // Three dispatches, each a process of its own.
    30_000,
  )

  it.effect(
    'goes on after PROBE_OK: the tickets it put back are taken again',
    () => {
      const fixture = project({ ...settings, concurrent: 3 })
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const graph = yield* WorkGraph
          const tickets = yield* Effect.forEach(
            ['One', 'Two', 'Three'],
            title => Effect.map(file(title, 'nothing'), ({ id }) => id),
          )
          // The machine is mended while the run holds: the tickets' workers finish once taken again.
          const mended = Effect.as(
            Effect.forEach(
              tickets,
              id =>
                Effect.orDie(
                  graph.update({
                    id,
                    changes: { description: Option.some('stub: finish') },
                    actor: maintainer,
                  }),
                ),
              { discard: true },
            ),
            ProbeOutcome.Passed(),
          )
          const end = yield* runHeld(fixture, mended)
          expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
          const events = yield* eventsOf(fixture)
          expect(holdTexts(events)).toEqual([
            expect.stringContaining('HOLD: ENVIRONMENT: 3 tickets in a row'),
            'PROBE_OK',
            "ENVIRONMENT lifted: PROBE_OK: the probe's agent started and its model answered",
          ])
          expect(
            ofKind(events, 'closed')
              .map(({ ticket }) => ticket)
              .toSorted(),
          ).toEqual([...tickets].toSorted())
          for (const id of tickets)
            expect((yield* graph.show(id)).ticket.status).toBe('closed')
        }),
      )
    },
    // Six dispatches and three merges, each a process of its own.
    30_000,
  )
})
