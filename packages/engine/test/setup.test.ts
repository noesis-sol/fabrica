import { Effect, Option, Schema } from 'effect'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { ProjectId, type RunEvent, TicketId } from '@fabrica/contracts'

import { sessionsFolder } from '../src/agent'
import { CheckOutcome, Leftovers, NotRun } from '../src/checks'
import { ExitStatus } from '../src/process'
import { SetupRetry, setupOutcomeOf, setupRetries } from '../src/run/setup'
import {
  type Project,
  commit,
  file,
  ofKind,
  project,
  runOf,
  setUpRuns,
  settings,
} from './run-harness'

// Setup in worktrees (spec §13.8): the project's setup runs in each new worktree before its worker's
// first prompt, and again in a reused one whose rebase brought a setup file; a failing setup puts its
// ticket back until a merge (`SETUP_FAILED`), and the tickets still waiting are named at the run's end
// (`SETUP_WAITS`). Whole runs, as run-core.test.ts runs them, each setup a shell line that leaves a mark
// outside the worktree.

beforeAll(() => {
  setUpRuns()
})

/** The project's settings with `setup`, committed on top of what `project` made. */
const withSetup = (fixture: Project, setup: string, more: object = {}) =>
  commit(fixture.checkout, 'setup', {
    '.fabrica/settings.json': `${JSON.stringify({ ...settings, ...more, setup }, null, 2)}\n`,
  })

/** A file beside the test's checkout, out of every worktree. */
const besideOf = (fixture: Project, name: string) =>
  join(dirname(fixture.checkout), name)

/** A setup line that appends the worktree's ticket to `log`. */
const logging = (log: string) => `basename "$(pwd)" >> ${log}`

/** The tickets the setups logged to `log` ran for, in order. */
const setUpFor = (log: string): ReadonlyArray<string> =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter(line => line !== '')
    : []

/** The setup's `check` records for `ticket`, in order. */
const setupChecksOf = (events: ReadonlyArray<RunEvent>, ticket: TicketId) =>
  ofKind(events, 'check').filter(
    check => check.suite === 'setup' && check.ticket === ticket,
  )

/** One entry of a stub's log, the setup's own among them. */
const Noted = Schema.fromJsonString(Schema.Struct({ event: Schema.String }))

const humanLog = (fixture: Project) =>
  readFileSync(join(fixture.checkout, '.fabrica/fabrica.log'), 'utf8')

