import { Schema } from 'effect'

import { FingerprintAnswer, TlsEndpoint } from '@fabrica/client'

export { fingerprintTimeout, readFingerprint } from '@fabrica/client/node'

// The first pairing's read of an engine's certificate (spec §9.3), which the connection process makes
// as it makes every connection to an engine: main asks it, numbered, for the fingerprint of the
// certificate the engine at an endpoint presents, and it answers with the fingerprint, or why it
// couldn't read one (`readFingerprint`, the client's).

/** Main's request, a message without a port: the fingerprint the engine at `endpoint` presents. */
export const FingerprintRequest = Schema.TaggedStruct('FingerprintRequest', {
  id: Schema.Int,
  endpoint: TlsEndpoint,
})
export type FingerprintRequest = typeof FingerprintRequest.Type

/** The connection process's answer to the request numbered `id`. */
export const FingerprintRead = Schema.TaggedStruct('FingerprintRead', {
  id: Schema.Int,
  answer: FingerprintAnswer,
})
export type FingerprintRead = typeof FingerprintRead.Type
