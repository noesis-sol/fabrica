import { Effect } from 'effect'

import {
  type ProjectId,
  type ProjectStatus,
  ProjectStatusItem,
} from '@fabrica/contracts'

import { type KeyedFeed, makeKeyedFeed } from '../keyed-feed'

// The project status stream (spec §8.1, §8.3, §18.3): the sidebar's rows, each keyed by its project,
// sent as a snapshot, then a patch for each change, numbered and resumed as every keyed feed is.

export type StatusFeed = KeyedFeed<ProjectStatus, ProjectId, ProjectStatusItem>

/** A feed whose first rows are `rows`. */
export const makeStatusFeed = Effect.fn('Projects.makeStatusFeed')(function* (
  rows: ReadonlyArray<ProjectStatus>,
) {
  return yield* makeKeyedFeed<ProjectStatus, ProjectId, ProjectStatusItem>({
    name: 'projects',
    items: rows,
    keyOf: row => row.project,
    snapshot: ProjectStatusItem.cases.snapshot.make,
    patch: ProjectStatusItem.cases.patch.make,
  })
})