describe('setup in worktrees', () => {
  it.effect(
    "runs the setup in a new worktree before its worker's first prompt",
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const sessions = sessionsFolder({
          data: fixture.data,
          project: ProjectId.make('p1'),
        })
        // The setup notes itself where the stub notes its prompt, so the two are in the order they came.
        withSetup(
          fixture,
          `d=${sessions}/$(basename "$(pwd)"); mkdir -p "$d" && echo '{"event":"setup"}' >> "$d/stub.jsonl"`,
        )
        const { end, events, made, ticketOf } = yield* runOf(
          fixture,
          file('Add the parser', 'finish'),
        )
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        const noted = readFileSync(
          join(sessions, made.id, 'stub.jsonl'),
          'utf8',
        )
          .split('\n')
          .filter(line => line !== '')
          .map(line => Schema.decodeUnknownSync(Noted)(line).event)
        expect(noted.slice(0, 2)).toEqual(['setup', 'prompt'])
        expect(setupChecksOf(events, made.id)).toEqual([
          expect.objectContaining({ result: 'passed' }),
        ])
        expect(Option.isSome(ticketOf(made.id).mergedCommit)).toBe(true)
      }),
  )

  it.effect(
    'runs the setup in a new worktree where setup_files names none',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const log = besideOf(fixture, 'setups.log')
        withSetup(fixture, logging(log), { setup_files: [] })
        const { end, made } = yield* runOf(
          fixture,
          file('Add the parser', 'finish'),
        )
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        expect(setUpFor(log)).toEqual([made.id])
      }),
  )

  it.effect(
    'runs the setup again in a reused worktree whose rebase brought a lockfile change',
    () =>
      Effect.gen(function* () {
        const fixture = project(settings, { 'pnpm-lock.yaml': 'lock\n' })
        const log = besideOf(fixture, 'setups.log')
        withSetup(fixture, logging(log))
        const { end, events, made, ticketOf } = yield* runOf(
          fixture,
          Effect.gen(function* () {
            const locking = yield* file(
              'Bump the lockfile',
              'finish pnpm-lock.yaml',
            )
            const waiting = yield* file(
              'Use the new dependency',
              `wait_for ${locking.id}`,
            )
            return { locking, waiting }
          }),
        )
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        const { locking, waiting } = made
        // Set up once in its new worktree, then again once its rebase brought the lockfile.
        expect(setUpFor(log).filter(ticket => ticket === waiting.id)).toEqual([
          waiting.id,
          waiting.id,
        ])
        expect(setUpFor(log).filter(ticket => ticket === locking.id)).toEqual([
          locking.id,
        ])
        expect(setupChecksOf(events, waiting.id)).toHaveLength(2)
        expect(Option.isSome(ticketOf(waiting.id).mergedCommit)).toBe(true)
      }),
  )

  it.effect(
    'puts back a ticket whose setup failed, and names it at the end',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        withSetup(fixture, 'echo the registry is down; exit 3')
        const { end, events, made, ticketOf } = yield* runOf(
          fixture,
          file('Add the parser', 'finish'),
        )
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        const [check] = setupChecksOf(events, made.id)
        expect(check).toEqual(
          expect.objectContaining({
            result: 'failed',
            output: `.fabrica/run/checks/${made.id}.setup.log`,
          }),
        )
        expect(
          readFileSync(
            join(fixture.checkout, `.fabrica/run/checks/${made.id}.setup.log`),
            'utf8',
          ),
        ).toContain('the registry is down')
        // Back in the queue, released, and not dispatched again: no merge came.
        expect(ofKind(events, 'dispatch')).toHaveLength(1)
        expect(ofKind(events, 'settled')).toEqual([])
        expect(ticketOf(made.id).status).toBe('open')
        expect(
          ofKind(events, 'phase')
            .filter(phase => phase.ticket === made.id)
            .map(({ to }) => to)
            .at(-1),
        ).toBe('waiting')
        expect(ofKind(events, 'warn').map(({ text }) => text)).toContainEqual(
          expect.stringContaining(
            `SETUP_FAILED: ${made.id} waits for a merge or a probe: SETUP_FAILED: the setup exited 3`,
          ),
        )
        expect(ofKind(events, 'ticket_end')).toEqual([
          expect.objectContaining({
            ticket: made.id,
            why: 'waits for a setup',
          }),
        ])
        expect(humanLog(fixture)).toContain(
          `SETUP_WAITS: ${made.id} waits for a merge or a probe: its setup failed`,
        )
      }),
  )

  it.effect(
    'dispatches a ticket whose setup failed again once another merged, and sets it up again',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const log = besideOf(fixture, 'setups.log')
        const failOnce = besideOf(fixture, 'fail-once')
        // Fails once for the ticket `fail-once` names, then passes.
        withSetup(
          fixture,
          `t=$(basename "$(pwd)"); echo "$t" >> ${log}; if grep -qx "$t" ${failOnce} 2>/dev/null; then : > ${failOnce}; exit 1; fi`,
          { concurrent: 1 },
        )
        const { end, events, made, ticketOf } = yield* runOf(
          fixture,
          Effect.gen(function* () {
            const failing = yield* file('Add the parser', 'finish', {
              priority: 0,
            })
            const other = yield* file('Add the printer', 'finish', {
              priority: 2,
            })
            writeFileSync(failOnce, `${failing.id}\n`)
            return { failing, other }
          }),
        )
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        const { failing, other } = made
        expect(setUpFor(log)).toEqual([failing.id, other.id, failing.id])
        expect(setupChecksOf(events, failing.id).map(c => c.result)).toEqual([
          'failed',
          'passed',
        ])
        const closed = ofKind(events, 'closed').map(({ ticket }) => ticket)
        expect(closed).toEqual([other.id, failing.id])
        expect(
          ofKind(events, 'phase')
            .filter(phase => phase.ticket === failing.id)
            .map(({ to, cause }) => ({ to, cause })),
        ).toContainEqual({
          to: 'queued',
          cause: `${other.id} merged: its setup runs again`,
        })
        expect(Option.isSome(ticketOf(failing.id).mergedCommit)).toBe(true)
        expect(humanLog(fixture)).not.toContain('SETUP_WAITS')
      }),
  )
})

describe('what a setup comes to', () => {
  const record = {
    kind: 'check',
    suite: 'setup',
    command: 'pnpm install',
    seconds: 1,
    result: 'failed',
  } as const
  const left = Leftovers.CantTell({ reason: 'no status' })

  it('says how a failed setup ended and where its output is', () => {
    expect(
      setupOutcomeOf(
        CheckOutcome.Failed({
          record,
          log: '/repo/.fabrica/run/checks/fa-1.setup.log',
          left,
          status: ExitStatus.Signal({ signal: 'SIGKILL' }),
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        _tag: 'Failed',
        detail:
          'SETUP_FAILED: the setup was ended by SIGKILL; its output is in /repo/.fabrica/run/checks/fa-1.setup.log',
      }),
    )
  })

  it("says why a setup couldn't run", () => {
    expect(
      setupOutcomeOf(
        CheckOutcome.CouldNotRun({
          record: { ...record, result: 'not_run' },
          reason: NotRun.OutputCut({ limit: 1024 }),
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        _tag: 'Failed',
        detail:
          "SETUP_FAILED: the setup couldn't run: its output passed 1024 bytes, and it was ended",
      }),
    )
  })
})

describe('what a merge does for the tickets whose setup failed', () => {
  const worker = TicketId.make('fa-1')
  const merging = TicketId.make('fa-2')
  const gone = TicketId.make('fa-3')
  const worktree = (ticket: TicketId) => ({
    ticket,
    path: `/home/worktrees/${ticket}`,
    branch: `fabrica/${ticket}`,
  })

  it("puts a worker's back in the queue, and a merge's back in line in its worktree", () => {
    expect(
      setupRetries({
        waiting: [worker, merging, gone],
        failedAtMerge: new Set([merging, gone]),
        worktrees: [worktree(worker), worktree(merging)],
      }),
    ).toEqual([
      SetupRetry.Requeue({ ticket: worker }),
      SetupRetry.Remerge({ worktree: worktree(merging) }),
      SetupRetry.Stays({ ticket: gone }),
    ])
  })
})
