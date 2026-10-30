import { Effect, Fiber, Option, PubSub, Schema } from 'effect'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  Assignee,
  ProjectId,
  type RunEvent,
  SessionId,
  TicketId,
} from '@fabrica/contracts'

import { sessionFolder } from '../src/agent'
import { besideCheckout, worktreePath } from '../src/git'
import { type RunOptions, makeRunControl, runProject } from '../src/run'
import {
  type Began,
  ResumeWhy,
  SavedSession,
  changesSince,
  resumePrompt,
  runStatePath,
} from '../src/run/carryover'
import { RunLog } from '../src/runlog'
import { WorkGraph } from '../src/workgraph'
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
  settings,
  withRuns,
} from './run-harness'

// Stops, drains and the carry-over (spec §13.10, §13.2 Resumes take slots, §13.5, H75, H76): a drain
// lets the running ticket finish and merge and dispatches nothing more; a stop interrupts the
// workers, their sessions saved in `.fabrica/run/state.json`; the next run resumes them with Pi's
// session resume, each in a free slot, told what changed since it began; a crashed run's tickets are
// carried by their claims; a rebase a killed run left is aborted; a ticket merged by hand is noticed
// as Base moves; an undeferred or answered ticket resumes its session in the same run.

beforeAll(setUpRuns)

const maintainer: Actor = { _tag: 'maintainer' }

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

/** Starts a run of the project in a fiber of its own, with a control of its own, its records followed from before its start. */
const startRun = (fixture: Project, runOptions: RunOptions = options()) =>
  Effect.gen(function* () {
    const control = yield* makeRunControl
    const records = yield* (yield* RunLog).subscribe
    const running = yield* Effect.forkChild(
      runProject(configOf(fixture, runOptions), control),
    )
    return { control, records, running }
  })

/** The records of the project's runs, run by run: each ends with its `end`. */
const runsOf = (fixture: Project) =>
  Effect.map(eventsOf(fixture), events => {
    const runs: Array<Array<RunEvent>> = [[]]
    for (const event of events) {
      runs.at(-1)?.push(event)
      if (event.kind === 'end') runs.push([])
    }
    return runs.filter(run => run.length > 0)
  })

const StateFile = Schema.fromJsonString(
  Schema.Struct({ sessions: Schema.Array(SavedSession) }),
)

/** The saved sessions in the project's state file. */
const savedSessions = (fixture: Project) =>
  Schema.decodeUnknownSync(StateFile)(
    readFileSync(join(fixture.checkout, runStatePath), 'utf8'),
  ).sessions

const StubEntry = Schema.fromJsonString(
  Schema.Struct({
    event: Schema.String,
    message: Schema.optionalKey(Schema.String),
    session: Schema.optionalKey(Schema.String),
  }),
)

/** The ticket's stub's log: every session's prompts and resumes, oldest first. */
const stubLog = (fixture: Project, ticket: TicketId) => {
  const log = join(
    sessionFolder({
      data: fixture.data,
      project: ProjectId.make('p1'),
      ticket,
    }),
    'stub.jsonl',
  )
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => Schema.decodeUnknownSync(StubEntry)(line))
}

const promptsOf = (fixture: Project, ticket: TicketId) =>
  stubLog(fixture, ticket).flatMap(entry =>
    entry.event === 'prompt' && entry.message !== undefined
      ? [entry.message]
      : [],
  )

const resumesOf = (fixture: Project, ticket: TicketId) =>
  stubLog(fixture, ticket).flatMap(entry =>
    entry.event === 'resumed' && entry.session !== undefined
      ? [entry.session]
      : [],
  )

const infoTexts = (events: ReadonlyArray<RunEvent>) =>
  ofKind(events, 'info').map(({ text }) => text)

const isCheck = (event: RunEvent) => event.kind === 'check'

const isDispatchOf = (ticket: TicketId) => (event: RunEvent) =>
  event.kind === 'dispatch' && event.ticket === ticket

