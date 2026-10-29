import { DateTime, Effect, Layer, Option } from 'effect'
import { TestClock } from 'effect/testing'

import { describe, expect, it } from '@effect/vitest'
import { type Actor, CommitHash, type TicketId } from '@fabrica/contracts'

import {
  WorkGraph,
  doneToday,
  makeWorkGraph,
  storeLayer,
} from '../src/workgraph'

// The stats row's Done today (spec §18.3): the project's tickets merged or closed with no change since
// the engine host's local midnight, whichever run closed them, against an in-memory work graph under
// `TestClock`, in a named zone standing for the host's.

const graphLayer = Layer.effect(
  WorkGraph,
  makeWorkGraph({ prefix: 'fa' }),
).pipe(
  Layer.provideMerge(storeLayer(':memory:')),
  Layer.provideMerge(DateTime.layerCurrentZoneNamed('Europe/Athens')),
)

const actor: Actor = { _tag: 'maintainer' }

/** Thursday 29 October 2026, 23:30 in Athens (21:30 UTC): half an hour before the host's midnight. */
const beforeMidnight = Date.UTC(2026, 9, 29, 21, 30, 0)
/** Friday 30 October 2026, 00:30 in Athens (22:30 UTC): still the 29th in UTC. */
const afterMidnight = Date.UTC(2026, 9, 29, 22, 30, 0)

const commit = CommitHash.make('0123456789abcdef0123456789abcdef01234567')

const filed = (title: string) =>
  Effect.flatMap(WorkGraph, graph =>
    Effect.map(
      graph.create({ ticket: { type: 'task', title }, actor }),
      ticket => ticket.id,
    ),
  )

/** The ticket merged as the merge queue merges one: its commit set, then closed as done. */
const merged = (id: TicketId) =>
  Effect.gen(function* () {
    const graph = yield* WorkGraph
    yield* graph.update({
      id,
      changes: { mergedCommit: Option.some(commit) },
      actor,
    })
    yield* graph.close({ id, resolution: 'done', actor })
  })

const closed = (id: TicketId, resolution: 'done' | 'no_change' | 'cancelled') =>
  Effect.flatMap(WorkGraph, graph => graph.close({ id, resolution, actor }))

const doneNow = Effect.flatMap(WorkGraph, doneToday)

describe('done today', () => {
  it.effect(
    "counts tickets merged or closed with no change since the host's midnight",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(beforeMidnight)
        yield* merged(yield* filed('merged yesterday'))
        yield* closed(yield* filed('no change yesterday'), 'no_change')
        expect(yield* doneNow).toBe(2)

        yield* TestClock.setTime(afterMidnight)
        expect(yield* doneNow).toBe(0)
        yield* merged(yield* filed('merged today'))
        yield* closed(yield* filed('no change today'), 'no_change')
        expect(yield* doneNow).toBe(2)
      }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('leaves out a ticket closed as done unmerged, or cancelled', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(afterMidnight)
      yield* closed(yield* filed('closed by hand'), 'done')
      yield* closed(yield* filed('cancelled'), 'cancelled')
      yield* merged(yield* filed('merged'))
      expect(yield* doneNow).toBe(1)
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect(
    'counts a ticket by its last close, and not once it is reopened',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        yield* TestClock.setTime(beforeMidnight)
        const again = yield* filed('closed yesterday, again today')
        const reopened = yield* filed('closed today, then reopened')
        yield* closed(again, 'no_change')
        yield* graph.reopen({ id: again, actor })

        yield* TestClock.setTime(afterMidnight)
        yield* closed(again, 'no_change')
        yield* closed(reopened, 'no_change')
        yield* graph.reopen({ id: reopened, actor })
        expect(yield* doneNow).toBe(1)
      }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('counts the tickets of every run the same day', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      yield* TestClock.setTime(afterMidnight)
      yield* merged(yield* filed("the first run's"))
      yield* TestClock.setTime(afterMidnight + 6 * 60 * 60 * 1000)
      yield* merged(yield* filed("the second run's"))
      expect(yield* doneNow).toBe(2)
      expect(
        yield* graph.doneSince(
          DateTime.makeUnsafe(afterMidnight + 60 * 60 * 1000),
        ),
      ).toBe(1)
    }).pipe(Effect.provide(graphLayer)),
  )
})
