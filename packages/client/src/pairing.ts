import { Schema } from 'effect'

import { CertificateFingerprint } from '@fabrica/contracts'

import { EngineName, TlsEndpoint } from './known-engine'

// Pairing with an engine over TLS (spec §9.1, §9.3): Add engine takes the engine's TLS address and a
// pairing token, and the app reads the fingerprint of the certificate the engine presents there, which
// the user compares with the one `fabrica engine status` prints and accepts; the app then keeps the
// address and that fingerprint among its known engines, and the token in its secret storage. Each
// crosses from the page to main, and from main to the connection process, and is decoded there, so
// this module has no Node in it; the token stays redacted wherever it is held.

/** The fingerprint of the certificate the engine at an endpoint presents, or why it couldn't be read. */
export const FingerprintAnswer = Schema.TaggedUnion({
  Presented: { fingerprint: CertificateFingerprint },
  Failed: { reason: Schema.String },
})
export type FingerprintAnswer = typeof FingerprintAnswer.Type

/** A pairing the user agreed to: the engine's name, where it is, the fingerprint they accepted, the token. */
export const PairRequest = Schema.Struct({
  name: EngineName,
  endpoint: TlsEndpoint,
  fingerprint: CertificateFingerprint,
  token: Schema.RedactedFromValue(Schema.NonEmptyString),
})
export type PairRequest = typeof PairRequest.Type

/** Whether the app took a pairing, to be kept once the engine's first hello comes, or why it didn't. */
export const PairAnswer = Schema.TaggedUnion({
  Paired: {},
  Failed: { reason: Schema.String },
})
export type PairAnswer = typeof PairAnswer.Type