describe('a drain', () => {
  it.effect(
    'lets the running ticket finish and merge, dispatches nothing more, and ends DRAINED',
    () => {
      const fixture = project({ ...settings, concurrent: 1 })
      const go = `${fixture.data}-go`
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const graph = yield* WorkGraph
          const first = yield* file('First', `wait ${go}`, { priority: 1 })
          const second = yield* file('Second', `wait ${go}`)
          const { control, records, running } = yield* startRun(fixture)
          yield* until(records, isDispatchOf(first.id))
          yield* control.drain
          yield* until(records, event => event.kind === 'drain')
          writeFileSync(go, '')
          expect(yield* Fiber.join(running)).toEqual({
            kind: 'DRAINED',
            code: 0,
          })
          const events = yield* eventsOf(fixture)
          expect(
            ofKind(events, 'dispatch').map(({ ticket }) => ticket),
          ).toEqual([first.id])
          expect(ofKind(events, 'closed').map(({ ticket }) => ticket)).toEqual([
            first.id,
          ])
          expect(ofKind(events, 'done')[0]?.text).toBe('DRAINED after 1 ticket')
          expect((yield* graph.show(second.id)).ticket.status).toBe('open')
        }),
      )
    },
  )
})

describe('a stop', () => {
  it.effect(
    'interrupts the worker, saves its session, and the next run resumes it, told what changed',
    () => {
      const fixture = project()
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const graph = yield* WorkGraph
          const ticket = (yield* file('Long work', 'hang')).id
          const first = yield* startRun(fixture)
          yield* until(first.records, isCheck)
          yield* first.control.stop
          expect(yield* Fiber.join(first.running)).toEqual({
            kind: 'INTERRUPTED',
            code: 130,
          })
          // Its claim and its session are the carry-over.
          expect((yield* graph.show(ticket)).ticket.status).toBe('in_progress')
          const saved = savedSessions(fixture)
          expect(saved.map(entry => [entry.ticket, entry.left._tag])).toEqual([
            [ticket, 'working'],
          ])

          // The requirements list changes on Base between the runs.
          commit(fixture.checkout, 'require jq', {
            '.fabrica/settings.json': `${JSON.stringify({
              ...settings,
              requires: [{ name: 'jq', check: 'true', install: 'true' }],
            })}\n`,
          })
          const end = yield* runProject(configOf(fixture, options()))
          expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
          const [, second = []] = yield* runsOf(fixture)
          expect(infoTexts(second)).toContain(
            'start: the carry-over: 1 to resume',
          )
          expect(infoTexts(second)).toContain(
            `  ${ticket} resumes its session: carried over`,
          )
          expect(ofKind(second, 'closed').map(({ ticket: id }) => id)).toEqual([
            ticket,
          ])
          expect(resumesOf(fixture, ticket)).toEqual([saved[0]?.session])
          const resumed = promptsOf(fixture, ticket).at(-1) ?? ''
          expect(resumed).toContain(
            `Your session on ${ticket} is resumed: the run that had it ended before you finished.`,
          )
          expect(resumed).toContain(
            'Since your session began: the requirements list changed: added jq.',
          )
          // Merged, its session is over.
          expect(savedSessions(fixture)).toEqual([])
        }),
      )
    },
  )

  it.effect(
    "during the start's carry-over cuts it short: nothing is resumed, and the rest stay saved",
    () => {
      const fixture = project()
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const graph = yield* WorkGraph
          const ticket = (yield* file('Long work', 'hang')).id
          const first = yield* startRun(fixture)
          yield* until(first.records, isCheck)
          yield* first.control.stop
          yield* Fiber.join(first.running)

          const control = yield* makeRunControl
          yield* control.stop
          const end = yield* runProject(configOf(fixture, options()), control)
          expect(end.kind).toBe('INTERRUPTED')
          const [, second = []] = yield* runsOf(fixture)
          expect(infoTexts(second)).toContain(
            'start: the carry-over: nothing to resume; cut short by a stop, the rest kept for the next start',
          )
          expect(ofKind(second, 'dispatch')).toEqual([])
          expect((yield* graph.show(ticket)).ticket.status).toBe('in_progress')
          expect(savedSessions(fixture).map(entry => entry.ticket)).toEqual([
            ticket,
          ])
        }),
      )
    },
  )
})

