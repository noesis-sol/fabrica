import {
  Data,
  Duration,
  Effect,
  Option,
  PubSub,
  Ref,
  Scope,
  Semaphore,
  Stream,
} from 'effect'

import {
  type Resume,
  ResumePlan,
  StreamEpoch,
  type TranscriptEntry,
  TranscriptItem,
  planResume,
} from '@fabrica/contracts'

import { drawBase36 } from './workgraph/ids'

// A session's transcript as a stream (spec §8.3, H40): a snapshot of the entries so far, then a patch
// of the entries since, each numbered. Entries wait in the feed until it flushes, `flush` after the
// first of them (`stream_flush`), or at once when its writer asks, so tokens cross in batches. The
// feed keeps its last patches for clients that reconnect (`planResume`); a client too far behind, or
// of another epoch, gets a snapshot. A flush and a subscription take the same lock, so a subscriber
// sees every patch after its first item, once. Ended, the feed flushes and every watch ends; a watch
// begun after the end gets the transcript so far, and ends. Reopened, it takes writes again.

/** How many patches a feed keeps for clients that reconnect. */
const keptPatches = 256

interface Numbered {
  readonly seq: number
  readonly entries: ReadonlyArray<TranscriptEntry>
}

/** What a watcher is sent. */
type Published = Data.TaggedEnum<{
  Patch: { readonly patch: Numbered }
  End: {}
}>
const Published = Data.taggedEnum<Published>()

interface FeedState {
  /** The last number given: the snapshot's, or the last patch's. */
  readonly seq: number
  readonly entries: ReadonlyArray<TranscriptEntry>
  readonly patches: ReadonlyArray<Numbered>
  /** Entries written and not flushed yet. */
  readonly pending: ReadonlyArray<TranscriptEntry>
  /** A flush is waited on. */
  readonly timed: boolean
  readonly ended: boolean
}

export interface TranscriptFeed {
  /** Adds entries, sent with the next flush. */
  readonly write: (
    entries: ReadonlyArray<TranscriptEntry>,
  ) => Effect.Effect<void>
  /** Sends the entries waiting, as one patch. */
  readonly flush: Effect.Effect<void>
  /** The transcript, as a snapshot or the patches after `resume`, then each patch, until the feed ends. */
  readonly watch: (
    resume: Option.Option<Resume>,
  ) => Stream.Stream<TranscriptItem>
  /** Flushes, and ends every watch. */
  readonly end: Effect.Effect<void>
  /** Takes writes again after an end, for the watches begun after it. */
  readonly reopen: Effect.Effect<void>
}

/** A feed whose flushes wait in `scope`, named `name` in its epochs. */
export const makeTranscriptFeed = Effect.fn('TranscriptFeed.make')(
  function* (options: {
    readonly name: string
    readonly flush: Duration.Duration
    readonly scope: Scope.Scope
  }) {
    const epoch = StreamEpoch.make(`${options.name}-${yield* drawBase36(12)}`)
    const state = yield* Ref.make<FeedState>({
      seq: 0,
      entries: [],
      patches: [],
      pending: [],
      timed: false,
      ended: false,
    })
    const published = yield* PubSub.unbounded<Published>()
    const lock = yield* Semaphore.make(1)

    const patchItem = ({ seq, entries }: Numbered): TranscriptItem =>
      TranscriptItem.cases.patch.make({ seq, value: entries })

    const flush = lock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        if (current.pending.length === 0) {
          yield* Ref.set(state, { ...current, timed: false })
          return
        }
        const patch: Numbered = {
          seq: current.seq + 1,
          entries: current.pending,
        }
        yield* Ref.set(state, {
          ...current,
          seq: patch.seq,
          entries: [...current.entries, ...current.pending],
          patches: [...current.patches, patch].slice(-keptPatches),
          pending: [],
          timed: false,
        })
        yield* PubSub.publish(published, Published.Patch({ patch }))
      }),
    )

    const write = (entries: ReadonlyArray<TranscriptEntry>) =>
      Effect.gen(function* () {
        if (entries.length === 0) return
        const time = yield* Ref.modify(
          state,
          (current): [boolean, FeedState] => [
            !current.timed && !current.ended,
            current.ended
              ? current
              : {
                  ...current,
                  pending: [...current.pending, ...entries],
                  timed: true,
                },
          ],
        )
        if (time)
          yield* Effect.forkIn(
            Effect.andThen(Effect.sleep(options.flush), flush),
            options.scope,
          )
      })

    const end = Effect.gen(function* () {
      yield* flush
      yield* lock.withPermit(
        Effect.andThen(
          Ref.update(state, current => ({ ...current, ended: true })),
          PubSub.publish(published, Published.End()),
        ),
      )
    })

    const reopen = lock.withPermit(
      Ref.update(state, current => ({ ...current, ended: false })),
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
            const first: ReadonlyArray<TranscriptItem> = ResumePlan.$match(
              plan,
              {
                Snapshot: () => [
                  TranscriptItem.cases.snapshot.make({
                    epoch,
                    seq: current.seq,
                    value: current.entries,
                  }),
                ],
                PatchesAfter: ({ after }) =>
                  current.patches
                    .filter(patch => patch.seq > after)
                    .map(patchItem),
              },
            )
            const rest: Stream.Stream<TranscriptItem> = current.ended
              ? Stream.empty
              : Stream.fromSubscription(subscription).pipe(
                  Stream.takeWhile(Published.$is('Patch')),
                  Stream.map(({ patch }) => patch),
                  Stream.filter(patch => patch.seq > current.seq),
                  Stream.map(patchItem),
                )
            return Stream.concat(Stream.fromIterable(first), rest)
          }),
        ),
      )

    return { write, flush, watch, end, reopen } satisfies TranscriptFeed
  },
)
