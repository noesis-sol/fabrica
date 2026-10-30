import { Duration, Effect, Schema } from 'effect'

import {
  FingerprintAnswer,
  TlsEndpoint,
  tlsEndpointText,
} from '@fabrica/client'
import { presentedFingerprint } from '@fabrica/client/node'
import { CertificateFingerprint } from '@fabrica/contracts'

// The first pairing's read of an engine's certificate (spec §9.3), which the connection process makes
// as it makes every connection to an engine: main asks it, numbered, for the fingerprint of the
// certificate the engine at an endpoint presents, and it answers with the fingerprint, or why it
// couldn't read one. An engine that doesn't answer in time is said so, rather than waited on for as
// long as the system's TCP connect waits.

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

/** How long the read waits for the engine's TLS handshake. */
export const fingerprintTimeout = Duration.seconds(15)

const decodeFingerprint = Schema.decodeUnknownEffect(CertificateFingerprint)

const failed = (reason: string): FingerprintAnswer =>
  FingerprintAnswer.cases.Failed.make({ reason })

/** The fingerprint the engine at `endpoint` presents, or why it couldn't be read, in words. */
export const readFingerprint = Effect.fn('ConnectionFingerprint.read')(
  function* (
    endpoint: TlsEndpoint,
    timeout: Duration.Duration = fingerprintTimeout,
  ) {
    const at = tlsEndpointText(endpoint)
    return yield* presentedFingerprint(endpoint).pipe(
      Effect.flatMap(decodeFingerprint),
      Effect.map(fingerprint =>
        FingerprintAnswer.cases.Presented.make({ fingerprint }),
      ),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.succeed(
            failed(
              `no engine answered at ${at} within ${Duration.format(timeout)}`,
            ),
          ),
      }),
      Effect.catchTags({
        SocketError: error =>
          Effect.succeed(
            failed(
              `couldn't reach an engine over TLS at ${at}: ${causeWords(error)}`,
            ),
          ),
        SchemaError: () =>
          Effect.succeed(
            failed(`the engine at ${at} presented no SHA-256 fingerprint`),
          ),
      }),
    )
  },
)

/** What a socket's failure says: its cause's message where it has one. */
const causeWords = (error: { readonly reason: unknown }): string => {
  const { reason } = error
  const cause: unknown =
    typeof reason === 'object' && reason !== null
      ? Reflect.get(reason, 'cause')
      : undefined
  return cause instanceof Error && cause.message !== ''
    ? cause.message
    : String(reason)
}
