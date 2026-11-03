import { DateTime, Effect, Layer, Option } from 'effect'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  Assignee,
  EngineId,
  SessionId,
  TicketId,
} from '@fabrica/contracts'

import type { Checks } from '../src/checks'
import { WorkerEnd, runProject } from '../src/run'
import { settleOf } from '../src/run/holds'
import type { RunLog } from '../src/runlog'
import { StoreFailed, TransitionRefused, WorkGraph } from '../src/workgraph'
import {
  type Project,
  configOf,
  eventsOf,
  file,
  ofKind,
  options,
  project,
  setUpRuns,
  withRuns,
} from './run-harness'

// A claim the work graph refuses is a race, not a tracker failure (spec §13.2, §11.5, §13.11): the ticket
// moved between the ready read and its claim, so it is dropped from the run, the graph left as it is. Whole
// runs on the harness, the race made where it happens: a hand on the ticket just before the run's claim.

beforeAll(setUpRuns)

const maintainer: Actor = { _tag: 'maintainer' }
const another = new Assignee({
  engine: EngineId.make('another-engine'),
  session: SessionId.make('another-session'),
})
const until = DateTime.makeUnsafe('2031-01-01T00:00:00.000Z')

type Graph = WorkGraph['Service']

/** The run's work graph, changed where the run goes through it. */
const changing = (changes: (graph: Graph) => Partial<Graph>) =>
  Layer.effect(
    WorkGraph,
    Effect.map(WorkGraph, graph =>
      WorkGraph.of({ ...graph, ...changes(graph) }),
    ),
  )

/** The run's work graph, `moved` done to a ticket just before the run claims it. */
const movedBeforeClaim = (
  moved: (graph: Graph, ticket: TicketId) => Effect.Effect<unknown, unknown>,
) =>
  changing(graph => ({
    claim: options =>
      Effect.andThen(
        Effect.orDie(moved(graph, options.id)),
        graph.claim(options),
      ),
  }))

/** Runs the project on `layer`: its end, its records, and the ticket `setup` filed as it stands after. */
const ended = (
  fixture: Project,
  setup: Effect.Effect<{ readonly id: TicketId }, unknown, WorkGraph>,
  layer: Layer.Layer<never, never, RunLog | WorkGraph | Checks>,
) =>
  withRuns(
    fixture,
    Effect.gen(function* () {
      const { id } = yield* setup
      const end = yield* runProject(configOf(fixture, options())).pipe(
        Effect.provide(layer),
      )
      const graph = yield* WorkGraph
      return {
        end,
        events: yield* eventsOf(fixture),
        id,
        detail: yield* graph.show(id),
      }
    }),
  )

/** The lines of the run's warnings that have `tag`. */
const warned = (
  events: Effect.Success<ReturnType<typeof ended>>['events'],
  tag: string,
) =>
  ofKind(events, 'warn')
    .map(({ text }) => text)
    .filter(text => text.includes(`${tag}:`))

/** That the run went on past the race: a clean end, the ticket dropped and neither set aside nor noted. */
const expectDropped = (run: Effect.Success<ReturnType<typeof ended>>) => {
  expect(run.end).toEqual({ kind: 'READY_EMPTY', code: 0 })
  expect(ofKind(run.events, 'stop')).toEqual([])
  expect(ofKind(run.events, 'deferred')).toEqual([])
  expect(run.detail.notes).toEqual([])
  expect(warned(run.events, 'NOT_CLAIMED')).toHaveLength(1)
  expect(ofKind(run.events, 'ticket_end')).toMatchObject([
    { ticket: run.id, outcome: 'queued', phase: 'queued' },
  ])
}

describe('a claim the work graph refuses', () => {
  it.effect('leaves a ticket closed since the ready read closed', () =>
    Effect.gen(function* () {
      const run = yield* ended(
        project(),
        file('Closed meanwhile', 'finish'),
        movedBeforeClaim((graph, id) =>
          graph.close({ id, resolution: 'done', actor: maintainer }),
        ),
      )
      expectDropped(run)
      expect(warned(run.events, 'NOT_CLAIMED')[0]).toContain('it is closed')
      expect(run.detail.ticket.status).toBe('closed')
    }),
  )

  it.effect('keeps the time of a ticket the maintainer deferred until it', () =>
    Effect.gen(function* () {
      const run = yield* ended(
        project(),
        file('Deferred meanwhile', 'finish'),
        movedBeforeClaim((graph, id) =>
          graph.defer({ id, until: Option.some(until), actor: maintainer }),
        ),
      )
      expectDropped(run)
      expect(run.detail.ticket.status).toBe('deferred')
      expect(run.detail.ticket.deferUntil).toEqual(Option.some(until))
    }),
  )

  it.effect("keeps another's claim", () =>
    Effect.gen(function* () {
      const run = yield* ended(
        project(),
        file('Claimed meanwhile', 'finish'),
        movedBeforeClaim((graph, id) =>
          graph.claim({ id, assignee: another, actor: maintainer }),
        ),
      )
      expectDropped(run)
      expect(run.detail.ticket.status).toBe('in_progress')
      expect(run.detail.ticket.assignee).toEqual(Option.some(another))
    }),
  )

  it.effect('takes the ticket up again where it is ready again', () =>
    Effect.gen(function* () {
      let refused = false
      const run = yield* ended(
        project(),
        file('Back again', 'finish'),
        changing(graph => ({
          claim: options => {
            if (refused) return graph.claim(options)
            refused = true
            return Effect.fail(
              new TransitionRefused({
                id: options.id,
                operation: 'claim',
                status: 'in_progress',
              }),
            )
          },
        })),
      )
      expect(warned(run.events, 'NOT_CLAIMED')).toHaveLength(1)
      expect(ofKind(run.events, 'dispatch').map(({ n }) => n)).toEqual([1, 1])
      expect(ofKind(run.events, 'closed')).toHaveLength(1)
      expect(run.detail.ticket.status).toBe('closed')
    }),
  )

  it.effect('drops a deleted ticket', () =>
    Effect.gen(function* () {
      const fixture = project()
      const { end, events } = yield* withRuns(
        fixture,
        Effect.gen(function* () {
          yield* file('Deleted meanwhile', 'finish')
          const end = yield* runProject(configOf(fixture, options())).pipe(
            Effect.provide(
              movedBeforeClaim((graph, id) =>
                graph.delete({ id, actor: maintainer }),
              ),
            ),
          )
          return { end, events: yield* eventsOf(fixture) }
        }),
      )
      expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
      expect(ofKind(events, 'stop')).toEqual([])
      expect(warned(events, 'NOT_CLAIMED')).toHaveLength(1)
    }),
  )
})