describe('the carry-over', () => {
  it.effect(
    'resumes the carried workers into free slots: one at a time under concurrent 1',
    () => {
      const fixture = project()
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const one = (yield* file('One', 'hang')).id
          const two = (yield* file('Two', 'hang')).id
          const first = yield* startRun(fixture)
          yield* until(first.records, isCheck)
          yield* until(first.records, isCheck)
          yield* first.control.stop
          yield* Fiber.join(first.running)
          expect(
            savedSessions(fixture)
              .map(entry => entry.ticket)
              .toSorted(),
          ).toEqual([one, two].toSorted())

          const end = yield* runProject(
            configOf(fixture, options({ concurrent: Option.some(1) })),
          )
          expect(end.kind).toBe('READY_EMPTY')
          const [, second = []] = yield* runsOf(fixture)
          const kinds = second.map(event => event.kind)
          const dispatched = ofKind(second, 'dispatch')
          expect(dispatched.map(({ ticket }) => ticket).toSorted()).toEqual(
            [one, two].toSorted(),
          )
          // The second resumes only once the first's worker settled: never two at once.
          expect(kinds.lastIndexOf('dispatch')).toBeGreaterThan(
            kinds.indexOf('settled'),
          )
          expect(resumesOf(fixture, one)).toHaveLength(1)
          expect(resumesOf(fixture, two)).toHaveLength(1)
          expect(
            ofKind(second, 'closed')
              .map(({ ticket }) => ticket)
              .toSorted(),
          ).toEqual([one, two].toSorted())
        }),
      )
    },
  )

  it.effect(
    "recovers a crashed run's tickets by their claims: a saved session resumed, one with none started afresh",
    () => {
      const fixture = project()
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const graph = yield* WorkGraph
          const resumed = (yield* file('Resumed', 'hang')).id
          const first = yield* startRun(fixture)
          yield* until(first.records, isCheck)
          // The engine dies: no end, no stop; its claims and the state file are what is left, with a
          // ticket it had claimed but whose agent hadn't started.
          yield* Fiber.interrupt(first.running)
          const afresh = (yield* file('Afresh', 'finish')).id
          const { engine } = configOf(fixture, options())
          yield* graph.claim({
            id: afresh,
            assignee: new Assignee({
              engine,
              session: SessionId.make('worker-lost'),
            }),
            actor: { _tag: 'engine', engine },
          })
          const [crashed = []] = yield* runsOf(fixture)
          expect(ofKind(crashed, 'end')).toEqual([])

          const end = yield* runProject(configOf(fixture, options()))
          expect(end.kind).toBe('READY_EMPTY')
          const events = yield* eventsOf(fixture)
          expect(infoTexts(events)).toContain(
            'start: the carry-over: 2 to resume',
          )
          expect(resumesOf(fixture, resumed)).toHaveLength(1)
          expect(resumesOf(fixture, afresh)).toEqual([])
          expect(promptsOf(fixture, afresh)[0]).toContain(
            `Your ticket is ${afresh}.`,
          )
          expect((yield* graph.show(resumed)).ticket.status).toBe('closed')
          expect((yield* graph.show(afresh)).ticket.status).toBe('closed')
        }),
      )
    },
  )

  it.effect(
    'aborts a rebase a killed run left in progress, its branch put back, and merges the ticket',
    () => {
      const fixture = project()
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const graph = yield* WorkGraph
          const ticket = (yield* file('Long work', 'hang')).id
          const first = yield* startRun(fixture)
          yield* until(first.records, isCheck)
          yield* first.control.stop
          yield* Fiber.join(first.running)

          // Base moves, and a merge's rebase onto it is killed midway.
          commit(fixture.checkout, 'two', { 'other.txt': 'two\n' })
          const worktree = worktreePath({
            home: besideCheckout(fixture.checkout),
            ticket,
          })
          const before = git(worktree, 'rev-parse', 'HEAD')
          expect(() =>
            git(
              worktree,
              'rebase',
              '--force-rebase',
              '--exec',
              'false',
              'main',
            ),
          ).toThrow()
          const rebasing = resolve(
            worktree,
            git(worktree, 'rev-parse', '--git-path', 'rebase-merge'),
          )
          expect(existsSync(rebasing)).toBe(true)

          const second = yield* startRun(fixture)
          yield* until(second.records, isDispatchOf(ticket))
          // Put back as it was before the rebase, for its worker and its merge.
          expect(existsSync(rebasing)).toBe(false)
          expect(git(worktree, 'rev-parse', 'HEAD')).toBe(before)
          expect(git(worktree, 'symbolic-ref', '--short', 'HEAD')).toBe(
            `fabrica/${ticket}`,
          )
          expect((yield* Fiber.join(second.running)).kind).toBe('READY_EMPTY')
          const [, events = []] = yield* runsOf(fixture)
          expect(infoTexts(events)).toContain(
            `start: the carry-over: ${ticket}'s rebase, left in progress, aborted: its branch is put back`,
          )
          expect((yield* graph.show(ticket)).ticket.status).toBe('closed')
        }),
      )
    },
  )
})

