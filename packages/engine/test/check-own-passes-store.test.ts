import { Effect, Layer, Option } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  Assignee,
  EngineId,
  SessionId,
  Ticket,
  TicketId,
  TreeHash,
} from '@fabrica/contracts'

import { CheckOwnPasses, checkOwnPassesLayer } from '../src/control'
import {
  TicketNotFound,
  WorkGraph,
  makeWorkGraph,
  storeLayer,
} from '../src/workgraph'

// `check_own`'s passes kept in the work graph's store (spec §11.2, §13.6, H89): by ticket and tree,
// the last one known, kept across the engine's restarts for the carry-over, and dropped as the
// ticket closes or is deleted.

/** The work graph on the database at `filename`, its passes as the control server sees them beside it. */
const graphLayer = (filename: string) =>
  checkOwnPassesLayer.pipe(
    Layer.provideMerge(
      Layer.effect(WorkGraph, makeWorkGraph({ prefix: 'fa' })),
    ),
    Layer.provide(storeLayer(filename)),
  )

const maintainer: Actor = { _tag: 'maintainer' }
const assignee = new Assignee({
  engine: EngineId.make('engine-1'),
  session: SessionId.make('session-1'),
})

const treeA = TreeHash.make('a'.repeat(40))
const treeB = TreeHash.make('b'.repeat(40))

/** A task filed and claimed for a worker, as a ticket with a `check_own` is. */
const claimed = (title: string) =>
  Effect.gen(function* () {
    const graph = yield* WorkGraph
    const ticket = yield* graph.create({
      ticket: { type: 'task', title },
      actor: maintainer,
    })
    yield* graph.claim({ id: ticket.id, assignee, actor: maintainer })
    return ticket.id
  })

/** A temporary folder for one test, removed when the test ends. */
const scratch = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(NodePath.join(tmpdir(), 'fabrica-passes-'))),
  folder => Effect.promise(() => rm(folder, { recursive: true, force: true })),
)

describe('check_own passes in the store', () => {
  it.effect('keeps each pass by tree, the last one recorded the last', () =>
    Effect.gen(function* () {
      const passes = yield* CheckOwnPasses
      const ticket = yield* claimed('Checked')
      const other = yield* claimed('Unchecked')
      expect(yield* passes.last(ticket)).toEqual(Option.none())
      expect(yield* passes.passed({ ticket, tree: treeA })).toBe(false)

      yield* passes.record({ ticket, tree: treeA })
      yield* passes.record({ ticket, tree: treeB })
      expect(yield* passes.passed({ ticket, tree: treeA })).toBe(true)
      expect(yield* passes.passed({ ticket, tree: treeB })).toBe(true)
      expect(yield* passes.last(ticket)).toEqual(Option.some(treeB))

      // A pass on a tree passed before becomes the last again.
      yield* passes.record({ ticket, tree: treeA })
      expect(yield* passes.last(ticket)).toEqual(Option.some(treeA))

      expect(yield* passes.passed({ ticket: other, tree: treeA })).toBe(false)
      expect(yield* passes.last(other)).toEqual(Option.none())
    }).pipe(Effect.provide(graphLayer(':memory:'))),
  )

  it.effect('refuses a pass of a ticket the graph hasn’t', () =>
    Effect.gen(function* () {
      const passes = yield* CheckOwnPasses
      const missing = TicketId.make('fa-none')
      expect(
        yield* Effect.flip(passes.record({ ticket: missing, tree: treeA })),
      ).toEqual(new TicketNotFound({ id: missing }))
    }).pipe(Effect.provide(graphLayer(':memory:'))),
  )

  it.effect('keeps the passes across the engine’s restart', () =>
    Effect.gen(function* () {
      const filename = NodePath.join(yield* scratch, 'work.db')
      const ticket = yield* Effect.gen(function* () {
        const passes = yield* CheckOwnPasses
        const ticket = yield* claimed('Carried over')
        yield* passes.record({ ticket, tree: treeA })
        yield* passes.record({ ticket, tree: treeB })
        return ticket
      }).pipe(Effect.provide(graphLayer(filename)))

      yield* Effect.gen(function* () {
        const passes = yield* CheckOwnPasses
        expect(yield* passes.passed({ ticket, tree: treeA })).toBe(true)
        expect(yield* passes.last(ticket)).toEqual(Option.some(treeB))
      }).pipe(Effect.provide(graphLayer(filename)))
    }).pipe(Effect.scoped),
  )

  it.effect('drops a ticket’s passes as it closes, and only its own', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const passes = yield* CheckOwnPasses
      const merged = yield* claimed('Merged')
      const running = yield* claimed('Running')
      yield* passes.record({ ticket: merged, tree: treeA })
      yield* passes.record({ ticket: running, tree: treeA })

      yield* graph.close({ id: merged, resolution: 'done', actor: maintainer })
      expect(yield* passes.passed({ ticket: merged, tree: treeA })).toBe(false)
      expect(yield* passes.last(merged)).toEqual(Option.none())
      expect(yield* passes.passed({ ticket: running, tree: treeA })).toBe(true)

      // Reopened, it checks afresh.
      yield* graph.reopen({ id: merged, actor: maintainer })
      expect(yield* passes.last(merged)).toEqual(Option.none())
    }).pipe(Effect.provide(graphLayer(':memory:'))),
  )

  it.effect('drops a ticket’s passes as an import closes it', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const passes = yield* CheckOwnPasses
      const ticket = yield* claimed('Closed elsewhere')
      yield* passes.record({ ticket, tree: treeA })
      const { ticket: ours } = yield* graph.show(ticket)
      yield* graph.importTickets({
        tickets: [
          {
            ticket: new Ticket({
              ...ours,
              status: 'closed',
              resolution: Option.some('done'),
            }),
            labels: [],
            notes: [],
          },
        ],
        edges: [],
        actor: maintainer,
      })
      expect((yield* graph.show(ticket)).ticket.status).toBe('closed')
      expect(yield* passes.last(ticket)).toEqual(Option.none())
    }).pipe(Effect.provide(graphLayer(':memory:'))),
  )

  it.effect('drops a ticket’s passes as it is deleted', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const passes = yield* CheckOwnPasses
      const ticket = yield* claimed('Gone')
      yield* passes.record({ ticket, tree: treeA })
      yield* graph.delete({ id: ticket, actor: maintainer })
      expect(yield* passes.passed({ ticket, tree: treeA })).toBe(false)
    }).pipe(Effect.provide(graphLayer(':memory:'))),
  )
})
