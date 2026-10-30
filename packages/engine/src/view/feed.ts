import {
  Data,
  DateTime,
  Effect,
  Option,
  PubSub,
  Ref,
  Semaphore,
  Stream,
} from 'effect'

import {
  type Resume,
  ResumePlan,
  type RunView,
  RunViewPatch,
  RunView as RunViewSchema,
  StreamEpoch,
  planResume,
  streamItem,
} from '@fabrica/contracts'

import { drawBase36 } from '../workgraph/ids'
import { viewPatch } from './patch'

// A run view as a stream (spec §8.3): a snapshot of the view, then a patch for each write that changed
// a part, each numbered. A write that changes nothing sends nothing and takes no number. The feed keeps
// its last patches, so a client that reconnects gets those after its last number (`planResume`), and
// one too far behind, or of an engine that has since restarted (another epoch), a snapshot. A write
// and a subscription take the same lock, so a subscriber sees every patch after its first item, once.
// Ended with its run, the feed ends every watch.

/** The run view stream's items. */
export const RunViewItem = streamItem(RunViewSchema, RunViewPatch)
export type RunViewItem = typeof RunViewItem.Type

/** How many patches a feed keeps for clients that reconnect. */
export const keptViewPatches = 256

interface Numbered {
  readonly seq: number
  readonly patch: RunViewPatch
}

type Published = Data.TaggedEnum<{
  Patch: { readonly numbered: Numbered }
  End: {}
}>
const Published = Data.taggedEnum<Published>()

interface FeedState {
  /** The last number given: the snapshot's, or the last patch's. */
  readonly seq: number
  readonly view: RunView
  /** The last patches, oldest first. */
  readonly patches: ReadonlyArray<Numbered>
  readonly ended: boolean
}

export interface ViewFeed {
  /** Sets the view; where a part changed, numbers its patch and sends it: whether it did. */
  readonly publish: (view: RunView) => Effect.Effect<boolean>
  /** The view as last published. */
  readonly current: Effect.Effect<RunView>
  /** The view, as a snapshot or the patches after `resume`, then every patch, until the feed ends. */
  readonly watch: (resume: Option.Option<Resume>) => Stream.Stream<RunViewItem>
  /** Ends every watch. */
  readonly end: Effect.Effect<void>
}

/** A feed whose first view is `view`. */
export const makeViewFeed = Effect.fn('ViewFeed.make')(function* (
  view: RunView,
) {
  const epoch = StreamEpoch.make(`view-${yield* drawBase36(12)}`)
  const state = yield* Ref.make<FeedState>({
    seq: 0,
    view,
    patches: [],
    ended: false,
  })
  const published = yield* PubSub.unbounded<Published>()
  const lock = yield* Semaphore.make(1)

  const patchItem = ({ seq, patch }: Numbered): RunViewItem =>
    RunViewItem.cases.patch.make({ seq, value: patch })

  const publish = (next: RunView) =>
    lock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (current.ended) return false
        const patch = viewPatch(current.view, next, yield* DateTime.now)
        if (Option.isNone(patch)) return false
        const numbered: Numbered = { seq: current.seq + 1, patch: patch.value }
        yield* Ref.set(state, {
          ...current,
          seq: numbered.seq,
          view: next,
          patches: [...current.patches, numbered].slice(-keptViewPatches),
        })
        yield* PubSub.publish(published, Published.Patch({ numbered }))
        return true
      }),
    )

  const end = lock.withPermit(
    Effect.andThen(
      Ref.update(state, current => ({ ...current, ended: true })),
      PubSub.publish(published, Published.End()),
    ),
  )

  const watch = (resume: Option.Option<Resume>) =>
    Stream.unwrap(
      lock.withPermit(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(published)
          const current = yield* Ref.get(state)
          const plan = planResume({
            resume,
            epoch,
            oldest: current.patches[0]?.seq ?? current.seq + 1,
            latest: current.seq,
          })
          const first: ReadonlyArray<RunViewItem> = ResumePlan.$match(plan, {
            Snapshot: () => [
              RunViewItem.cases.snapshot.make({
                epoch,
                seq: current.seq,
                value: current.view,
              }),
            ],
            PatchesAfter: ({ after }) =>
              current.patches
                .filter(numbered => numbered.seq > after)
                .map(patchItem),
          })
          const rest: Stream.Stream<RunViewItem> = current.ended
            ? Stream.empty
            : Stream.fromSubscription(subscription).pipe(
                Stream.takeWhile(Published.$is('Patch')),
                Stream.map(({ numbered }) => numbered),
                Stream.filter(numbered => numbered.seq > current.seq),
                Stream.map(patchItem),
              )
          return Stream.concat(Stream.fromIterable(first), rest)
        }),
      ),
    )

  return {
    publish,
    current: Effect.map(Ref.get(state), ({ view: now }) => now),
    watch,
    end,
  } satisfies ViewFeed
})