describe('a carried ticket already on Base', () => {
  it.effect(
    'is dropped: closed and merged, its worktree and branch removed',
    () => {
      const fixture = project()
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const graph = yield* WorkGraph
          const ticket = (yield* file('Long work', 'hang')).id
          const first = yield* startRun(fixture)
          yield* until(first.records, isCheck)
          yield* first.control.stop
          yield* Fiber.join(first.running)
          // Merged by hand between the runs.
          git(
            fixture.checkout,
            'merge',
            '--quiet',
            '--ff-only',
            `fabrica/${ticket}`,
          )
          const merged = git(fixture.checkout, 'rev-parse', 'HEAD')

          const end = yield* runProject(configOf(fixture, options()))
          expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
          const [, second = []] = yield* runsOf(fixture)
          expect(infoTexts(second)).toEqual(
            expect.arrayContaining([
              `start: the carry-over: ${ticket} is on main already: closed, its worktree and branch removed`,
              'start: the carry-over: 1 on main already, closed',
            ]),
          )
          expect(ofKind(second, 'dispatch')).toEqual([])
          const shown = (yield* graph.show(ticket)).ticket
          expect(shown.status).toBe('closed')
          expect(Option.getOrUndefined(shown.mergedCommit)).toBe(merged)
          expect(
            existsSync(
              worktreePath({ home: besideCheckout(fixture.checkout), ticket }),
            ),
          ).toBe(false)
          expect(
            git(fixture.checkout, 'branch', '--list', `fabrica/${ticket}`),
          ).toBe('')
          expect(savedSessions(fixture)).toEqual([])
        }),
      )
    },
  )
})

describe('a ticket merged by hand', () => {
  it.effect(
    'is noticed as Base moves: closed and merged, its worktree and branch removed',
    () => {
      const fixture = project({ ...settings, concurrent: 1 })
      const go = `${fixture.data}-go`
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const graph = yield* WorkGraph
          const aside = (yield* file('Set aside', 'commit_defer', {
            priority: 1,
          })).id
          const other = (yield* file('Other', `wait ${go}`)).id
          const { records, running } = yield* startRun(fixture)
          yield* until(records, isDispatchOf(other))
          // The maintainer merges the set-aside ticket's branch into Base by hand.
          git(
            fixture.checkout,
            'merge',
            '--quiet',
            '--ff-only',
            `fabrica/${aside}`,
          )
          const merged = git(fixture.checkout, 'rev-parse', 'HEAD')
          writeFileSync(go, '')
          expect((yield* Fiber.join(running)).kind).toBe('READY_EMPTY')

          const events = yield* eventsOf(fixture)
          expect(
            ofKind(events, 'closed').map(({ ticket, detail }) => [
              ticket,
              detail,
            ]),
          ).toEqual(
            expect.arrayContaining([
              [other, expect.stringContaining('merged into main')],
              [aside, `${merged.slice(0, 7)} merged by hand into main`],
            ]),
          )
          const shown = (yield* graph.show(aside)).ticket
          expect(shown.status).toBe('closed')
          expect(Option.getOrUndefined(shown.mergedCommit)).toBe(merged)
          expect(
            existsSync(
              worktreePath({
                home: besideCheckout(fixture.checkout),
                ticket: aside,
              }),
            ),
          ).toBe(false)
          expect(
            git(fixture.checkout, 'branch', '--list', `fabrica/${aside}`),
          ).toBe('')
        }),
      )
    },
  )
})

