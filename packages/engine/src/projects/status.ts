import { Effect, Option, PubSub, Ref, Semaphore, Stream } from 'effect'

import {
  type ProjectId,
  type ProjectStatus,
  ProjectStatusItem,
  type Resume,
  ResumePlan,
  StreamEpoch,
  planResume,
} from '@fabrica/contracts'

import { drawBase36 } from '../workgraph/ids'

// The project status stream (spec §8.1, §8.3, §18.3): the sidebar's rows, sent as a snapshot, then a
// patch for each change, each numbered. A row that changes nothing is no patch. The feed keeps its
// last patches, so a client that reconnects gets those after its last number (`planResume`), and one
// too far behind, or of an engine that has since restarted (another epoch), a snapshot. A change and a
// subscription take the same lock, so a subscriber sees every patch after its first item, once.

/** How many patches the feed keeps for clients that reconnect. */
const keptPatches = 256

interface Numbered {
  readonly seq: number
  readonly upsert: ReadonlyArray<ProjectStatus>
  readonly remove: ReadonlyArray<ProjectId>
}

interface FeedState {
  /** The last number given: the snapshot's, or the last patch's. */
  readonly seq: number
  readonly rows: ReadonlyArray<ProjectStatus>
  /** The last patches, oldest first. */
  readonly patches: ReadonlyArray<Numbered>
}

export interface StatusFeed {
  /** Sets the project's row, a new one at the end. */
  readonly upsert: (row: ProjectStatus) => Effect.Effect<void>
  /** Drops the project's row. */
  readonly remove: (project: ProjectId) => Effect.Effect<void>
  /** The rows, as a snapshot or the patches after `resume`, then every patch as it is made. */
  readonly watch: (
    resume: Option.Option<Resume>,
  ) => Stream.Stream<ProjectStatusItem>
}

/** Whether two rows say the same. */
const sameRow = (a: ProjectStatus, b: ProjectStatus): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

const patchItem = (patch: Numbered): ProjectStatusItem =>
  ProjectStatusItem.cases.patch.make({
    seq: patch.seq,
    value: { upsert: patch.upsert, remove: patch.remove },
  })

/** A feed whose first rows are `rows`. */
export const makeStatusFeed = Effect.fn('Projects.makeStatusFeed')(function* (
  rows: ReadonlyArray<ProjectStatus>,
) {
  const epoch = StreamEpoch.make(`projects-${yield* drawBase36(12)}`)
  const state = yield* Ref.make<FeedState>({ seq: 0, rows, patches: [] })
  const patches = yield* PubSub.unbounded<Numbered>()
  const lock = yield* Semaphore.make(1)

  /** Applies `change` to the rows; where it changes them, numbers it and sends it. */
  const apply = (
    change: (rows: ReadonlyArray<ProjectStatus>) => Option.Option<{
      readonly rows: ReadonlyArray<ProjectStatus>
      readonly upsert: ReadonlyArray<ProjectStatus>
      readonly remove: ReadonlyArray<ProjectId>
    }>,
  ) =>
    lock.withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state)
        const changed = change(current.rows)
        if (Option.isNone(changed)) return
        const patch: Numbered = {
          seq: current.seq + 1,
          upsert: changed.value.upsert,
          remove: changed.value.remove,
        }
        yield* Ref.set(state, {
          seq: patch.seq,
          rows: changed.value.rows,
          patches: [...current.patches, patch].slice(-keptPatches),
        })
        yield* PubSub.publish(patches, patch)
      }),
    )

  const upsert = (row: ProjectStatus) =>
    apply(rows => {
      const index = rows.findIndex(({ project }) => project === row.project)
      const found = rows[index]
      if (found !== undefined && sameRow(found, row)) return Option.none()
      return Option.some({
        rows:
          found === undefined
            ? [...rows, row]
            : rows.map((each, n) => (n === index ? row : each)),
        upsert: [row],
        remove: [],
      })
    })

  const remove = (project: ProjectId) =>
    apply(rows =>
      rows.some(row => row.project === project)
        ? Option.some({
            rows: rows.filter(row => row.project !== project),
            upsert: [],
            remove: [project],
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
          const first: ReadonlyArray<ProjectStatusItem> = ResumePlan.$match(
            plan,
            {
              Snapshot: () => [
                ProjectStatusItem.cases.snapshot.make({
                  epoch,
                  seq: current.seq,
                  value: current.rows,
                }),
              ],
              PatchesAfter: ({ after }) =>
                current.patches
                  .filter(patch => patch.seq > after)
                  .map(patchItem),
            },
          )
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

  return { upsert, remove, watch } satisfies StatusFeed
})
