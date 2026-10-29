import { ReviewRpcs } from '@fabrica/contracts'

import { notImplemented } from './not-implemented'

// The Review group's handlers (spec §8.1). Not served yet: each answers `NotImplemented` until the
// ticket that builds the group fills this file, with the service layers its handlers need.

/** The Review group's handlers. */
export const reviewHandlers = ReviewRpcs.toLayer({
  'diff.ticket': notImplemented('diff.ticket'),
  'diff.run': notImplemented('diff.run'),
  'report.get': notImplemented('report.get'),
  'log.tail': notImplemented('log.tail'),
})
