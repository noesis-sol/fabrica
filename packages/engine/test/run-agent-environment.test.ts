import { Effect, Fiber, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  AgentRoleVariable,
  type MergeStanding,
  PermissionsVariable,
  type TicketId,
} from '@fabrica/contracts'

import { type AgentStart, PiAgent, piEnvironment } from '../src/agent'
import { ControlServer } from '../src/control'
import { runProject } from '../src/run'
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
// with. The runs are whole runs on the harness, their agents' starts and control channels noted.

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

/**
 * The role and FABRICA_PERMISSIONS of each agent a run of one finishing ticket starts, on
 * `projectSettings`, as Pi's process gets them.
 */
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
      return agents.map(agent => {
        const environment = piEnvironment({
          config: '/pi',
          projectTrusted: agent.projectTrusted,
          extra: agent.env,
        })
        return [
          environment[AgentRoleVariable] ?? 'worker',
          environment[PermissionsVariable],
        ]
      })
    }),
  )
}

describe("the gate's facts in an agent's start", () => {
  it.effect("gives an agent the project's permissions", () =>
    Effect.gen(function* () {
      expect(
        yield* permissionsOfAgents({ ...settings, permissions: 'ask' }),
      ).toEqual([['worker', 'ask']])
    }),
  )

  it.effect('gives an agent the default permissions where none is set', () =>
    Effect.gen(function* () {
      expect(yield* permissionsOfAgents(settings)).toEqual([
        ['worker', 'workspace'],
      ])
    }),
  )

  it.effect("gives the verifier the project's permissions too", () =>
    Effect.gen(function* () {
      // The harness's stub is no verifier: whatever comes of its round, it started as one.
      const started = yield* permissionsOfAgents({
        ...settings,
        permissions: 'ask',
        verifier: { enabled: true },
      })
      expect(started.slice(0, 2)).toEqual([
        ['worker', 'ask'],
        ['verifier', 'ask'],
      ])
    }),
  )
})

/** The control server the run is given, the services' own, the merge standing of each channel opened noted by its ticket. */
const notingStandings = (
  standings: Map<TicketId, Effect.Effect<MergeStanding>>,
) =>
  Layer.effect(
    ControlServer,
    Effect.map(ControlServer, real =>
      ControlServer.of({
        open: session => {
          standings.set(session.ticket, session.mergeStanding)
          return real.open(session)
        },
      }),
    ),
  )

/**
 * Reads the merge standing of `ticket`'s channel until it is `wanted`, between waits on the live
 * clock, as the run's processes run in real time; no channel open yet is read again too.
 */
const untilStanding = (
  standings: ReadonlyMap<TicketId, Effect.Effect<MergeStanding>>,
  ticket: TicketId,
  wanted: MergeStanding,
): Effect.Effect<MergeStanding> =>
  Effect.flatMap(standings.get(ticket) ?? Effect.succeed(undefined), now =>
    now === wanted
      ? Effect.succeed(now)
      : Effect.andThen(
          TestClock.withLive(Effect.sleep('50 millis')),
          untilStanding(standings, ticket, wanted),
        ),
  )

describe("a ticket's merge standing", () => {
  it.effect(
    'answers merging for the ticket merging, waiting once a finish puts the next in line',
    () => {
      const gates = realpathSync(mkdtempSync(join(tmpdir(), 'fab-hold-')))
      const mergeFirst = join(gates, 'merge')
      const finishSecond = join(gates, 'finish')
      const fixture = project({
        ...settings,
        // The merge check holds on a ticket that brings a hold file, until the test lets it go.
        check_fast: `if [ -f hold ]; then while [ ! -f ${mergeFirst} ]; do sleep 0.05; done; fi; echo passing`,
      })
      const standings = new Map<TicketId, Effect.Effect<MergeStanding>>()
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const first = (yield* file('First', 'finish hold', { priority: 1 }))
            .id
          const second = (yield* file('Second', `wait ${finishSecond}`)).id
          const running = yield* Effect.forkChild(
            runProject(configOf(fixture, options())).pipe(
              Effect.provide(notingStandings(standings)),
            ),
          )
          yield* untilStanding(standings, first, 'merging')
          // The second is working still: not in line.
          yield* untilStanding(standings, second, 'not_queued')
          writeFileSync(finishSecond, '')
          yield* untilStanding(standings, second, 'waiting')
          expect(yield* untilStanding(standings, first, 'merging')).toBe(
            'merging',
          )
          writeFileSync(mergeFirst, '')
          expect(yield* Fiber.join(running)).toEqual({
            kind: 'READY_EMPTY',
            code: 0,
          })
          // Both merged: neither is in line.
          for (const ticket of [first, second])
            expect(yield* standings.get(ticket) ?? Effect.die('none')).toBe(
              'not_queued',
            )
        }),
      )
    },
  )
})