describe('a resume in the same run', () => {
  it.effect(
    'gives an undeferred ticket its session back once a slot is free',
    () => {
      const fixture = project({ ...settings, concurrent: 1 })
      const go = `${fixture.data}-go`
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const graph = yield* WorkGraph
          const later = (yield* file('Decide later', 'defer', { priority: 1 }))
            .id
          const other = (yield* file('Other', `wait ${go}`)).id
          const { records, running } = yield* startRun(fixture)
          yield* until(records, isDispatchOf(other))
          yield* graph.undefer({ id: later, actor: maintainer })
          yield* until(
            records,
            event =>
              event.kind === 'phase' &&
              event.ticket === later &&
              event.cause === 'undeferred',
          )
          writeFileSync(go, '')
          expect((yield* Fiber.join(running)).kind).toBe('READY_EMPTY')

          const events = yield* eventsOf(fixture)
          expect(
            ofKind(events, 'dispatch').map(({ ticket }) => ticket),
          ).toEqual([later, other, later])
          // It waited for the other's slot.
          const kinds = events.map(event => event.kind)
          expect(kinds.lastIndexOf('dispatch')).toBeGreaterThan(
            events.findIndex(
              event => event.kind === 'settled' && event.ticket === other,
            ),
          )
          expect(infoTexts(events)).toContain(
            `  ${later} resumes its session: undeferred`,
          )
          expect(resumesOf(fixture, later)).toHaveLength(1)
          expect(promptsOf(fixture, later).at(-1)).toContain(
            'it was set aside, and is undeferred.',
          )
          expect((yield* graph.show(later)).ticket.status).toBe('closed')
        }),
      )
    },
  )

  it.effect('gives an answered ticket its session back with the answer', () => {
    const fixture = project({ ...settings, concurrent: 1 })
    const go = `${fixture.data}-go`
    return withRuns(
      fixture,
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const asking = (yield* file('Drop the flag', 'ask', { priority: 1 })).id
        const other = (yield* file('Other', `wait ${go}`)).id
        const { records, running } = yield* startRun(fixture)
        const asked = yield* until(records, event => event.kind === 'asked')
        const question = asked.kind === 'asked' ? asked.question : asking
        yield* until(records, isDispatchOf(other))
        yield* graph.answer({
          id: question,
          answer: 'Drop it',
          actor: maintainer,
        })
        writeFileSync(go, '')
        expect((yield* Fiber.join(running)).kind).toBe('READY_EMPTY')

        const events = yield* eventsOf(fixture)
        expect(ofKind(events, 'dispatch').map(({ ticket }) => ticket)).toEqual([
          asking,
          other,
          asking,
        ])
        expect(infoTexts(events)).toContain(
          `  ${asking} resumes its session: ${question} answered`,
        )
        expect(promptsOf(fixture, asking).at(-1)).toContain(
          `your question ${question} was answered: Drop it`,
        )
        expect((yield* graph.show(asking)).ticket.status).toBe('closed')
      }),
    )
  })
})

describe('what a resumed session is told', () => {
  const began: Began = {
    templates: { 'standing-rules': 1 },
    projectRules: Option.none(),
    requirements: [
      { name: 'jq', entry: 'jq --version; install: brew install jq' },
      { name: 'rg', entry: 'rg --version; install: brew install ripgrep' },
    ],
  }

  it('is nothing changed where nothing did', () => {
    expect(changesSince(began, began)).toEqual([])
    expect(
      resumePrompt({
        ticket: TicketId.make('fa-1'),
        why: ResumeWhy.Carried(),
        changes: [],
      }),
    ).toContain('Nothing in the standing rules')
  })

  it("names the rules' versions, the worker rules and the requirements that changed", () => {
    expect(
      changesSince(began, {
        templates: { 'standing-rules': 2 },
        projectRules: Option.some('abc'),
        requirements: [
          { name: 'jq', entry: 'jq --help; install: brew install jq' },
          { name: 'fd', entry: 'fd --version; install: brew install fd' },
        ],
      }),
    ).toEqual([
      "the standing rules' templates changed: standing-rules 1 → 2",
      "the project's worker rules (.fabrica/worker-rules.md) changed on Base",
      'the requirements list changed: added fd; removed rg; changed jq',
    ])
  })
})
