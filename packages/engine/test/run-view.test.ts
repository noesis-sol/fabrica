import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Ref,
  Scope,
  Stream,
} from 'effect'
import { TestClock } from 'effect/testing'

import { describe, expect, it } from '@effect/vitest'
import {
  EngineId,
  EngineStep,
  Phase,
  ProjectId,
  Resume,
  RunHeader,
  RunId,
  RunMode,
  type RunView,
  SessionId,
  StreamEpoch,
  TicketId,
  applyRunViewPatch,
} from '@fabrica/contracts'

import type { Agent } from '../src/agent'
import {
  Delivered,
  type RunViewItem,
  type ViewInputs,
  actionOf,
  keptViewPatches,
  makeRunView,
  makeSteps,
  makeViewFeed,
  makeWorkerDesk,
  projectView,
  stepElapsedMillis,
  viewPatch,
} from '../src/view'

// The run view (spec §8.3, H40, H55, H80): written by its own fiber at most every `view_interval`,
// published only when a part changed, every unchanged part and row keeping its identity; streamed as
// a snapshot then numbered patches, resumable after a sequence number; every engine step in it with
// its start time; Done today read again as the host's day changes; and the maintainer's message to a
// worker whose ticket merges held for its next turn (H59). Every test runs on TestClock.

const project = ProjectId.make('work')
const first = TicketId.make('wk-a1')
const second = TicketId.make('wk-b2')

const header = new RunHeader({
  run: RunId.make('2026-10-30T09:00:00+01:00'),
  project,
  engine: EngineId.make('engine-1'),
  mode: RunMode.cases.tickets.make({}),
  state: 'running',
  startedAt: DateTime.makeUnsafe(0),
  offline: false,
  autoAnswer: false,
})

const interval = Duration.millis(50)

const inputsOf = (overrides: Partial<ViewInputs> = {}): ViewInputs => ({
  header,
  now: DateTime.makeUnsafe(1000),
  tickets: [
    {
      ticket: first,
      title: 'Add the page',
      phase: Phase.cases.working.make({}),
      dispatched: true,
    },
    {
      ticket: second,
      title: 'Fix the link',
      phase: Phase.cases.queued.make({}),
      dispatched: false,
    },
  ],
  facts: new Map(),
  slots: 2,
  line: { merging: Option.none(), waiting: [] },
  workers: [],
  steps: [],
  doneToday: 0,
  tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
  holds: [],
  attention: [],
  load: Option.none(),
  ...overrides,
})

/** A work graph with `done` tickets done today, whose changes never come; its reads counted. */
const graphOf = (done: Ref.Ref<number>, reads: Ref.Ref<number>) => ({
  doneSince: () =>
    Effect.andThen(
      Ref.update(reads, n => n + 1),
      Ref.get(done),
    ),
  changes: Effect.succeed(Stream.never),
})

/** A run view in `scope`, its items collected as they come. */
const viewIn = Effect.fn(function* (
  scope: Scope.Scope,
  given?: ReturnType<typeof graphOf>,
  every = interval,
) {
  const graph = given ?? graphOf(yield* Ref.make(0), yield* Ref.make(0))
  const view = yield* makeRunView({
    header: Effect.succeed(header),
    interval: every,
    flush: interval,
    graph,
    scope,
  }).pipe(
    Effect.provideService(DateTime.CurrentTimeZone, DateTime.zoneMakeOffset(0)),
  )
  const items = yield* Queue.unbounded<RunViewItem>()
  yield* view.watch(Option.none()).pipe(
    Stream.runForEach(item => Queue.offer(items, item)),
    Effect.forkIn(scope),
  )
  yield* Effect.yieldNow
  /** The items come since the last take. */
  const taken = Effect.map(Queue.clear(items), all => [...all])
  return { view, taken }
})

/** The patches among `items`. */
const patchesOf = (items: ReadonlyArray<RunViewItem>) =>
  items.flatMap(item => (item._tag === 'patch' ? [item] : []))

