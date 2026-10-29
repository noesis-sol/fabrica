import { InsightsRpcs } from '@fabrica/contracts'

import { notImplemented } from './not-implemented'

// The Insights group's handlers (spec §8.1, §21). Not served yet: each answers `NotImplemented` until the
// ticket that builds the group fills this file, with the service layers its handlers need.

/** The Insights group's handlers. */
export const insightsHandlers = InsightsRpcs.toLayer({
  'insights.summary': notImplemented('insights.summary'),
  'insights.query': notImplemented('insights.query'),
})
