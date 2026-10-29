import { Option, Schema } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import {
  EngineSettings,
  ProjectSettings,
  bearerToken,
  formatListenAddress,
  parseListenAddress,
} from './index'

// The TLS listener's address and its bearer token (spec §9.3): `listen` written `host:port`,
// `[v6]:port` or `:port`, as the engine's setting and `fabrica serve --listen` take it.

describe('the listen address', () => {
  const read: ReadonlyArray<
    readonly [text: string, host: Option.Option<string>, port: number]
  > = [
    ['0.0.0.0:8443', Option.some('0.0.0.0'), 8443],
    ['127.0.0.1:0', Option.some('127.0.0.1'), 0],
    ['engine.lan:443', Option.some('engine.lan'), 443],
    ['[::1]:8443', Option.some('::1'), 8443],
    [':8443', Option.none(), 8443],
  ]

  it.each(read)('reads %s', (text, host, port) => {
    const address = parseListenAddress(text)
    expect(address).toStrictEqual(Option.some({ host, port }))
    expect(Option.map(address, formatListenAddress)).toStrictEqual(
      Option.some(text),
    )
  })

  it.each(['8443', 'host', 'host:', 'host:70000', '::1:8443', 'a b:1', ''])(
    'refuses %j',
    text => {
      expect(parseListenAddress(text)).toStrictEqual(Option.none())
    },
  )

  it('is the engine’s setting, with its certificate, never the project’s', () => {
    const settings = Schema.decodeUnknownSync(EngineSettings)({
      listen: ':8443',
      listen_certificate: '/etc/fabrica/cert.pem',
      listen_key: '/etc/fabrica/key.pem',
    })
    expect(settings.listen).toStrictEqual(
      Option.some({ host: Option.none(), port: 8443 }),
    )
    expect(settings.listen_certificate).toStrictEqual(
      Option.some('/etc/fabrica/cert.pem'),
    )
    expect(
      Option.isNone(Schema.decodeUnknownSync(EngineSettings)({}).listen),
    ).toBe(true)
    expect(() =>
      Schema.decodeUnknownSync(EngineSettings)({ listen: '8443' }),
    ).toThrow(/an address such as/u)
    expect(() =>
      Schema.decodeUnknownSync(ProjectSettings)({ listen: ':8443' }),
    ).toThrow(/a person's or a machine's choice/u)
  })
})

describe('the bearer token', () => {
  it('is read from an Authorization header, and only from a bearer one', () => {
    expect(bearerToken('Bearer fabrica_ab12')).toStrictEqual(
      Option.some('fabrica_ab12'),
    )
    expect(bearerToken(undefined)).toStrictEqual(Option.none())
    expect(bearerToken('Basic dXNlcg==')).toStrictEqual(Option.none())
    expect(bearerToken('Bearer ')).toStrictEqual(Option.none())
    expect(bearerToken('Bearer a b')).toStrictEqual(Option.none())
  })
})
