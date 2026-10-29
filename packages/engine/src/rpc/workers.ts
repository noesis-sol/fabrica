import { WorkerRpcs } from '@fabrica/contracts'

import { notImplemented } from './not-implemented'

// The Workers group's handlers (spec §8.1, §12). Not served yet: each answers `NotImplemented` until the
// ticket that builds the group fills this file, with the service layers its handlers need.

/** The Workers group's handlers. */
export const workersHandlers = WorkerRpcs.toLayer({
  'worker.message': notImplemented('worker.message'),
  'worker.interrupt': notImplemented('worker.interrupt'),
  'worker.release': notImplemented('worker.release'),
  'worker.watchTranscript': notImplemented('worker.watchTranscript'),
})
