import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  PubSub,
  Scope,
} from 'effect'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  Banner,
  EngineId,
  ProjectId,
  type RunEvent,
  RunHeader,
  RunId,
  RunMode,
} from '@fabrica/contracts'

import { besideCheckout } from '../src/git'
import { asideFolder } from '../src/merge'
import { runProject } from '../src/run'
import { RunLog } from '../src/runlog'
import {
  type RunViewSources,
  type ViewInputs,
  makeRunViewSources,
  projectView,
} from '../src/view'
import {
  binFolder,
  configOf,
  eventsOf,
  file,
  git,
  ofKind,
  options,
  project,
  runOf,
  setUpRuns,
  settings,
  withRuns,
} from './run-harness'

// The run's side of the merge hygiene (spec §13.7, H72): its start deletes what an earlier run moved
// aside and left, without waiting on it; what a merge's setup or check wrote is in its log, and a
// fast-forward waiting on Base's dirty checkout is in its log and on its console (`MERGES_WAIT`) until
// the turn's outcome comes.

beforeAll(setUpRuns)

/** Waits until nothing is at `path`, letting the deletes under way go on between looks. */
const gone = (path: string): Effect.Effect<void> =>
  existsSync(path)
    ? Effect.andThen(
        Effect.promise(() => new Promise(resolve => setImmediate(resolve))),
        Effect.suspend(() => gone(path)),
      )
    : Effect.void

/** Waits for the first record from `records` that `found` takes, and gives it. */
const until = (
  records: PubSub.Subscription<RunEvent>,
  found: (event: RunEvent) => boolean,
) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* PubSub.take(records)
      if (found(event)) return event
    }
  })

describe("a run's merge hygiene", () => {
  it.effect('deletes what an earlier run moved aside as it starts', () =>
    Effect.gen(function* () {
      const fixture = project()
      const aside = asideFolder(besideCheckout(fixture.checkout))
      const left = join(aside, 'fa-old-x1y2z3')
      mkdirSync(join(left, 'worktree', 'node_modules'), { recursive: true })
      writeFileSync(join(left, 'worktree', 'node_modules', 'a.js'), 'a\n')
      const { end } = yield* runOf(fixture, Effect.void)
      expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
      // Deleted beside the start, the run not waiting on it: it may finish after the run's end.
      yield* gone(left)
      expect(existsSync(left)).toBe(false)
    }),
  )

  it.effect(
    "logs what a merge check wrote, and a merge waiting on Base's dirty checkout until it is clean",
    () =>
      Effect.gen(function* () {
        // The merge check writes an untracked file in the worktree and leaves the checkout dirty.
        const check = join(binFolder(), 'check-dirty')
        const fixture = project({ ...settings, check_fast: check })
        writeFileSync(
          check,
          `#!/bin/sh\necho dirty >> '${fixture.checkout}/README.md'\necho made > wrote.txt\necho passing\n`,
        )
        chmodSync(check, 0o755)
        const seen = yield* withRuns(
          fixture,
          Effect.gen(function* () {
            const records = yield* (yield* RunLog).subscribe
            const scope = yield* Scope.Scope
            const sources = yield* makeRunViewSources({
              flush: Duration.millis(50),
              scope,
            })
            const waits =
              yield* Deferred.make<Effect.Effect<Option.Option<string>>>()
            const view: RunViewSources = {
              ...sources.sources,
              attach: parts =>
                Effect.andThen(
                  Deferred.succeed(waits, parts.mergesWait),
                  sources.sources.attach(parts),
                ),
            }
            const ticket = yield* file('Add one', 'finish')
            // Once the run says the merge waits, the view says so too; then the checkout is cleaned.
            const cleaner = yield* Effect.forkChild(
              Effect.gen(function* () {
                yield* until(
                  records,
                  event =>
                    event.kind === 'warn' && event.text.includes('MERGES_WAIT'),
                )
                const during = yield* Effect.flatten(Deferred.await(waits))
                git(fixture.checkout, 'checkout', '--', 'README.md')
                return during
              }),
            )
            const end = yield* runProject(
              configOf(fixture, options()),
              undefined,
              view,
            )
            const during = yield* Fiber.join(cleaner)
            const after = yield* Effect.flatten(Deferred.await(waits))
            const events = yield* eventsOf(fixture)
            return { end, during, after, events, ticket }
          }),
        )
        const { id } = seen.ticket
        const detail = `MERGES_WAIT: ${fixture.checkout} has uncommitted changes to README.md`
        expect(seen.end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        expect(
          ofKind(seen.events, 'warn').filter(({ text }) =>
            text.includes('MERGES_WAIT'),
          ),
        ).toEqual([
          expect.objectContaining({
            ticket: id,
            detail,
            text: `  MERGES_WAIT: ${fixture.checkout} has uncommitted changes to README.md; ${id} merges once it is clean`,
          }),
        ])
        expect(
          ofKind(seen.events, 'info').filter(({ text }) =>
            text.includes('wrote untracked'),
          ),
        ).toEqual([
          expect.objectContaining({
            ticket: id,
            text: `  ${id}: the merge check wrote untracked wrote.txt, recorded; removed with its worktree`,
          }),
        ])
        expect(
          ofKind(seen.events, 'closed').map(({ ticket }) => ticket),
        ).toEqual([id])
        // On the console while it waited, and gone once the merge's outcome came.
        expect(seen.during).toEqual(Option.some(detail))
        expect(seen.after).toEqual(Option.none())
      }),
  )
})

describe("the run view's banners", () => {
  const inputs = (mergesWait: Option.Option<string>): ViewInputs => ({
    header: new RunHeader({
      run: RunId.make('2026-10-30T09:00:00+01:00'),
      project: ProjectId.make('work'),
      engine: EngineId.make('engine-1'),
      mode: RunMode.cases.tickets.make({}),
      state: 'running',
      startedAt: DateTime.makeUnsafe(0),
      offline: false,
      autoAnswer: false,
    }),
    now: DateTime.makeUnsafe(1000),
    tickets: [],
    facts: new Map(),
    slots: 2,
    line: { merging: Option.none(), waiting: [] },
    mergesWait,
    workers: [],
    steps: [],
    doneToday: 0,
    tokens: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
    holds: [],
    attention: [],
    load: Option.none(),
  })
  const text = 'MERGES_WAIT: /work/repo has uncommitted changes to src/a.ts'

  it('warn while merges wait on the checkout, and clear once they go on', () => {
    const clean = projectView(inputs(Option.none()), Option.none())
    expect(clean.banners).toEqual([])
    const waiting = projectView(inputs(Option.some(text)), Option.some(clean))
    expect(waiting.banners).toEqual([
      new Banner({ tone: 'warning', text, lifts: Option.none() }),
    ])
    // The same wait again keeps its banners as they were.
    const still = projectView(inputs(Option.some(text)), Option.some(waiting))
    expect(still.banners).toBe(waiting.banners)
    expect(
      projectView(inputs(Option.none()), Option.some(still)).banners,
    ).toEqual([])
  })
})
