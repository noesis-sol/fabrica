import { Option, Result, Schema } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import { TlsListening } from './engine'

// The engine status's TLS listener (spec §9.3): its address as `host:port` text, and its certificate's
// SHA-256 fingerprint as Node writes it, 32 bytes in upper-case hex, colon-separated.

const fingerprint = Array.from({ length: 32 }, (_, i) =>
  i.toString(16).toUpperCase().padStart(2, '0'),
).join(':')

const decode = Schema.decodeUnknownResult(TlsListening)
const encode = Schema.encodeSync(TlsListening)

describe('the engine’s TLS listener in its status', () => {
  it('reads an address on every interface and writes it back', () => {
    const listening = Result.getOrThrow(
      decode({ address: ':8443', fingerprint }),
    )
    expect(listening.address).toStrictEqual({ host: Option.none(), port: 8443 })
    expect(encode(listening)).toStrictEqual({ address: ':8443', fingerprint })
  })

  it.each([
    ['in lower case', fingerprint.toLowerCase()],
    ['short of its 32 bytes', fingerprint.slice(3)],
    ['without its colons', fingerprint.replaceAll(':', '')],
  ])('refuses a fingerprint %s', (_kind, given) => {
    expect(
      Result.isFailure(decode({ address: '[::1]:8443', fingerprint: given })),
    ).toBe(true)
  })
})
