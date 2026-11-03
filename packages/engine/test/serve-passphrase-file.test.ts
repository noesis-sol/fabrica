import { Option } from 'effect'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'

import {
  type ServiceDefinition,
  launchdPlist,
  serviceCommand,
  systemdUnit,
} from '../src/service'
import { serveArguments } from '../src/update'

// The secret store's passphrase file given to `fabrica serve` (spec §20.3, §7.1, §9.2): the login
// service runs `serve` with it, where it was installed with one, and an engine restarting into an
// update gives it again to the new engine, its path absolute.

describe('the passphrase file', () => {
  const definition: ServiceDefinition = {
    launcher: '/home/ada/.local/bin/fabrica',
    home: '/home/ada',
    environment: { PATH: '/usr/bin' },
    logFile: '/home/ada/service.log',
    passphraseFile: Option.some('/home/ada/.config/fabrica/passphrase'),
  }

  it('is given to the serve the login service runs, where one was installed', () => {
    expect(serviceCommand(definition)).toStrictEqual([
      '/home/ada/.local/bin/fabrica',
      'serve',
      '--passphrase-file',
      '/home/ada/.config/fabrica/passphrase',
    ])
    expect(systemdUnit(definition)).toContain(
      'ExecStart="/home/ada/.local/bin/fabrica" "serve" "--passphrase-file" "/home/ada/.config/fabrica/passphrase"\n',
    )
    expect(launchdPlist(definition)).toContain(
      [
        '    <string>serve</string>',
        '    <string>--passphrase-file</string>',
        '    <string>/home/ada/.config/fabrica/passphrase</string>',
        '  </array>',
      ].join('\n'),
    )
    expect(
      serviceCommand({ ...definition, passphraseFile: Option.none() }),
    ).toStrictEqual(['/home/ada/.local/bin/fabrica', 'serve'])
  })

  it('is given again to the engine an update restarts as, its path absolute', () => {
    const given = serveArguments({
      listen: Option.none(),
      listen_certificate: Option.none(),
      listen_key: Option.none(),
      passphrase_file: Option.some('secrets/passphrase'),
    })
    expect(given.slice(0, 2)).toStrictEqual(['serve', '--passphrase-file'])
    expect(given).toHaveLength(3)
    expect(given[2]).toBe(NodePath.resolve('secrets/passphrase'))
  })
})
