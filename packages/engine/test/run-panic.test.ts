import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Stream,
} from 'effect'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  Assignee,
  CommandSetting,
  CommitHash,
  EngineId,
  type RunEvent,
  SessionId,
  defaultSetupFiles,
} from '@fabrica/contracts'

import { Checks } from '../src/checks'
import { Worktrees, besideCheckout } from '../src/git'
import { MergeOutcome, make as makeQueue, noSetup } from '../src/merge'
import { HandBackWorker } from '../src/merge/handbacks'
import { runProject } from '../src/run'
import {
  type EventDraft,
  RecordInvalid,
  RunLog,
  readEvents,
} from '../src/runlog'
import { StoreFailed, WorkGraph } from '../src/workgraph'
import {
  type Project,
  commit,
  configOf,
  eventsOf,
  file,
  git,
  ofKind,
  options,
  project,
  setUpRuns,
  withRuns,
} from './run-harness'

// A run ends `PANIC` on a defect anywhere in it, and `TRACKER_FAILED` where the work graph can't be
// watched, its end record written (spec §13.11, §13.2): the merge queue and its updates, the work graph's
// changes, a look and the end itself. Whole runs on the harness, the records a test's defect comes from refused
// by the log, as a schema refuses one, and the work graph's changes failed where a test says.

beforeAll(setUpRuns)

/** The run's log, the drafts `refused` says refused as their schema would: a defect where they're written. */
const refusing = (refused: (draft: EventDraft) => boolean) =>
  Layer.effect(
    RunLog,
    Effect.map(RunLog, log =>
      RunLog.of({
        ...log,
        emit: (draft, details) =>
          refused(draft)
            ? Effect.fail(
                new RecordInvalid({ kind: draft.kind, reason: 'refused' }),
              )
            : log.emit(draft, details),
      }),
    ),
  )

/** The run's log, `seen` told of each record's kind as it's written. */
const noting = (seen: (kind: RunEvent['kind']) => Effect.Effect<void>) =>
  Layer.effect(
    RunLog,
    Effect.map(RunLog, log =>
      RunLog.of({
        ...log,
        emit: (draft, details) =>
          Effect.tap(log.emit(draft, details), () => seen(draft.kind)),
      }),
    ),
  )

/** The run's work graph, its changes `changes` where they're asked for. */
const changing = (changes: WorkGraph['Service']['changes']) =>
  Layer.effect(
    WorkGraph,
    Effect.map(WorkGraph, graph => WorkGraph.of({ ...graph, changes })),
  )

const storeFailed = new StoreFailed({
  operation: 'changes',
  reason: 'the store went',
})

const refused = (kind: RunEvent['kind']) =>
  refusing(draft => draft.kind === kind)

/** Runs the project on `layer`, its end and its records. */
const ended = <A, E>(
  fixture: Project,
  setup: Effect.Effect<A, E, WorkGraph>,
  layer: Layer.Layer<never, never, RunLog | WorkGraph | Checks>,
) =>
  withRuns(
    fixture,
    Effect.gen(function* () {
      yield* setup
      const end = yield* runProject(configOf(fixture, options())).pipe(
        Effect.provide(layer),
      )
      return { end, events: yield* eventsOf(fixture) }
    }),
  )

/**
 * The run's watcher given a ticket that works until it's stopped: its work graph's changes end as
 * `changes` says once the ticket is dispatched, so the run is going as they do.
 */
const endedWatching = (
  fixture: Project,
  changes: Stream.Stream<never, StoreFailed>,
  refuses: (draft: EventDraft) => boolean = () => false,
) =>
  Effect.gen(function* () {
    const dispatched = yield* Deferred.make<void>()
    return yield* ended(
      fixture,
      file('Works on', 'hang'),
      Layer.merge(
        Layer.provide(
          refusing(refuses),
          noting(kind =>
            kind === 'dispatch'
              ? Effect.asVoid(Deferred.succeed(dispatched, undefined))
              : Effect.void,
          ),
        ),
        changing(
          Effect.succeed(
            Stream.fromEffect(Deferred.await(dispatched)).pipe(
              Stream.flatMap(() => changes),
            ),
          ),
        ),
      ),
    )
  })

