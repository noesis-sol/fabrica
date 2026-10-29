import { SecretRpcs } from '@fabrica/contracts'

import { notImplemented } from './not-implemented'

// The Secrets group's handlers (spec §8.1, §20.3). Not served yet: each answers `NotImplemented` until the
// ticket that builds the group fills this file, with the service layers its handlers need.

/** The Secrets group's handlers. */
export const secretsHandlers = SecretRpcs.toLayer({
  'credentials.set': notImplemented('credentials.set'),
  'credentials.list': notImplemented('credentials.list'),
  'credentials.remove': notImplemented('credentials.remove'),
  'credentials.login': notImplemented('credentials.login'),
})
