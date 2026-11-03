import { Effect, Option } from 'effect'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'

import { relaunch, serveArguments } from '../src/update'
import { stubLauncher } from './fixture-launcher'
import { tempFolder } from './fixture-releases'

// The restart into an update outside the login service (spec §9.2, §9.3, §20.2): the new engine is
// started with the old one's `serve` flags, so a TLS listener comes back with it, and with the old
// engine's own environment, since it is the daemon rather than a command, so its git's network
// commands keep the host's ssh-agent, ssh command, proxies and CA certificates.

const noFlags = {
  listen: Option.none(),
  listen_certificate: Option.none(),
  listen_key: Option.none(),
  passphrase_file: Option.none(),
}

describe('the relaunched engine’s serve flags', () => {
  it('are none where the engine was given none', () => {
    expect(serveArguments(noFlags)).toStrictEqual(['serve'])
  })

  it('give the listener’s address and its certificate’s files again, their paths absolute', () => {
    const given = serveArguments({
      listen: Option.some({ host: Option.some('::1'), port: 8443 }),
      listen_certificate: Option.some('/etc/fabrica/cert.pem'),
      listen_key: Option.some('certs/key.pem'),
      passphrase_file: Option.none(),
    })
    expect(given.slice(0, 6)).toStrictEqual([
      'serve',
      '--listen',
      '[::1]:8443',
      '--listen-certificate',
      '/etc/fabrica/cert.pem',
      '--listen-key',
    ])
    expect(given).toHaveLength(7)
    const key = given[6] ?? ''
    expect(NodePath.isAbsolute(key)).toBe(true)
    expect(key.endsWith(`${NodePath.sep}certs${NodePath.sep}key.pem`)).toBe(
      true,
    )
    expect(
      serveArguments({
        ...noFlags,
        listen: Option.some({ host: Option.none(), port: 0 }),
      }),
    ).toStrictEqual(['serve', '--listen', ':0'])
  })
})

describe('the relaunched engine', () => {
  it.live(
    'starts with the old engine’s flags and its whole environment, the host’s transport in it',
    () =>
      Effect.gen(function* () {
        const root = yield* tempFolder('relaunch-serve')
        const launcher = yield* stubLauncher({
          folder: root,
          says: `'%s|%s|%s|%s\\n' "$*" "\${SSH_AUTH_SOCK-unset}" "\${GIT_SSH_COMMAND-unset}" "\${https_proxy-unset}"`,
        })
        yield* relaunch({
          launcher: launcher.path,
          cwd: root,
          hostEnvironment: {
            PATH: '/usr/bin:/bin',
            HOME: root,
            SSH_AUTH_SOCK: '/tmp/agent.sock',
            GIT_SSH_COMMAND: 'ssh -i key',
            https_proxy: 'http://proxy:3128',
          },
          flags: {
            listen: Option.some({ host: Option.some('0.0.0.0'), port: 8443 }),
            listen_certificate: Option.some('/certs/cert.pem'),
            listen_key: Option.some('/certs/key.pem'),
            passphrase_file: Option.some('/home/ada/.fabrica-passphrase'),
          },
        })
        expect(yield* launcher.said).toBe(
          'serve --listen 0.0.0.0:8443 --listen-certificate /certs/cert.pem --listen-key /certs/key.pem --passphrase-file /home/ada/.fabrica-passphrase|/tmp/agent.sock|ssh -i key|http://proxy:3128\n',
        )
      }).pipe(Effect.scoped),
  )
})
