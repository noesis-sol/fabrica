import { type DateTime, Effect } from 'effect'

import { startOfToday } from '../time/timestamps'
import type { StoreFailed } from './errors'
import type { WorkGraphShape } from './service'

// The stats row's Done today (spec §18.3): the project's tickets merged or closed with no change since
// the engine host's local midnight, whichever run closed them, so that a run crossing midnight or a
// second run the same day counts the day's and not its own. The run view's projection draws it with
// its totals, and again as the day changes.

/** How many of the graph's tickets were merged or closed with no change today, in the current zone. */
export const doneToday = (
  graph: WorkGraphShape,
): Effect.Effect<number, StoreFailed, DateTime.CurrentTimeZone> =>
  Effect.flatMap(startOfToday, graph.doneSince)