describe("a dispatch that didn't start", () => {
  const storeFailed = new StoreFailed({
    operation: 'claim',
    reason: 'the store went',
  })

  it.effect("leaves another's claim where its own claim failed", () =>
    Effect.gen(function* () {
      const run = yield* ended(
        project(),
        file('Claimed by another', 'finish'),
        changing(graph => ({
          claim: options =>
            Effect.andThen(
              Effect.orDie(
                graph.claim({
                  id: options.id,
                  assignee: another,
                  actor: maintainer,
                }),
              ),
              Effect.fail(storeFailed),
            ),
        })),
      )
      expect(run.end).toEqual({ kind: 'READY_EMPTY', code: 0 })
      expect(run.detail.ticket.status).toBe('in_progress')
      expect(run.detail.ticket.assignee).toEqual(Option.some(another))
      expect(run.detail.notes).toEqual([])
      // Set aside in the run alone, so a claim that keeps failing isn't tried again and again.
      expect(ofKind(run.events, 'dispatch')).toHaveLength(1)
      expect(ofKind(run.events, 'deferred')).toMatchObject([
        { ticket: run.id, reason: 'TOOL_DEFECT' },
      ])
    }),
  )

  it.effect('gives back the claim it made and sets its ticket aside', () =>
    Effect.gen(function* () {
      let claimed = false
      let shown = false
      const run = yield* ended(
        project(),
        file('Fails to start', 'finish'),
        changing(graph => ({
          claim: options => {
            claimed = true
            return graph.claim(options)
          },
          // The dispatch's read of its ticket for its prompt, once it holds its claim.
          show: id => {
            if (!claimed || shown) return graph.show(id)
            shown = true
            return Effect.fail(
              new StoreFailed({ operation: 'show', reason: 'the store went' }),
            )
          },
        })),
      )
      expect(run.end).toEqual({ kind: 'READY_EMPTY', code: 0 })
      expect(run.detail.ticket.status).toBe('deferred')
      expect(run.detail.ticket.assignee).toEqual(Option.none())
      expect(run.detail.notes.map(({ body }) => body)).toEqual([
        "its worker couldn't start: work graph show: the store went",
      ])
      expect(ofKind(run.events, 'deferred')).toMatchObject([
        { ticket: run.id, reason: 'TOOL_DEFECT' },
      ])
    }),
  )
})

describe('a change the work graph refuses as the ticket moved under the run', () => {
  it.effect(
    "is said, not the run's end, where it is set aside once closed",
    () =>
      Effect.gen(function* () {
        const run = yield* ended(
          project(),
          file('Closed under its worker', 'nothing'),
          changing(graph => ({
            defer: options =>
              Effect.andThen(
                graph.close({
                  id: options.id,
                  resolution: 'done',
                  actor: maintainer,
                }),
                graph.defer(options),
              ),
          })),
        )
        expect(run.end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        expect(ofKind(run.events, 'stop')).toEqual([])
        expect(warned(run.events, 'TICKET_MOVED')).toHaveLength(1)
        expect(run.detail.ticket.status).toBe('closed')
      }),
  )

  it.effect("doesn't free another's claim where its worker waits", () =>
    Effect.gen(function* () {
      const run = yield* ended(
        project(),
        Effect.gen(function* () {
          const other = yield* file('Merges first', 'finish')
          return yield* file('Waits', `wait_for ${other.id}`)
        }),
        changing(graph => ({
          release: options =>
            Effect.gen(function* () {
              yield* Effect.orDie(
                graph.release({ id: options.id, actor: maintainer }),
              )
              yield* Effect.orDie(
                graph.claim({
                  id: options.id,
                  assignee: another,
                  actor: maintainer,
                }),
              )
              return yield* graph.release(options)
            }),
        })),
      )
      expect(ofKind(run.events, 'stop')).toEqual([])
      expect(warned(run.events, 'TICKET_MOVED')).toHaveLength(1)
      expect(run.detail.ticket.assignee).toEqual(Option.some(another))
    }),
  )
})

describe('how a refused claim counts', () => {
  it('counts for nothing toward the environment hold', () => {
    expect(
      settleOf({
        ticket: TicketId.make('fa-1'),
        end: WorkerEnd.NotClaimed({ reason: "can't claim fa-1: it is closed" }),
        quick: true,
        changed: false,
        providerHeld: false,
      })._tag,
    ).toBe('Uncounted')
  })
})
