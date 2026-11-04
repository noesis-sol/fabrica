import { Effect, Fiber, PubSub, Schema } from 'effect'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  ProjectId,
  Requires,
  type RunEvent,
  type TicketId,
} from '@fabrica/contracts'

import { sessionFolder } from '../src/agent'
import { requirementWords } from '../src/requirements'
import { makeRunControl, runProject } from '../src/run'
import { SavedSession, runStatePath } from '../src/run/carryover'
import { RunLog } from '../src/runlog'
import { WorkGraph } from '../src/workgraph'
import {
  type Project,
  commit,
  configOf,
  file,
  options,
  project,
  setUpRuns,
  settings,
  withRuns,
} from './run-harness'

// What a session is told of the requires list (spec §12.4, §17): a run takes a list a merge changed on
// Base, so a session resumed after it hears of the change, and one begun after it is recorded with the
// new list, and isn't told later of a change it began with.

beforeAll(setUpRuns)

const maintainer: Actor = { _tag: 'maintainer' }

/** The list as `.fabrica/settings.json` writes it after the merge. */
const requires = [{ name: 'jq', check: 'true', install: 'true' }]

const requireJq = (fixture: Project) =>
  commit(fixture.checkout, 'require jq', {
    '.fabrica/settings.json': `${JSON.stringify({
      ...settings,
      concurrent: 1,
      requires,
    })}\n`,
  })

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

const startRun = (fixture: Project) =>
  Effect.gen(function* () {
    const control = yield* makeRunControl
    const records = yield* (yield* RunLog).subscribe
    const running = yield* Effect.forkChild(
      runProject(configOf(fixture, options()), control),
    )
    return { control, records, running }
  })

const StubEntry = Schema.fromJsonString(
  Schema.Struct({
    event: Schema.String,
    message: Schema.optionalKey(Schema.String),
  }),
)

/** Every prompt the ticket's stub was given, oldest first. */
const promptsOf = (fixture: Project, ticket: TicketId) => {
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
    .flatMap(entry =>
      entry.event === 'prompt' && entry.message !== undefined
        ? [entry.message]
        : [],
    )
}

const StateFile = Schema.fromJsonString(
  Schema.Struct({ sessions: Schema.Array(SavedSession) }),
)

const savedSessions = (fixture: Project) =>
  Schema.decodeUnknownSync(StateFile)(
    readFileSync(join(fixture.checkout, runStatePath), 'utf8'),
  ).sessions

const isDispatchOf = (ticket: TicketId) => (event: RunEvent) =>
  event.kind === 'dispatch' && event.ticket === ticket

/** Two tickets' whole merges on a busy machine. */
const WHOLE_RUNS = 60_000

describe('a list a merge changed during the run', () => {
  it.effect(
    'is told to a session resumed after it',
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
          // Base moves after its session began, and before it resumes.
          requireJq(fixture)
          yield* graph.undefer({ id: later, actor: maintainer })
          writeFileSync(go, '')
          expect((yield* Fiber.join(running)).kind).toBe('READY_EMPTY')
          expect(promptsOf(fixture, later).at(-1)).toContain(
            'Since your session began: the requirements list changed: added jq.',
          )
        }),
      )
    },
    WHOLE_RUNS,
  )

  it.effect(
    'is what a session begun after it is recorded with, so a later resume says nothing of it',
    () => {
      const fixture = project({ ...settings, concurrent: 1 })
      const go = `${fixture.data}-go`
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const first = (yield* file('First', `wait ${go}`, { priority: 1 })).id
          const second = (yield* file('Second', 'hang')).id
          const { control, records, running } = yield* startRun(fixture)
          yield* until(records, isDispatchOf(first))
          requireJq(fixture)
          writeFileSync(go, '')
          yield* until(
            records,
            event => event.kind === 'check' && event.ticket === second,
          )
          yield* control.stop
          expect((yield* Fiber.join(running)).kind).toBe('INTERRUPTED')
          expect(
            savedSessions(fixture).map(({ ticket, began }) => [
              ticket,
              began.requirements,
            ]),
          ).toEqual([
            [
              second,
              Schema.decodeUnknownSync(Requires)(requires).map(entry => ({
                name: entry.name,
                entry: requirementWords(entry),
              })),
            ],
          ])

          expect((yield* runProject(configOf(fixture, options()))).kind).toBe(
            'READY_EMPTY',
          )
          expect(promptsOf(fixture, second).at(-1)).toContain(
            'Nothing in the standing rules, the project’s worker rules or the requirements list changed since your session began.',
          )
        }),
      )
    },
    WHOLE_RUNS,
  )
})
