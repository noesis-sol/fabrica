import { RunRpcs } from '@fabrica/contracts'

import { notImplemented } from './not-implemented'

// The Runs group's handlers (spec §8.1, §8.3, §13). Not served yet: each answers `NotImplemented` until the
// ticket that builds the group fills this file, with the service layers its handlers need.

/** The Runs group's handlers. */
export const runsHandlers = RunRpcs.toLayer({
  'run.start': notImplemented('run.start'),
  'run.stop': notImplemented('run.stop'),
  'run.drain': notImplemented('run.drain'),
  'run.undrain': notImplemented('run.undrain'),
  'run.status': notImplemented('run.status'),
  'run.preflight': notImplemented('run.preflight'),
  'run.watchView': notImplemented('run.watchView'),
  'run.watchEvents': notImplemented('run.watchEvents'),
})
