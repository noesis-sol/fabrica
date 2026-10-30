import { Option, Redacted, Schema } from 'effect'
import { Socket } from 'effect/socket'

import { describe, expect, it } from '@effect/vitest'

import {
  EngineAddress,
  KnownEngine,
  PairRequest,
  parseTlsEndpoint,
  tlsEndpointText,
} from '../src'
import { CertificateChanged, TokenRefused, tlsRefused } from '../src/node'

// Pairing with an engine over TLS (spec §9.1, §9.3): the address Add engine takes, the known engine's
// TLS address with its pinned fingerprint, the pairing as it crosses from the page with its token, and
// the engine's refusals a connection's error carries.

const fingerprint = Array.from({ length: 32 }, () => 'C3').join(':')

describe('a TLS endpoint', () => {
  it('is read from host:port or [v6]:port, and written back the same', () => {
    expect(parseTlsEndpoint(' build-box:8443 ')).toEqual(
      Option.some({ host: 'build-box', port: 8443 }),
    )
    expect(parseTlsEndpoint('[::1]:8443')).toEqual(
      Option.some({ host: '::1', port: 8443 }),
    )
    expect(tlsEndpointText({ host: '::1', port: 8443 })).toBe('[::1]:8443')
    expect(tlsEndpointText({ host: '192.0.2.7', port: 7443 })).toBe(
      '192.0.2.7:7443',
    )
  })

  it('needs a host and a port the engine can listen on', () => {
    expect(parseTlsEndpoint(':8443')).toEqual(Option.none())
    expect(parseTlsEndpoint('build-box')).toEqual(Option.none())
    expect(parseTlsEndpoint('build-box:0')).toEqual(Option.none())
    expect(parseTlsEndpoint('build-box:70000')).toEqual(Option.none())
    expect(parseTlsEndpoint('https://build-box:8443')).toEqual(Option.none())
  })
})

describe('a known engine over TLS', () => {
  const decode = Schema.decodeUnknownOption(KnownEngine)
  const encoded = {
    name: 'build-box',
    address: { _tag: 'Tls', host: 'build-box', port: 8443, fingerprint },
    engine: 'e-build-box',
    protocol: 1,
  }

  it('keeps its endpoint and the fingerprint pinned at pairing', () => {
    expect(Option.map(decode(encoded), ({ address }) => address)).toEqual(
      Option.some(
        EngineAddress.cases.Tls.make({
          host: 'build-box',
          port: 8443,
          fingerprint,
        }),
      ),
    )
  })

  it('takes only a SHA-256 fingerprint as Node writes it', () => {
    expect(
      decode({
        ...encoded,
        address: { ...encoded.address, fingerprint: fingerprint.toLowerCase() },
      }),
    ).toEqual(Option.none())
    expect(
      decode({
        ...encoded,
        address: { ...encoded.address, fingerprint: 'C3:C3' },
      }),
    ).toEqual(Option.none())
  })
})

describe('a pairing', () => {
  it('crosses with its token as text, and holds it redacted', () => {
    const request: PairRequest = {
      name: 'build-box',
      endpoint: { host: 'build-box', port: 8443 },
      fingerprint,
      token: Redacted.make('fab_secret'),
    }
    const encoded = Schema.encodeSync(PairRequest)(request)
    expect(encoded.token).toBe('fab_secret')
    const decoded = Schema.decodeUnknownSync(PairRequest)(encoded)
    expect(Redacted.value(decoded.token)).toBe('fab_secret')
    expect(String(decoded.token)).not.toContain('fab_secret')
    expect(
      Schema.decodeUnknownOption(PairRequest)({ ...encoded, token: '' }),
    ).toEqual(Option.none())
  })
})

describe('an engine’s refusal over TLS', () => {
  const failed = (cause: unknown) =>
    new Socket.SocketError({
      reason: new Socket.SocketOpenError({ kind: 'Unknown', cause }),
    })

  it('is found in a connection’s error: a changed certificate, or a refused token', () => {
    const changed = new CertificateChanged({
      pinned: fingerprint,
      presented: 'AA',
    })
    const refused = new TokenRefused({ status: 401 })
    expect(tlsRefused(failed(changed))).toEqual(Option.some(changed))
    expect(tlsRefused(failed(refused))).toEqual(Option.some(refused))
    expect(tlsRefused(failed(new Error('ECONNREFUSED')))).toEqual(Option.none())
    expect(refused.message).toBe(
      'the engine refused the pairing token (HTTP 401): it is wrong, or was revoked; pair the engine again with a new token',
    )
  })
})
