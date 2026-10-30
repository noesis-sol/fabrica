import { Effect, Layer, Option, Schema } from 'effect'
import { Reactivity } from 'effect/reactivity'
import { SqlClient } from 'effect/sql'

import { describe, expect, it } from '@effect/vitest'
import { type Actor, type Edge, TreeItem } from '@fabrica/contracts'

import {
  InvalidTicket,
  type KeyedTicket,
  WorkGraph,
  fileTree,
  makeWorkGraph,
  storeLayer,
} from '../src/workgraph'

// A tree of tickets filed in one transaction (spec §11.2, §15.4): the tickets, their parent edges and
// their `blocks` edges committed together, the reactive queries invalidated once, and a refusal midway
// filing nothing.

const graphLayer = Layer.effect(
  WorkGraph,
  makeWorkGraph({ prefix: 'fa' }),
).pipe(Layer.provideMerge(storeLayer(':memory:')))

const maintainer: Actor = { _tag: 'maintainer' }

const keyed = (
  key: string,
  type: 'epic' | 'task',
  parent?: string,
): KeyedTicket => ({
  key,
  ticket: { type, title: `The ${key}` },
  parent: Option.fromUndefinedOr(parent),
})

/** The edges, each as its ends and kind. */
const edgeTexts = (edges: ReadonlyArray<Edge>) =>
  edges.map(edge => `${edge.from} ${edge.kind} ${edge.to}`).sort()

const countRows = (table: string) =>
  Effect.flatMap(SqlClient.SqlClient, sql =>
    Effect.map(
      sql<{ readonly n: number }>`SELECT count(*) AS n FROM ${sql(table)}`,
      rows => rows[0]?.n ?? 0,
    ),
  )

/** How many times the work graph's reactive queries are invalidated while `effect` runs. */
const invalidations = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const reactivity = yield* Reactivity.Reactivity
    let count = 0
    const cancel = reactivity.registerUnsafe(['work_graph'], () => {
      count += 1
    })
    const exit = yield* Effect.exit(effect)
    cancel()
    return { exit, count }
  })

describe('fileTickets', () => {
  it.effect(
    'files the tickets under their parents, then their waits, invalidating once',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const { exit, count } = yield* invalidations(
          graph.fileTickets({
            tickets: [
              keyed('root', 'epic'),
              keyed('a', 'task', 'root'),
              keyed('b', 'task', 'root'),
            ],
            waits: [{ waited: 'a', waiting: 'b' }],
            actor: maintainer,
          }),
        )
        expect(count).toBe(1)
        const filed = yield* exit
        expect(filed.map(item => item.key)).toEqual(['root', 'a', 'b'])
        const [root, a, b] = filed.map(item => item.id)
        expect(a).toBe(`${root}.1`)
        expect(b).toBe(`${root}.2`)
        expect(edgeTexts(yield* graph.edges())).toEqual(
          [
            `${a} blocks ${b}`,
            `${root} parent ${a}`,
            `${root} parent ${b}`,
          ].sort(),
        )
      }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('files nothing when a wait names a key it hasn’t filed', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const refused = yield* Effect.flip(
        graph.fileTickets({
          tickets: [keyed('root', 'epic'), keyed('a', 'task', 'root')],
          waits: [{ waited: 'gone', waiting: 'a' }],
          actor: maintainer,
        }),
      )
      expect(refused).toEqual(
        new InvalidTicket({ issue: "a waits on gone: gone isn't filed" }),
      )
      expect(yield* countRows('tickets')).toBe(0)
      expect(yield* countRows('edges')).toBe(0)
      expect(yield* countRows('events')).toBe(0)
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect(
    'files nothing when a parent comes after its child, or a key is given twice',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const late = yield* Effect.flip(
          graph.fileTickets({
            tickets: [keyed('a', 'task', 'root'), keyed('root', 'epic')],
            waits: [],
            actor: maintainer,
          }),
        )
        expect(late).toEqual(
          new InvalidTicket({
            issue: "a's parent root isn't filed before it",
          }),
        )
        const twice = yield* Effect.flip(
          graph.fileTickets({
            tickets: [keyed('root', 'epic'), keyed('root', 'epic')],
            waits: [],
            actor: maintainer,
          }),
        )
        expect(twice).toEqual(
          new InvalidTicket({ issue: 'the key root is given twice' }),
        )
        expect(yield* countRows('tickets')).toBe(0)
        expect(yield* countRows('events')).toBe(0)
      }).pipe(Effect.provide(graphLayer)),
  )
})

describe('fileTree', () => {
  it.effect('files a checked tree and its waits in one transaction', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const items = Schema.decodeUnknownSync(Schema.Array(TreeItem))([
        {
          key: 'root',
          type: 'epic',
          title: 'The feature',
          description: 'All of it.',
        },
        {
          key: 'first',
          type: 'task',
          title: 'The first part',
          description: 'One half.',
          parent: 'root',
          files: ['src/a.ts'],
        },
        {
          key: 'second',
          type: 'task',
          title: 'The second part',
          description: 'The other half.',
          parent: 'root',
          files: 'unknown',
          waitsOn: ['first'],
        },
      ])
      const { exit, count } = yield* invalidations(
        fileTree({ graph, items, spec: Option.none(), actor: maintainer }),
      )
      expect(count).toBe(1)
      const tree = yield* exit
      const [root, first, second] = tree.items.map(item => item.id)
      expect(tree.root).toBe(root)
      expect(edgeTexts(yield* graph.edges())).toEqual(
        [
          `${first} blocks ${second}`,
          `${root} parent ${first}`,
          `${root} parent ${second}`,
        ].sort(),
      )
      expect(yield* countRows('tickets')).toBe(3)
    }).pipe(Effect.provide(graphLayer)),
  )
})