describe('the run view', () => {
  it.effect(
    'is written at most every view_interval: changes within one interval cross as one patch',
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const { view, taken } = yield* viewIn(scope)
        expect((yield* taken).map(item => item._tag)).toEqual(['snapshot'])

        yield* TestClock.adjust(Duration.millis(10))
        yield* view.sources.steps
          .during(
            'setup',
            first,
          )(Effect.never)
          .pipe(Effect.forkIn(scope))
        yield* TestClock.adjust(Duration.millis(39))
        expect(yield* taken).toEqual([])

        yield* TestClock.adjust(Duration.millis(1))
        const once = yield* taken
        expect(patchesOf(once).map(({ seq }) => seq)).toEqual([1])
        expect(once[0]?.value).toMatchObject({
          steps: [{ step: 'setup', ticket: Option.some(first) }],
        })

        // Two steps begun 10 ms apart, both after a write: one patch, at the next.
        yield* TestClock.adjust(Duration.millis(10))
        yield* view.sources.steps
          .during('install')(Effect.never)
          .pipe(Effect.forkIn(scope))
        yield* TestClock.adjust(Duration.millis(10))
        yield* view.sources.steps
          .during('report')(Effect.never)
          .pipe(Effect.forkIn(scope))
        yield* TestClock.adjust(Duration.millis(29))
        expect(yield* taken).toEqual([])
        yield* TestClock.adjust(Duration.millis(1))
        const next = patchesOf(yield* taken)
        expect(next.map(({ seq }) => seq)).toEqual([2])
        expect(next[0]?.value.steps?.map(({ step }) => step)).toEqual([
          'setup',
          'install',
          'report',
        ])
        yield* Scope.close(scope, Exit.void)
      }),
  )

  it.effect('publishes nothing while nothing changes', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const { taken } = yield* viewIn(scope)
      expect((yield* taken).map(item => item._tag)).toEqual(['snapshot'])
      yield* TestClock.adjust(Duration.seconds(5))
      expect(yield* taken).toEqual([])
    }),
  )

  it.effect('keeps every unchanged part and row the value it was', () =>
    Effect.sync(() => {
      const before = projectView(inputsOf(), Option.none())
      const after = projectView(
        inputsOf({
          now: DateTime.makeUnsafe(2000),
          tickets: [
            {
              ticket: first,
              title: 'Add the page',
              phase: Phase.cases.verifying.make({ round: 1 }),
              dispatched: true,
            },
            {
              ticket: second,
              title: 'Fix the link',
              phase: Phase.cases.queued.make({}),
              dispatched: false,
            },
          ],
        }),
        Option.some(before),
      )
      expect(after.header).toBe(before.header)
      expect(after.queue).toBe(before.queue)
      expect(after.steps).toBe(before.steps)
      expect(after.workers).toBe(before.workers)
      expect(after.tickets[1]).toBe(before.tickets[1])
      expect(after.tickets[0]).not.toBe(before.tickets[0])
      expect(after.tickets[0]?.since).toEqual(DateTime.makeUnsafe(2000))
      // Its first dispatch is when the view first saw it dispatched.
      expect(after.tickets[0]?.startedAt).toEqual(
        Option.some(DateTime.makeUnsafe(1000)),
      )

      // The patch names the changed row alone, and the client's copy comes out the same.
      const patch = viewPatch(before, after, DateTime.makeUnsafe(2000))
      expect(Option.map(patch, Object.keys)).toEqual(Option.some(['tickets']))
      expect(
        Option.map(patch, value =>
          value.tickets?.upsert.map(row => row.ticket),
        ),
      ).toEqual(Option.some([first]))
      const applied = Option.map(patch, value =>
        applyRunViewPatch(before, value),
      )
      expect(Option.map(applied, view => view.tickets)).toEqual(
        Option.some(after.tickets),
      )

      // The same inputs again: the same view, and no patch.
      const again = projectView(
        inputsOf({
          now: DateTime.makeUnsafe(3000),
          tickets: [
            {
              ticket: first,
              title: 'Add the page',
              phase: Phase.cases.verifying.make({ round: 1 }),
              dispatched: true,
            },
            {
              ticket: second,
              title: 'Fix the link',
              phase: Phase.cases.queued.make({}),
              dispatched: false,
            },
          ],
        }),
        Option.some(after),
      )
      expect(again.tickets).toBe(after.tickets)
      expect(again.totals).toBe(after.totals)
      expect(
        Option.isNone(viewPatch(after, again, DateTime.makeUnsafe(3000))),
      ).toBe(true)
    }),
  )

  it.effect(
    'counts the hand-backs a ticket had, and shows its merge check as a step',
    () =>
      Effect.sync(() => {
        const at = (millis: number, phase: Phase): ViewInputs =>
          inputsOf({
            now: DateTime.makeUnsafe(millis),
            tickets: [
              { ticket: first, title: 'Add the page', phase, dispatched: true },
            ],
          })
        const resolving = projectView(
          at(1000, Phase.cases.resolving.make({ attempt: 2 })),
          Option.none(),
        )
        const checking = projectView(
          at(4000, Phase.cases.merging.make({ step: 'check' })),
          Option.some(resolving),
        )
        expect(checking.tickets[0]?.handBacks).toEqual({ resolve: 2, fix: 0 })
        expect(checking.steps).toEqual([
          new EngineStep({
            step: 'merge_check',
            ticket: Option.some(first),
            startedAt: DateTime.makeUnsafe(4000),
          }),
        ])
        const still = projectView(
          at(9000, Phase.cases.merging.make({ step: 'check' })),
          Option.some(checking),
        )
        expect(still.steps).toBe(checking.steps)
      }),
  )

  it.effect(
    'resumes after a sequence number, and sends a snapshot to a client of another epoch or too far behind',
    () =>
      Effect.gen(function* () {
        const base = projectView(inputsOf(), Option.none())
        const feed = yield* makeViewFeed(base)
        /** The view with `count` steps, projected from the feed's, as the writer projects it. */
        const withSteps = (count: number) =>
          Effect.map(feed.current, (current): RunView =>
            projectView(
              inputsOf({
                steps: Array.from(
                  { length: count },
                  (_, n) =>
                    new EngineStep({
                      step: 'install',
                      ticket: Option.none(),
                      startedAt: DateTime.makeUnsafe(n),
                    }),
                ),
              }),
              Option.some(current),
            ),
          )
        const publish = (count: number) =>
          Effect.flatMap(withSteps(count), feed.publish)
        for (const count of [1, 2, 3]) yield* publish(count)
        // The same view again takes no number.
        expect(yield* publish(3)).toBe(false)

        const [snapshot] = yield* feed
          .watch(Option.none())
          .pipe(Stream.take(1), Stream.runCollect)
        if (snapshot?._tag !== 'snapshot') return expect.fail('no snapshot')
        expect(snapshot.seq).toBe(3)

        const resumed = yield* feed
          .watch(Option.some(new Resume({ epoch: snapshot.epoch, after: 1 })))
          .pipe(Stream.take(2), Stream.runCollect)
        expect(resumed.map(item => [item._tag, item.seq])).toEqual([
          ['patch', 2],
          ['patch', 3],
        ])
        // The patches applied to the client's view come out the view the engine has.
        const [, second3] = resumed
        expect(second3?.value).toMatchObject({
          steps: (yield* feed.current).steps,
        })

        const elsewhere = yield* feed
          .watch(
            Option.some(
              new Resume({ epoch: StreamEpoch.make('view-other'), after: 1 }),
            ),
          )
          .pipe(Stream.take(1), Stream.runCollect)
        expect(elsewhere.map(item => item._tag)).toEqual(['snapshot'])

        for (let count = 4; count < keptViewPatches + 8; count++)
          yield* publish(count)
        const behind = yield* feed
          .watch(Option.some(new Resume({ epoch: snapshot.epoch, after: 1 })))
          .pipe(Stream.take(1), Stream.runCollect)
        expect(behind.map(item => item._tag)).toEqual(['snapshot'])
      }),
  )

  it.effect(
    'has each step with its start time, so its elapsed time is shown',
    () =>
      Effect.gen(function* () {
        const steps = yield* makeSteps
        yield* TestClock.adjust(Duration.millis(250))
        const fiber = yield* steps
          .during('full_check')(Effect.never)
          .pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust(Duration.millis(1500))
        const [step] = yield* steps.current
        if (step === undefined) return expect.fail('no step')
        expect(step.step).toBe('full_check')
        expect(step.startedAt).toEqual(DateTime.makeUnsafe(250))
        expect(stepElapsedMillis(step, yield* DateTime.now)).toBe(1500)

        yield* Fiber.interrupt(fiber)
        expect(yield* steps.current).toEqual([])
      }),
  )

  it.effect("reads Done today again as the host's day changes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const done = yield* Ref.make(3)
      const reads = yield* Ref.make(0)
      // Written every hour, so that a day on TestClock is few writes.
      const { taken } = yield* viewIn(
        scope,
        graphOf(done, reads),
        Duration.hours(1),
      )
      const [snapshot] = yield* taken
      expect(
        snapshot?._tag === 'snapshot' && snapshot.value.totals.doneToday,
      ).toBe(3)
      expect(yield* Ref.get(reads)).toBe(1)

      yield* Ref.set(done, 0)
      yield* TestClock.adjust(Duration.hours(24))
      expect(yield* Ref.get(reads)).toBe(2)
      const patches = patchesOf(yield* taken)
      expect(patches.map(patch => patch.value.totals?.doneToday)).toEqual([0])
    }),
  )
})

