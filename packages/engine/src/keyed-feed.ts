import { Effect, Option, PubSub, Ref, Semaphore, Stream } from 'effect'

import {
  type Resume,
  ResumePlan,
  type Sequence,
  StreamEpoch,
  planResume,
} from '@fabrica/contracts'

import { drawBase36 } from './workgraph/ids'

// A stream of a list of things with keys (spec §8.3): the projects' rows, a project's tickets. It is
// sent as a snapshot, then a patch for each change, each numbered. An item that says what it said
// before is no patch, unless it is sent again for what it doesn't carry. The feed keeps its last patches, so a client that reconnects gets those after
// its last number (`planResume`), and one too far behind, or of an engine that has since restarted
// (another epoch), a snapshot. A change and a subscription take the same lock, so a subscriber sees
// every patch after its first item, once.

/** How many patches a feed keeps for clients that reconnect. */
const keptPatches = 256

interface Numbered<A, K> {
  readonly seq: number
  readonly upsert: ReadonlyArray<A>
  readonly remove: ReadonlyArray<K>
}

interface FeedState<A, K> {
  /** The last number given: the snapshot's, or the last patch's. */
  readonly seq: number
  readonly items: ReadonlyArray<A>
  /** The last patches, oldest first. */
  readonly patches: ReadonlyArray<Numbered<A, K>>
}

export interface KeyedFeed<A, K, Item> {
  /** Sets the item with its key, a new one at the end. */
  readonly upsert: (item: A) => Effect.Effect<void>
  /** Sends the item again though it says the same: something it doesn't carry changed (a ticket's links). */
  readonly resend: (item: A) => Effect.Effect<void>
  /** Drops the item with the key. */
  readonly remove: (key: K) => Effect.Effect<void>
  /** The items, as a snapshot or the patches after `resume`, then every patch as it is made. */
  readonly watch: (resume: Option.Option<Resume>) => Stream.Stream<Item>
}

/** What a feed is made of: its first items, their keys, and the constructors of its stream's items. */
export interface KeyedFeedOptions<A, K, Item> {
  /** Starts each epoch's name: `projects`, `backlog`. */
  readonly name: string
  readonly items: ReadonlyArray<A>
  readonly keyOf: (item: A) => K
  readonly snapshot: (snapshot: {
    readonly epoch: StreamEpoch
    readonly seq: Sequence
    readonly value: ReadonlyArray<A>
  }) => Item
  readonly patch: (patch: {
    readonly seq: Sequence
    readonly value: {
      readonly upsert: ReadonlyArray<A>
      readonly remove: ReadonlyArray<K>
    }
  }) => Item
}

/** Whether two items say the same. */
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/** A feed whose first items are `options.items`. */
export const makeKeyedFeed = Effect.fn('KeyedFeed.make')(function* <A, K, Item>(
  options: KeyedFeedOptions<A, K, Item>,
) {
  const { keyOf } = options
  const epoch = StreamEpoch.make(`${options.name}-${yield* drawBase36(12)}`)
  const state = yield* Ref.make<FeedState<A, K>>({
    seq: 0,
    items: options.items,
    patches: [],
  })
  const patches = yield* PubSub.unbounded<Numbered<A, K>>()
  const lock = yield* Semaphore.make(1)

  const patchItem = (patch: Numbered<A, K>): Item =>
    options.patch({
      seq: patch.seq,
      value: { upsert: patch.upsert, remove: patch.remove },
    })

  /** Applies `change` to the items; where it changes them, numbers it and sends it. */
  const apply = (
    change: (items: ReadonlyArray<A>) => Option.Option<{
      readonly items: ReadonlyArray<A>
      readonly upsert: ReadonlyArray<A>
      readonly remove: ReadonlyArray<K>
    }>,
  ) =>
    lock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        const changed = change(current.items)
        if (Option.isNone(changed)) return
        const patch: Numbered<A, K> = {
          seq: current.seq + 1,
          upsert: changed.value.upsert,
          remove: changed.value.remove,
        }
        yield* Ref.set(state, {
          seq: patch.seq,
          items: changed.value.items,
          patches: [...current.patches, patch].slice(-keptPatches),
        })
        yield* PubSub.publish(patches, patch)
      }),
    )

  /** Sets the item; `always` sends it though it says what it said before. */
  const put = (item: A, always: boolean) =>
    apply(items => {
      const key = keyOf(item)
      const index = items.findIndex(each => keyOf(each) === key)
      const found = items[index]
      if (found !== undefined && !always && same(found, item))
        return Option.none()
      return Option.some({
        items:
          found === undefined
            ? [...items, item]
            : items.map((each, n) => (n === index ? item : each)),
        upsert: [item],
        remove: [],
      })
    })

  const upsert = (item: A) => put(item, false)

  const resend = (item: A) => put(item, true)

  const remove = (key: K) =>
    apply(items =>
      items.some(item => keyOf(item) === key)
        ? Option.some({
            items: items.filter(item => keyOf(item) !== key),
            upsert: [],
            remove: [key],
          })
        : Option.none(),
    )

  const watch = (resume: Option.Option<Resume>) =>
    Stream.unwrap(
      lock.withPermit(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(patches)
          const current = yield* Ref.get(state)
          const plan = planResume({
            resume,
            epoch,
            oldest: current.patches[0]?.seq ?? current.seq + 1,
            latest: current.seq,
          })
          const first: ReadonlyArray<Item> = ResumePlan.$match(plan, {
            Snapshot: () => [
              options.snapshot({
                epoch,
                seq: current.seq,
                value: current.items,
              }),
            ],
            PatchesAfter: ({ after }) =>
              current.patches.filter(patch => patch.seq > after).map(patchItem),
          })
          return Stream.concat(
            Stream.fromIterable(first),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter(patch => patch.seq > current.seq),
              Stream.map(patchItem),
            ),
          )
        }),
      ),
    )

  return { upsert, resend, remove, watch } satisfies KeyedFeed<A, K, Item>
})
