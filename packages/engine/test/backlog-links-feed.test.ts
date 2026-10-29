import { Effect, Layer, Option, Stream } from 'effect'

import { describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  BacklogItem,
  Edge,
  LabelName,
  Resume,
  type Ticket,
  type TicketId,
} from '@fabrica/contracts'

import { makeKeyedFeed } from '../src/keyed-feed'
import { sendChange } from '../src/rpc/backlog'
import { WorkGraph, makeWorkGraph, storeLayer } from '../src/workgraph'

// The backlog stream on a link's change (spec §8.3, §18.4): a link added or removed changes no
// ticket, yet its ticket is sent again, so a client drawing the links (the Backlog screen's graph) asks
// for them afresh; any other change that leaves its ticket as it was sends nothing. Against an
// in-memory work graph and the backlog's keyed feed.

const graphLayer = Layer.effect(
  WorkGraph,
  makeWorkGraph({ prefix: 'fa' }),
).pipe(Layer.provide(storeLayer(':memory:')))

const maintainer: Actor = { _tag: 'maintainer' }

/** The patches the feed sent after its snapshot, each as the IDs it upserts and removes. */
const patchesOf = (items: ReadonlyArray<BacklogItem>) =>
  items.map(item =>
    BacklogItem.match(item, {
      snapshot: () => 'snapshot',
      patch: ({ value }) => ({
        upsert: value.upsert.map(ticket => ticket.id),
        remove: value.remove,
      }),
    }),
  )

describe('a link changed', () => {
  it.effect(
    'sends its ticket again; a label, which leaves it as it was, sends nothing',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const graph = yield* WorkGraph
          const changes = yield* graph.changes
          const login = yield* graph.create({
            ticket: { type: 'task', title: 'Login form' },
            actor: maintainer,
          })
          const session = yield* graph.create({
            ticket: { type: 'task', title: 'Session store' },
            actor: maintainer,
          })
          const feed = yield* makeKeyedFeed<Ticket, TicketId, BacklogItem>({
            name: 'backlog',
            items: yield* graph.list(),
            keyOf: ticket => ticket.id,
            snapshot: BacklogItem.cases.snapshot.make,
            patch: BacklogItem.cases.patch.make,
          })
          const first = yield* Stream.runHead(feed.watch(Option.none()))
          const snapshot = Option.getOrThrow(first)
          if (snapshot._tag !== 'snapshot') return expect.unreachable()

          const edge = new Edge({
            from: session.id,
            to: login.id,
            kind: 'blocks',
          })
          yield* graph.label({
            id: login.id,
            label: LabelName.make('auth'),
            actor: maintainer,
          })
          yield* graph.addDependency({ edge, actor: maintainer })
          yield* graph.removeDependency({ edge, actor: maintainer })
          // The two filings, the label, the link and its removal.
          yield* changes.pipe(
            Stream.take(5),
            Stream.runForEach(sendChange(graph, feed)),
          )

          const resumed = yield* feed
            .watch(
              Option.some(
                new Resume({ epoch: snapshot.epoch, after: snapshot.seq }),
              ),
            )
            .pipe(Stream.take(2), Stream.runCollect)
          expect(patchesOf(resumed)).toEqual([
            { upsert: [session.id], remove: [] },
            { upsert: [session.id], remove: [] },
          ])
          // Those two, and nothing else: a new subscriber's snapshot is two patches on.
          const after = Option.getOrThrow(
            yield* Stream.runHead(feed.watch(Option.none())),
          )
          expect(after._tag === 'snapshot' && after.seq).toBe(snapshot.seq + 2)
        }),
      ).pipe(Effect.provide(graphLayer)),
  )
})
