import { Effect, Option, Runtime } from 'effect'
import { existsSync, watch } from 'node:fs'
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'

import {
  RESTART_EXIT_CODE,
  SERVICE_VARIABLE,
  launchdPlist,
  runningService,
  systemdUnit,
} from '../src/service'
import { restart } from '../src/update'

// The restart into an update under the login service (spec §7.1, §9.2): the service names its manager
// in the engine's environment, and the engine, restarted, exits with the code the manager restarts it
// on rather than starting the new launcher itself; outside the service it starts the launcher as before.

/** A new temporary folder, removed with the scope. */
const tempFolder = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(async () =>
      realpath(await mkdtemp(NodePath.join(tmpdir(), `fab-${prefix}-`))),
    ),
    folder =>
      Effect.promise(() => rm(folder, { recursive: true, force: true })),
  )

/** Completes once `file` exists, on its folder's change events. */
const appears = (file: string): Effect.Effect<void> =>
  Effect.callback<void>(resume => {
    const watcher = watch(NodePath.dirname(file), () => {
      if (existsSync(file)) resume(Effect.void)
    })
    if (existsSync(file)) resume(Effect.void)
    return Effect.sync(() => watcher.close())
  })

describe('the restart into an update under the login service', () => {
  const definition = {
    launcher: '/home/ada/.local/bin/fabrica',
    home: '/home/ada',
    environment: { PATH: '/usr/bin' },
    logFile: '/home/ada/service.log',
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
      const fabrica = NodePath.join(root, 'fabrica')
      const said = NodePath.join(root, 'said')
      yield* Effect.promise(async () => {
        await writeFile(
          fabrica,
          `#!/bin/sh\nprintf '%s\\n' "$*" > '${said}.tmp'\nmv '${said}.tmp' '${said}'\n`,
        )
        await chmod(fabrica, 0o755)
      })
      yield* restart({
        launcher: fabrica,
        cwd: root,
        hostEnvironment: { PATH: '/usr/bin:/bin', HOME: root },
        service: Option.none(),
      })
      yield* appears(said)
      expect(yield* Effect.promise(() => readFile(said, 'utf8'))).toBe(
        'serve\n',
      )
    }).pipe(Effect.scoped),
  )
})
