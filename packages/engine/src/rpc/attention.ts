import { AttentionRpcs } from '@fabrica/contracts'

import { notImplemented } from './not-implemented'

// The Attention group's handlers (spec §8.1, §15.1). Not served yet: each answers `NotImplemented` until the
// ticket that builds the group fills this file, with the service layers its handlers need.

/** The Attention group's handlers. */
export const attentionHandlers = AttentionRpcs.toLayer({
  'attention.list': notImplemented('attention.list'),
  'attention.answer': notImplemented('attention.answer'),
  'attention.watch': notImplemented('attention.watch'),
})