/** That the run ended as `kind` with `code`, by one stop and its `end`, the end its last record. */
const expectEnded = (
  { end, events }: Effect.Success<ReturnType<typeof ended>>,
  kind: string,
  code: number,
) => {
  expect(end).toEqual({ kind, code })
  expect(ofKind(events, 'stop').map(stop => stop.detail)).toEqual([kind])
  expect(ofKind(events, 'end').map(record => record.code)).toEqual([code])
  expect(events.at(-1)?.kind).toBe('end')
}

describe('a defect outside the workers', () => {
  it.effect(
    "stops the run with the ticket when a merge's update dies on a refused record",
    () =>
      Effect.gen(function* () {
        const run = yield* ended(
          project(),
          file('Merges', 'finish'),
          refused('closed'),
        )
        expectEnded(run, 'PANIC', 4)
        const [stop] = ofKind(run.events, 'stop')
        expect(stop?.ticket).toBeDefined()
        expect(stop?.text).toContain('RecordInvalid')
      }),
  )

  it.effect(
    "stops the run TRACKER_FAILED when the work graph's changes fail",
    () =>
      Effect.gen(function* () {
        const run = yield* endedWatching(project(), Stream.fail(storeFailed))
        expectEnded(run, 'TRACKER_FAILED', 4)
        expect(ofKind(run.events, 'stop')[0]?.text).toContain('the store went')
        // The end went its way: the ticket's worker stopped, its part ended.
        expect(
          ofKind(run.events, 'ticket_end').map(({ outcome }) => outcome),
        ).toEqual(['stopped'])
      }),
  )

  it.effect("stops the run PANIC when the work graph's changes die", () =>
    Effect.gen(function* () {
      const run = yield* endedWatching(project(), Stream.die('a bug'))
      expectEnded(run, 'PANIC', 4)
      expect(ofKind(run.events, 'stop')[0]?.text).toContain(
        "the work graph's changes",
      )
    }),
  )

  it.effect("ends PANIC through the run's end when a look dies", () =>
    Effect.gen(function* () {
      const run = yield* ended(
        project(),
        file('Is dispatched', 'finish'),
        refused('dispatch'),
      )
      expectEnded(run, 'PANIC', 4)
      expect(ofKind(run.events, 'stop')[0]?.text).toContain("the run's look")
      expect(
        ofKind(run.events, 'ticket_end').map(({ outcome }) => outcome),
      ).toEqual(['stopped'])
    }),
  )

  it.effect('ends PANIC when the end dies, its end line refused', () =>
    Effect.gen(function* () {
      const run = yield* ended(project(), Effect.void, refused('done'))
      expectEnded(run, 'PANIC', 4)
      expect(ofKind(run.events, 'stop')[0]?.text).toContain("the run's end")
    }),
  )

  it.effect(
    'still writes its end when going through the end again dies too',
    () =>
      Effect.gen(function* () {
        let stops = 0
        const run = yield* ended(
          project(),
          Effect.void,
          refusing(draft => {
            if (draft.kind === 'done') return true
            if (draft.kind !== 'stop') return false
            stops += 1
            return stops === 1
          }),
        )
        expect(stops).toBe(2)
        expectEnded(run, 'PANIC', 4)
      }),
  )

  it.effect(
    "writes a ticket's ticket_end once when the end goes through again",
    () =>
      Effect.gen(function* () {
        let ends = 0
        const { end, events } = yield* endedWatching(
          project(),
          Stream.fail(storeFailed),
          draft => {
            if (draft.kind !== 'end') return false
            ends += 1
            return ends === 1
          },
        )
        expect(end).toEqual({ kind: 'PANIC', code: 4 })
        expect(ofKind(events, 'stop').map(stop => stop.detail)).toEqual([
          'TRACKER_FAILED',
          'PANIC',
        ])
        expect(
          ofKind(events, 'ticket_end').map(({ outcome }) => outcome),
        ).toEqual(['stopped'])
        expect(ofKind(events, 'end').map(record => record.code)).toEqual([4])
      }),
  )

  it.effect(
    'stops the run with the ticket when its turn in the merge queue dies',
    () =>
      Effect.gen(function* () {
        const run = yield* ended(
          project(),
          file('Merges', 'finish'),
          Layer.effect(
            Checks,
            Effect.map(Checks, checks =>
              Checks.of({
                ...checks,
                run: input =>
                  input.suite === 'merge'
                    ? Effect.die('a bug')
                    : checks.run(input),
              }),
            ),
          ),
        )
        expectEnded(run, 'PANIC', 4)
        const [stop] = ofKind(run.events, 'stop')
        expect(stop?.ticket).toBeDefined()
        expect(stop?.text).toContain('a bug')
      }),
  )

  it.effect('stops merging with the ticket when its hand-back dies', () =>
    Effect.gen(function* () {
      const fixture = project()
      const update = yield* withRuns(
        fixture,
        Effect.gen(function* () {
          const graph = yield* WorkGraph
          const worktrees = yield* Worktrees
          const actor: Actor = { _tag: 'maintainer' }
          const { id: ticket } = yield* file('Conflicts', 'finish')
          const { worktree } = yield* worktrees.prepare({
            home: besideCheckout(fixture.checkout),
            ticket,
            base: CommitHash.make(git(fixture.checkout, 'rev-parse', 'main')),
          })
          commit(worktree.path, 'the change', { 'README.md': 'ours\n' })
          commit(fixture.checkout, 'Base too', { 'README.md': 'theirs\n' })
          yield* graph.claim({
            id: ticket,
            assignee: new Assignee({
              engine: EngineId.make('engine-1'),
              session: SessionId.make('session-1'),
            }),
            actor,
          })
          const merges = yield* makeQueue({
            home: besideCheckout(fixture.checkout),
            base: 'main',
            checkFast: CommandSetting.cases.Command.make({
              command: 'check-pass',
            }),
            checkTimeout: Duration.minutes(1),
            setupFiles: defaultSetupFiles,
            handBacks: { resolve: 2, fix: 2, timeout: Duration.minutes(20) },
            train: 0,
            cores: 1,
            actor,
          }).pipe(
            Effect.provideService(HandBackWorker, {
              give: () => Effect.die('a bug'),
              tell: () => Effect.void,
            }),
            Effect.provide(noSetup),
          )
          const updates = yield* merges.updates
          const collected = yield* Effect.forkChild(
            Stream.runCollect(
              Stream.takeUntil(updates, MergeOutcome.$is('Stopped')),
            ),
          )
          yield* merges.enqueue(worktree)
          return (yield* Fiber.join(collected)).at(-1)
        }),
      )
      expect(update).toMatchObject({ _tag: 'Stopped', kind: 'PANIC' })
    }),
  )

  it.effect('ends PANIC when the run dies before its loop', () =>
    Effect.gen(function* () {
      const fixture = project()
      const run = yield* ended(fixture, Effect.void, refused('start'))
      expectEnded(run, 'PANIC', 4)
    }),
  )

  it.effect(
    "ends TRACKER_FAILED when the work graph's changes can't be watched at all",
    () =>
      Effect.gen(function* () {
        const run = yield* ended(
          project(),
          Effect.void,
          changing(Effect.fail(storeFailed)),
        )
        expectEnded(run, 'TRACKER_FAILED', 4)
      }),
  )

  it.effect("writes no end for a run interrupted: it's no panic", () =>
    Effect.gen(function* () {
      const fixture = project()
      const dispatched = yield* Deferred.make<void>()
      yield* withRuns(
        fixture,
        Effect.gen(function* () {
          yield* file('Works on', 'hang')
          const fiber = yield* runProject(configOf(fixture, options())).pipe(
            Effect.provide(
              noting(kind =>
                kind === 'dispatch'
                  ? Effect.asVoid(Deferred.succeed(dispatched, undefined))
                  : Effect.void,
              ),
            ),
            Effect.forkChild,
          )
          yield* Deferred.await(dispatched)
          const exit = yield* Fiber.interrupt(fiber).pipe(
            Effect.andThen(Fiber.await(fiber)),
          )
          expect(
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
          ).toBe(true)
          const { events } = yield* readEvents({
            root: fixture.checkout,
            run: Option.none(),
          })
          expect(ofKind(events, 'stop')).toEqual([])
          expect(ofKind(events, 'end')).toEqual([])
        }),
      )
    }),
  )
})
