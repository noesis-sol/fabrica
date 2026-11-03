import { Effect, Option, Runtime } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import {
  RESTART_EXIT_CODE,
  SERVICE_VARIABLE,
  launchdPlist,
  runningService,
  systemdUnit,
} from '../src/service'
import { restart } from '../src/update'
import { stubLauncher } from './fixture-launcher'
import { tempFolder } from './fixture-releases'

// The restart into an update under the login service (spec §7.1, §9.2): the service names its manager
// in the engine's environment, and the engine, restarted, exits with the code the manager restarts it
// on rather than starting the new launcher itself; outside the service it starts the launcher as before.

describe('the restart into an update under the login service', () => {
  const definition = {
    launcher: '/home/ada/.local/bin/fabrica',
    home: '/home/ada',
    environment: { PATH: '/usr/bin' },
    logFile: '/home/ada/service.log',
    passphraseFile: Option.none(),
  }

  it('names the manager in the service’s environment, read back as the engine’s', () => {
    expect(launchdPlist(definition)).toContain(
      [
        `    <key>${SERVICE_VARIABLE}</key>`,
        '    <string>launchd</string>',
      ].join('\n'),
    )
    expect(systemdUnit(definition)).toContain(
      `Environment="${SERVICE_VARIABLE}=systemd"`,
    )
    expect(runningService({ [SERVICE_VARIABLE]: 'launchd' })).toEqual(
      Option.some('launchd'),
    )
    expect(runningService({ [SERVICE_VARIABLE]: 'systemd' })).toEqual(
      Option.some('systemd'),
    )
    expect(runningService({})).toEqual(Option.none())
    expect(runningService({ [SERVICE_VARIABLE]: 'cron' })).toEqual(
      Option.none(),
    )
  })

  it.effect(
    'exits for the manager to restart it, with the code it restarts on, starting nothing',
    () =>
      Effect.gen(function* () {
        // A launcher that can't start: a relaunch would fail with RelaunchFailed.
        const exited = yield* Effect.flip(
          restart({
            launcher: '/nonexistent/fabrica',
            cwd: '/',
            hostEnvironment: { PATH: '/usr/bin:/bin' },
            flags: {
              listen: Option.none(),
              listen_certificate: Option.none(),
              listen_key: Option.none(),
              passphrase_file: Option.none(),
            },
            service: Option.some('systemd'),
          }),
        )
        expect(exited._tag).toBe('RestartByService')
        expect(exited.message).toBe(
          'the engine exits for systemd to start the updated engine',
        )
        expect(Runtime.getErrorExitCode(exited)).toBe(RESTART_EXIT_CODE)
        expect(RESTART_EXIT_CODE).not.toBe(0)
      }),
  )

  it.live('starts the new launcher’s serve outside the service', () =>
    Effect.gen(function* () {
      const root = yield* tempFolder('restart')
      const launcher = yield* stubLauncher({
        folder: root,
        says: `'%s\\n' "$*"`,
      })
      yield* restart({
        launcher: launcher.path,
        cwd: root,
        hostEnvironment: { PATH: '/usr/bin:/bin', HOME: root },
        flags: {
          listen: Option.none(),
          listen_certificate: Option.none(),
          listen_key: Option.none(),
          passphrase_file: Option.none(),
        },
        service: Option.none(),
      })
      expect(yield* launcher.said).toBe('serve\n')
    }).pipe(Effect.scoped),
  )
})
