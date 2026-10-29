import { TalkRpcs } from '@fabrica/contracts'

import { notImplemented } from './not-implemented'

// The Talks group's handlers (spec §8.1, §15.4). Not served yet: each answers `NotImplemented` until the
// ticket that builds the group fills this file, with the service layers its handlers need.

/** The Talks group's handlers. */
export const talksHandlers = TalkRpcs.toLayer({
  'talk.open': notImplemented('talk.open'),
  'talk.send': notImplemented('talk.send'),
  'talk.close': notImplemented('talk.close'),
  'talk.watchTranscript': notImplemented('talk.watchTranscript'),
})
