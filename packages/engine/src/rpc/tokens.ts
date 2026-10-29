import { TokenRpcs } from '@fabrica/contracts'

import { notImplemented } from './not-implemented'

// The Hosts and tokens group's handlers (spec §8.1, §9.3). Not served yet: each answers `NotImplemented` until the
// ticket that builds the group fills this file, with the service layers its handlers need.

/** The Hosts and tokens group's handlers. */
export const tokensHandlers = TokenRpcs.toLayer({
  'tokens.create': notImplemented('tokens.create'),
  'tokens.list': notImplemented('tokens.list'),
  'tokens.revoke': notImplemented('tokens.revoke'),
})
