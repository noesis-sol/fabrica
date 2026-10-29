import { Effect, Layer } from 'effect'

import { describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  Edge,
  type EdgeKind,
  type Ticket,
} from '@fabrica/contracts'

import { WorkGraph, makeWorkGraph, storeLayer } from '../src/workgraph'

// Every link of the work graph at once (spec §18.4): what the Backlog screen's graph draws, read in
// one go rather than ticket by ticket, against an in-memory work graph.

const graphLayer = Layer.effect(
  WorkGraph,
  makeWorkGraph({ prefix: 'fa' }),
).pipe(Layer.provide(storeLayer(':memory:')))

const maintainer: Actor = { _tag: 'maintainer' }

const file = (title: string) =>
  Effect.flatMap(WorkGraph, graph =>
    graph.create({ ticket: { type: 'task', title }, actor: maintainer }),
  )

const link = (from: Ticket, to: Ticket, kind: EdgeKind) =>
  Effect.flatMap(WorkGraph, graph =>
    graph.addDependency({
      edge: new Edge({ from: from.id, to: to.id, kind }),
      actor: maintainer,
    }),
  )

const edges = Effect.flatMap(WorkGraph, graph => graph.edges())

describe('edges', () => {
  it.effect('gives none for a work graph without links', () =>
    Effect.gen(function* () {
      yield* file('Login form')
      expect(yield* edges).toEqual([])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('gives every link, by kind, then its tickets', () =>
    Effect.gen(function* () {
      const login = yield* file('Login form')
      const session = yield* file('Session store')
      const docs = yield* file('Document the login')
      yield* link(session, login, 'blocks')
      yield* link(docs, login, 'related')
      yield* link(login, docs, 'blocks')
      expect(
        (yield* edges).map(({ from, to, kind }) => ({ from, to, kind })),
      ).toEqual(
        [
          { from: login.id, to: docs.id, kind: 'blocks' },
          { from: session.id, to: login.id, kind: 'blocks' },
          { from: docs.id, to: login.id, kind: 'related' },
        ].toSorted(
          (a, b) =>
            a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from),
        ),
      )
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('leaves out a link once it is removed', () =>
    Effect.gen(function* () {
      const login = yield* file('Login form')
      const session = yield* file('Session store')
      const edge = new Edge({ from: session.id, to: login.id, kind: 'blocks' })
      yield* link(session, login, 'blocks')
      const graph = yield* WorkGraph
      yield* graph.removeDependency({ edge, actor: maintainer })
      expect(yield* edges).toEqual([])
    }).pipe(Effect.provide(graphLayer)),
  )
})
