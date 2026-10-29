import { Console, Effect, Exit, Layer } from 'effect'

import { NodeServices } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { LoginService } from '@fabrica/engine'
import { layerHost } from '@fabrica/testkit'

import { LocalEngine } from '../src/cli/connect'
import { runCli } from '../src/cli/main'
import { installedText, statusText, uninstalledText } from '../src/cli/service'

// `fabrica service install|uninstall|status` (spec §19, §7.1): its commands in the help, and its answers
// as text, a refused linger with the command that enables it. What the commands do against launchctl and
// systemctl is the engine's service test's (packages/engine/test/service.test.ts).

describe('fabrica service', () => {
  it.effect('lists install, uninstall and status in its help', () =>
    Effect.gen(function* () {
      const out: Array<string> = []
      const console: Console.Console = Object.assign(
        Object.create(globalThis.console),
        { log: (...args: ReadonlyArray<unknown>) => out.push(args.join(' ')) },
      )
      const exit = yield* runCli(['service', '--help']).pipe(
        Effect.provideService(Console.Console, console),
        Effect.provide([
          NodeServices.layer,
          Layer.succeed(LocalEngine)({ socket: Effect.succeed('/nowhere') }),
          layerHost(),
        ]),
        Effect.exit,
      )
      expect(exit).toStrictEqual(Exit.void)
      const help = out.join('\n')
      for (const command of ['install', 'uninstall', 'status']) {
        expect(help).toMatch(new RegExp(`^  ${command} `, 'mu'))
      }
    }),
  )

  it('says what install did, and how to enable a refused linger', () => {
    expect(
      installedText(
        LoginService.ServiceInstalled.cases.launchd.make({
          file: '/Users/ada/Library/LaunchAgents/fabrica.engine.plist',
          command: ['/Users/ada/.local/bin/fabrica', 'serve'],
        }),
      ),
    ).toBe(
      [
        'installed the launchd agent fabrica.engine: /Users/ada/Library/LaunchAgents/fabrica.engine.plist',
        'it runs /Users/ada/.local/bin/fabrica serve now and at every login',
      ].join('\n'),
    )
    const unit = {
      file: '/home/ada/.config/systemd/user/fabrica.service',
      command: ['/home/ada/.local/bin/fabrica', 'serve'],
    }
    expect(
      installedText(
        LoginService.ServiceInstalled.cases.systemd.make({
          ...unit,
          linger: LoginService.Linger.cases.Enabled.make({}),
        }),
      ),
    ).toBe(
      [
        'installed the systemd user unit fabrica.service: /home/ada/.config/systemd/user/fabrica.service',
        'it runs /home/ada/.local/bin/fabrica serve now and whenever the user manager starts',
        'linger is enabled: the engine starts at boot and runs without a login session',
      ].join('\n'),
    )
    expect(
      installedText(
        LoginService.ServiceInstalled.cases.systemd.make({
          ...unit,
          linger: LoginService.Linger.cases.Refused.make({
            reason: 'Access denied',
            remedy: 'sudo loginctl enable-linger ada',
          }),
        }),
      ).split('\n')[2],
    ).toBe(
      "linger isn't enabled (Access denied): the engine runs only while you are logged in; enable it with: sudo loginctl enable-linger ada",
    )
  })

  it('says what uninstall removed, or that nothing was installed', () => {
    const file = '/home/ada/.config/systemd/user/fabrica.service'
    expect(uninstalledText({ manager: 'systemd', file, removed: true })).toBe(
      `stopped and removed the systemd user unit fabrica.service: ${file}`,
    )
    expect(uninstalledText({ manager: 'systemd', file, removed: false })).toBe(
      `no login service was installed: ${file} isn't there`,
    )
  })

  it('says whether the service is installed and whether its engine runs', () => {
    const file = '/Users/ada/Library/LaunchAgents/fabrica.engine.plist'
    expect(
      statusText({
        manager: 'launchd',
        file,
        installed: true,
        state: LoginService.ServiceState.cases.Running.make({ pid: 4321 }),
      }),
    ).toBe(
      [
        'service    the launchd agent fabrica.engine',
        `file       ${file}`,
        'installed  yes',
        'engine     running (pid 4321)',
      ].join('\n'),
    )
    expect(
      statusText({
        manager: 'systemd',
        file,
        installed: true,
        state: LoginService.ServiceState.cases.Stopped.make({
          state: 'failed (failed)',
        }),
      }).split('\n')[3],
    ).toBe('engine     not running (failed (failed))')
    expect(
      statusText({
        manager: 'systemd',
        file,
        installed: false,
        state: LoginService.ServiceState.cases.NotLoaded.make({}),
      }).split('\n')[3],
    ).toBe('engine     not loaded by systemd')
  })
})
