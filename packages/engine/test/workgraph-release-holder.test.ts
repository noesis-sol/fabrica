import { Effect, Layer, Option } from 'effect'

import { describe, expect, it } from '@effect/vitest'
import { type Actor, Assignee, EngineId, SessionId } from '@fabrica/contracts'

import {
  TransitionRefused,
  WorkGraph,
  makeWorkGraph,
  storeLayer,
} from '../src/workgraph'

// Releasing a claim by its holder (spec §11.5): only that holder's claim is given back, in one step with the
// read of whose it is, so a dispatch never frees another session's or engine's.

const graphLayer = Layer.effect(
  WorkGraph,
  makeWorkGraph({ prefix: 'fa' }),
).pipe(Layer.provideMerge(storeLayer(':memory:')))

const maintainer: Actor = { _tag: 'maintainer' }
const engine = EngineId.make('engine-1')
const holder = new Assignee({ engine, session: SessionId.make('session-1') })

describe('release with a holder', () => {
  it.effect("gives back its holder's claim", () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const { id } = yield* graph.create({
        ticket: { type: 'task', title: 'Claimed' },
        actor: maintainer,
      })
      yield* graph.claim({ id, assignee: holder, actor: maintainer })
      const released = yield* graph.release({ id, holder, actor: maintainer })
      expect(released.status).toBe('open')
      expect(released.assignee).toEqual(Option.none())
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect.each([
    {
      of: 'session',
      other: new Assignee({ engine, session: SessionId.make('session-2') }),
    },
    {
      of: 'engine',
      other: new Assignee({
        engine: EngineId.make('engine-2'),
        session: holder.session,
      }),
    },
  ])('refuses a claim of another $of, and leaves it', ({ other }) =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const { id } = yield* graph.create({
        ticket: { type: 'task', title: 'Claimed' },
        actor: maintainer,
      })
      yield* graph.claim({ id, assignee: other, actor: maintainer })
      expect(
        yield* Effect.flip(graph.release({ id, holder, actor: maintainer })),
      ).toEqual(
        new TransitionRefused({
          id,
          operation: 'release',
          status: 'in_progress',
        }),
      )
      const { ticket } = yield* graph.show(id)
      expect(ticket.status).toBe('in_progress')
      expect(ticket.assignee).toEqual(Option.some(other))
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('refuses a ticket no longer in progress', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const { id } = yield* graph.create({
        ticket: { type: 'task', title: 'Open' },
        actor: maintainer,
      })
      expect(
        yield* Effect.flip(graph.release({ id, holder, actor: maintainer })),
      ).toBeInstanceOf(TransitionRefused)
    }).pipe(Effect.provide(graphLayer)),
  )
})
