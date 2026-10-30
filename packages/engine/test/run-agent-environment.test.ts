import { Effect, Layer, Option, Ref, Stream } from 'effect'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { PermissionsVariable, TicketId } from '@fabrica/contracts'

import { type AgentStart, PiAgent, piEnvironment } from '../src/agent'
import type { MergeLine, MergeQueueShape } from '../src/merge'
import { runProject } from '../src/run'
import { standingOf } from '../src/run/worker'
import {
  configOf,
  file,
  options,
  project,
  setUpRuns,
  settings,
  withRuns,
} from './run-harness'

// What an agent the run starts is told of its gate's facts (spec §12.6, H59): the project's
// `permissions` in FABRICA_PERMISSIONS, among the variables its process starts with, and where its
// ticket stands in the merge queue, the `mergeStanding` its control channel answers merge_standing
// with. The run is a whole run on the harness, its agents' starts noted.

beforeAll(setUpRuns)

/** The agents the run is given, the services' own, their starts noted. */
const noting = (agents: Array<AgentStart>) =>
  Layer.effect(
    PiAgent,
    Effect.map(PiAgent, real =>
      PiAgent.of({
        close: real.close,
        start: start => {
          agents.push(start)
          return real.start(start)
        },
      }),
    ),
  )

/** The FABRICA_PERMISSIONS of each agent a run of one finishing ticket starts, on `projectSettings`. */
const permissionsOfAgents = (projectSettings: object) => {
  const fixture = project(projectSettings)
  const agents: Array<AgentStart> = []
  return withRuns(
    fixture,
    Effect.gen(function* () {
      yield* file('Build one', 'finish')
      const end = yield* runProject(configOf(fixture, options())).pipe(
        Effect.provide(noting(agents)),
      )
      expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
      // As Pi's process gets them.
      return agents.map(
        agent =>
          piEnvironment({
            config: '/pi',
            projectTrusted: agent.projectTrusted,
            extra: agent.env,
          })[PermissionsVariable],
      )
    }),
  )
}

describe("the gate's facts in an agent's start", () => {
  it.effect("gives an agent the project's permissions", () =>
    Effect.gen(function* () {
      expect(
        yield* permissionsOfAgents({ ...settings, permissions: 'ask' }),
      ).toEqual(['ask'])
    }),
  )

  it.effect('gives an agent the default permissions where none is set', () =>
    Effect.gen(function* () {
      expect(yield* permissionsOfAgents(settings)).toEqual(['workspace'])
    }),
  )
})

/** A merge line of the run's, moved by hand: `enqueue` puts a ticket in line, as a finish does. */
const lineQueue = Effect.map(
  Ref.make<MergeLine>({ merging: Option.none(), waiting: [] }),
  line => ({
    line,
    queue: {
      enqueue: worktree =>
        Ref.modify(line, current => [
          true,
          { ...current, waiting: [...current.waiting, worktree.ticket] },
        ]),
      line: Ref.get(line),
      updates: Effect.succeed(Stream.empty),
    } satisfies MergeQueueShape,
  }),
)

describe("a ticket's merge standing", () => {
  it.effect(
    'is not_queued before its finish, waiting once in line, merging at its turn',
    () =>
      Effect.gen(function* () {
        const ticket = TicketId.make('fa-1')
        const other = TicketId.make('fa-2')
        const { line, queue } = yield* lineQueue
        const standing = standingOf(queue, ticket)
        expect(yield* standing).toBe('not_queued')

        yield* queue.enqueue({ ticket: other, path: '/w/fa-2', branch: 'b2' })
        yield* queue.enqueue({ ticket, path: '/w/fa-1', branch: 'b1' })
        expect(yield* standing).toBe('waiting')

        yield* Ref.set(line, { merging: Option.some(other), waiting: [ticket] })
        expect(yield* standing).toBe('waiting')

        yield* Ref.set(line, { merging: Option.some(ticket), waiting: [] })
        expect(yield* standing).toBe('merging')

        yield* Ref.set(line, { merging: Option.none(), waiting: [] })
        expect(yield* standing).toBe('not_queued')
      }),
  )
})
