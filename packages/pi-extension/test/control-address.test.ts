import { Option } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import { ControlEndpoint, readEnvironment } from '../src/environment'

// Where the extension finds its control channel (spec §12.7, fab-mgi.61): the mounted socket, or the
// TCP address the engine gives where its container can't connect one.

describe('the control channel a container is given', () => {
  it('is the address, where the engine gives one', () => {
    expect(
      readEnvironment(
        {
          FABRICA_CONTROL_ADDRESS: '192.168.127.254:40123',
          FABRICA_CONTROL_TOKEN: 'secret',
        },
        '/w',
      ).control,
    ).toEqual(
      Option.some({
        endpoint: ControlEndpoint.Tcp({
          host: '192.168.127.254',
          port: 40123,
        }),
        token: 'secret',
      }),
    )
  })

  it('is the socket otherwise', () => {
    expect(
      readEnvironment(
        { FABRICA_CONTROL_SOCKET: '/s.sock', FABRICA_CONTROL_TOKEN: 'secret' },
        '/w',
      ).control,
    ).toEqual(
      Option.some({
        endpoint: ControlEndpoint.Unix({ socket: '/s.sock' }),
        token: 'secret',
      }),
    )
  })

  it('is none without a token, or with an address that is not one', () => {
    expect(
      readEnvironment({ FABRICA_CONTROL_ADDRESS: 'h:1' }, '/w').control,
    ).toEqual(Option.none())
    expect(
      readEnvironment(
        { FABRICA_CONTROL_ADDRESS: 'no-port', FABRICA_CONTROL_TOKEN: 't' },
        '/w',
      ).control,
    ).toEqual(Option.none())
  })
})