describe("the maintainer's messages to a worker", () => {
  /** A worker's agent whose prompts and steers are kept; a prompt's turn runs until `gate` opens. */
  const agentOf = Effect.fn(function* (
    gate: Option.Option<Deferred.Deferred<void>>,
  ) {
    const prompts = yield* Ref.make<ReadonlyArray<string>>([])
    const steers = yield* Ref.make<ReadonlyArray<string>>([])
    const agent: Agent = {
      ticket: first,
      pid: 1,
      session: { id: SessionId.make('worker-1'), file: Option.none() },
      events: Effect.succeed(Stream.never),
      prompt: text =>
        Ref.update(prompts, all => [...all, text]).pipe(
          Effect.andThen(
            Option.match(gate, {
              onNone: () => Effect.void,
              onSome: Deferred.await,
            }),
          ),
          Effect.as({ disposition: 'started' as const, aborted: false }),
        ),
      steer: text =>
        Effect.as(
          Ref.update(steers, all => [...all, text]),
          'started' as const,
        ),
      abort: Effect.void,
      setModel: () => Effect.void,
      switchSession: () => Effect.succeed(true),
      fork: () => Effect.die('not forked'),
      sessionStats: Effect.die('no stats'),
      exit: Effect.never,
      close: Effect.void,
    }
    return { agent, prompts: Ref.get(prompts), steers: Ref.get(steers) }
  })

  const deskIn = Effect.fn(function* (scope: Scope.Scope) {
    const desk = yield* makeWorkerDesk({ flush: interval, scope })
    yield* desk.enter({
      ticket: first,
      session: SessionId.make('worker-1'),
      model: 'anthropic/claude-opus-5-5',
    })
    return desk
  })

  it.effect(
    'holds a message while its ticket merges, and gives it as the next turn, before the engine prompts again once released',
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const desk = yield* deskIn(scope)
        const { agent, prompts, steers } = yield* agentOf(Option.none())

        const held = yield* desk.message({
          ticket: first,
          text: 'Keep the old route too',
          merging: true,
        })
        expect(Option.map(held, Delivered.$is('Held'))).toEqual(
          Option.some(true),
        )
        expect(yield* steers).toEqual([])
        expect((yield* desk.current).map(worker => worker.steered)).toEqual([
          true,
        ])

        // The merge handed the ticket back: its next turn is the maintainer's message.
        const turns = yield* desk
          .converse({
            ticket: first,
            agent,
            prompt: 'Resolve the conflicts',
            released: 'Carry on',
            settled: Effect.succeed(false),
          })
          .pipe(Effect.scoped, Effect.forkChild)
        yield* Effect.yieldNow
        expect(yield* prompts).toEqual(['Keep the old route too'])

        // Steered, the engine sends it nothing until it is released.
        yield* TestClock.adjust(Duration.seconds(10))
        expect(yield* prompts).toEqual(['Keep the old route too'])
        expect(yield* desk.release(first)).toBe(true)
        yield* Fiber.join(turns)
        expect(yield* prompts).toEqual([
          'Keep the old route too',
          'Resolve the conflicts',
        ])
        expect((yield* desk.current).map(worker => worker.steered)).toEqual([
          false,
        ])

        // The transcript has the maintainer's message and the engine's prompt.
        const [snapshot] = yield* (yield* desk.watchTranscript(
          first,
          Option.none(),
        )).pipe(Option.getOrThrow, Stream.take(1), Stream.runCollect)
        expect(
          snapshot?._tag === 'snapshot' &&
            snapshot.value.flatMap(entry =>
              entry._tag === 'message' ? [[entry.role, entry.text]] : [],
            ),
        ).toEqual([
          ['user', 'Keep the old route too'],
          ['engine', 'Resolve the conflicts'],
        ])
      }),
  )

  it.effect('steers a running turn, but never while its ticket merges', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const desk = yield* deskIn(scope)
      const gate = yield* Deferred.make<void>()
      const { agent, steers } = yield* agentOf(Option.some(gate))
      const settled = yield* Ref.make(false)
      const turns = yield* desk
        .converse({
          ticket: first,
          agent,
          prompt: 'Build the page',
          released: 'Carry on',
          settled: Ref.get(settled),
        })
        .pipe(Effect.scoped, Effect.forkChild)
      yield* Effect.yieldNow

      const steered = yield* desk.message({
        ticket: first,
        text: 'Use the new layout',
        merging: false,
      })
      expect(Option.map(steered, Delivered.$is('Steered'))).toEqual(
        Option.some(true),
      )
      const held = yield* desk.message({
        ticket: first,
        text: 'And the old one',
        merging: true,
      })
      expect(Option.map(held, Delivered.$is('Held'))).toEqual(Option.some(true))
      expect(yield* steers).toEqual(['Use the new layout'])

      // The worker settles its ticket in the turn: no turn of the maintainer's follows.
      yield* Ref.set(settled, true)
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(turns)
      expect(
        yield* desk.message({ ticket: second, text: 'Hello', merging: false }),
      ).toEqual(Option.none())
    }),
  )

  it.effect("reads a worker's latest action from its tool calls", () =>
    Effect.sync(() => {
      const action = actionOf(
        {
          type: 'tool_execution_start',
          toolCallId: 'call-1',
          toolName: 'bash',
          args: { timeout: 30, command: 'pnpm   test\n --run' },
        },
        DateTime.makeUnsafe(5),
      )
      expect(
        Option.map(action, ({ tool, argument }) => [tool, argument]),
      ).toEqual(Option.some(['bash', Option.some('pnpm test --run')]))
      expect(
        Option.isNone(
          actionOf({ type: 'agent_start' }, DateTime.makeUnsafe(5)),
        ),
      ).toBe(true)
    }),
  )
})
