import { Effect, Exit, Layer, Result } from 'effect'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from '@effect/vitest'

import {
  type Command,
  CommandOutcome,
  ExitStatus,
  ProcessRunner,
  StartFailure,
} from '../src/process'
import {
  LauncherMissing,
  type ServiceDefinition,
  type ServiceHost,
  carriedEnvironment,
  install,
  launchdPlist,
  serviceFile,
  status,
  systemdUnit,
  uninstall,
} from '../src/service'

// The login service (spec §7.1, §12.1, §19): the launchd agent's plist and the systemd user unit as
// written, and install, uninstall and status against `launchctl`, `systemctl` and `loginctl` stubbed at
// the process boundary: a runner that records each command it is asked to run and answers it as the
// test says, over a home folder of the test's own.

/** A command's answer: its exit code and output, or why it didn't start. */
type Answer =
  | {
      readonly code: number
      readonly stdout?: string
      readonly stderr?: string
    }
  | { readonly fails: StartFailure }

/** The stub's record of what it ran, and how it answers: `answer` gets each command's words. */
interface Stub {
  readonly ran: Array<ReadonlyArray<string>>
  readonly answer: (words: ReadonlyArray<string>) => Answer
}

const words = (command: Command): ReadonlyArray<string> => [
  command.command,
  ...command.args,
]

const stubRunner = (stub: Stub): Layer.Layer<ProcessRunner> =>
  Layer.succeed(
    ProcessRunner,
    ProcessRunner.of({
      run: command =>
        Effect.sync(() => {
          stub.ran.push(words(command))
          const answer = stub.answer(words(command))
          return 'fails' in answer
            ? CommandOutcome.FailedToStart({ reason: answer.fails })
            : CommandOutcome.Exited({
                status: ExitStatus.Code({ code: answer.code }),
                stdout: answer.stdout ?? '',
                stderr: answer.stderr ?? '',
              })
        }),
      start: () => Effect.die('the login service starts no command'),
    }),
  )

const ok: Answer = { code: 0 }

/** A stub answering each command by the first of `answers` its words start with, else exit 0. */
const stubbed = (
  answers: ReadonlyArray<readonly [ReadonlyArray<string>, Answer]> = [],
): Stub => ({
  ran: [],
  answer: line =>
    answers.find(([prefix]) =>
      prefix.every((word, index) => line[index] === word),
    )?.[1] ?? ok,
})

/** A home folder for one test, removed when the test ends, with an executable launcher in it. */
const scratchHome = Effect.acquireRelease(
  Effect.promise(async () => {
    const home = await mkdtemp(join(tmpdir(), 'fabrica-service-'))
    const launcher = join(home, '.local', 'bin', 'fabrica')
    await mkdir(join(home, '.local', 'bin'), { recursive: true })
    await writeFile(launcher, '#!/bin/sh\n')
    await chmod(launcher, 0o755)
    return { home, launcher }
  }),
  ({ home }) =>
    Effect.promise(() => rm(home, { recursive: true, force: true })),
)

const hostOn = (
  platform: NodeJS.Platform,
  home: string,
  environment: ServiceHost['environment'] = {},
): ServiceHost => ({ platform, home, uid: 501, user: 'ada', environment })

const definitionFor = (options: {
  readonly home: string
  readonly launcher: string
}): ServiceDefinition => ({
  launcher: options.launcher,
  home: options.home,
  environment: { PATH: '/usr/bin:/bin' },
  logFile: join(options.home, 'logs', 'service.log'),
})

const read = (file: string) => Effect.promise(() => readFile(file, 'utf8'))

const there = (file: string) =>
  Effect.promise(() =>
    stat(file).then(
      () => true,
      () => false,
    ),
  )

const launchAgent = (home: string) =>
  join(home, 'Library', 'LaunchAgents', 'fabrica.engine.plist')

const userUnit = (home: string) =>
  join(home, '.config', 'systemd', 'user', 'fabrica.service')

describe('the service files', () => {
  const definition: ServiceDefinition = {
    launcher: '/Users/ada/R&D/.local/bin/fabrica',
    home: '/Users/ada/R&D',
    environment: { PATH: '/opt/<tools>/bin:/usr/bin' },
    logFile:
      '/Users/ada/R&D/Library/Application Support/fabrica/logs/service.log',
  }

  it('writes a launchd agent that runs fabrica serve, restarts it only where it fails, and waits on its wind-down', () => {
    expect(launchdPlist(definition)).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>Label</key>',
        '  <string>fabrica.engine</string>',
        '  <key>ProgramArguments</key>',
        '  <array>',
        '    <string>/Users/ada/R&amp;D/.local/bin/fabrica</string>',
        '    <string>serve</string>',
        '  </array>',
        '  <key>WorkingDirectory</key>',
        '  <string>/Users/ada/R&amp;D</string>',
        '  <key>EnvironmentVariables</key>',
        '  <dict>',
        '    <key>FABRICA_SERVICE</key>',
        '    <string>launchd</string>',
        '    <key>PATH</key>',
        '    <string>/opt/&lt;tools&gt;/bin:/usr/bin</string>',
        '  </dict>',
        '  <key>RunAtLoad</key>',
        '  <true/>',
        '  <key>KeepAlive</key>',
        '  <dict>',
        '    <key>SuccessfulExit</key>',
        '    <false/>',
        '  </dict>',
        '  <key>ExitTimeOut</key>',
        '  <integer>120</integer>',
        '  <key>StandardOutPath</key>',
        '  <string>/Users/ada/R&amp;D/Library/Application Support/fabrica/logs/service.log</string>',
        '  <key>StandardErrorPath</key>',
        '  <string>/Users/ada/R&amp;D/Library/Application Support/fabrica/logs/service.log</string>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
    )
  })

  it('writes a systemd user unit with KillMode=mixed, so SIGTERM reaches the engine alone and the cgroup is the backstop', () => {
    expect(
      systemdUnit({
        launcher: '/home/ada/my $tools/100%/"fabrica"',
        home: '/home/ada',
        environment: {
          PATH: '/home/ada/.local/bin:/usr/bin',
          XDG_DATA_HOME: '/data/50%',
        },
        logFile: '/home/ada/.local/share/fabrica/logs/service.log',
      }),
    ).toBe(
      [
        '[Unit]',
        'Description=Fabrica engine',
        '',
        '[Service]',
        'Type=simple',
        'ExecStart="/home/ada/my $$tools/100%%/\\"fabrica\\"" "serve"',
        'WorkingDirectory=%h',
        'Environment="FABRICA_SERVICE=systemd"',
        'Environment="PATH=/home/ada/.local/bin:/usr/bin"',
        'Environment="XDG_DATA_HOME=/data/50%%"',
        'Restart=on-failure',
        'RestartSec=5',
        'KillMode=mixed',
        'TimeoutStopSec=120',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
    )
  })

  it('carries the shell PATH and XDG folders, and nothing else', () => {
    expect(
      carriedEnvironment({
        PATH: '/usr/bin',
        XDG_DATA_HOME: '/data',
        XDG_CONFIG_HOME: '',
        XDG_RUNTIME_DIR: '/run/user/501',
        SSH_AUTH_SOCK: '/tmp/agent',
        HOME: '/home/ada',
      }),
    ).toEqual({ PATH: '/usr/bin', XDG_DATA_HOME: '/data' })
  })

  it('puts the agent in LaunchAgents and the unit under XDG_CONFIG_HOME, and refuses another platform', () => {
    expect(serviceFile(hostOn('darwin', '/Users/ada'))).toEqual(
      Result.succeed({
        manager: 'launchd',
        file: '/Users/ada/Library/LaunchAgents/fabrica.engine.plist',
      }),
    )
    expect(serviceFile(hostOn('linux', '/home/ada'))).toEqual(
      Result.succeed({
        manager: 'systemd',
        file: '/home/ada/.config/systemd/user/fabrica.service',
      }),
    )
    expect(
      serviceFile(hostOn('linux', '/home/ada', { XDG_CONFIG_HOME: '/conf' })),
    ).toEqual(
      Result.succeed({
        manager: 'systemd',
        file: '/conf/systemd/user/fabrica.service',
      }),
    )
    expect(
      Result.isFailure(serviceFile(hostOn('win32', 'C:\\Users\\ada'))),
    ).toBe(true)
  })
})

describe('the launchd agent', () => {
  const notLoaded: Answer = {
    code: 113,
    stderr:
      'Could not find service "fabrica.engine" in domain for user gui: 501',
  }

  it.effect(
    'installs by writing the plist, then enabling and bootstrapping it in the gui domain',
    () =>
      Effect.gen(function* () {
        const { home, launcher } = yield* scratchHome
        const stub = stubbed([[['launchctl', 'print'], notLoaded]])
        const definition = definitionFor({ home, launcher })
        const installed = yield* install({
          host: hostOn('darwin', home),
          definition,
        }).pipe(Effect.provide(stubRunner(stub)))
        expect(installed).toEqual({
          _tag: 'launchd',
          file: launchAgent(home),
          command: [launcher, 'serve'],
        })
        expect(yield* read(launchAgent(home))).toBe(launchdPlist(definition))
        expect(stub.ran).toEqual([
          ['launchctl', 'print', 'gui/501/fabrica.engine'],
          ['launchctl', 'enable', 'gui/501/fabrica.engine'],
          ['launchctl', 'bootstrap', 'gui/501', launchAgent(home)],
        ])
      }),
  )

  it.effect(
    'reinstalling boots the loaded agent out first, so it starts from the new plist',
    () =>
      Effect.gen(function* () {
        const { home, launcher } = yield* scratchHome
        const stub = stubbed()
        yield* install({
          host: hostOn('darwin', home),
          definition: definitionFor({ home, launcher }),
        }).pipe(Effect.provide(stubRunner(stub)))
        expect(stub.ran.map(line => line[1])).toEqual([
          'print',
          'bootout',
          'enable',
          'bootstrap',
        ])
      }),
  )

  it.effect(
    'refuses to install a launcher that is not there, running nothing',
    () =>
      Effect.gen(function* () {
        const { home } = yield* scratchHome
        const stub = stubbed()
        const missing = join(home, 'nowhere', 'fabrica')
        const error = yield* install({
          host: hostOn('darwin', home),
          definition: definitionFor({ home, launcher: missing }),
        }).pipe(Effect.provide(stubRunner(stub)), Effect.flip)
        expect(error).toEqual(new LauncherMissing({ launcher: missing }))
        expect(stub.ran).toEqual([])
        expect(yield* there(launchAgent(home))).toBe(false)
      }),
  )

  it.effect('says what launchctl said where bootstrapping fails', () =>
    Effect.gen(function* () {
      const { home, launcher } = yield* scratchHome
      const stub = stubbed([
        [['launchctl', 'print'], notLoaded],
        [
          ['launchctl', 'bootstrap'],
          { code: 5, stderr: 'Bootstrap failed: 5: Input/output error\n' },
        ],
      ])
      const exit = yield* install({
        host: hostOn('darwin', home),
        definition: definitionFor({ home, launcher }),
      }).pipe(Effect.provide(stubRunner(stub)), Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
        `couldn't load ${launchAgent(home)}: Bootstrap failed: 5: Input/output error`,
      )
    }),
  )

  it.effect('uninstalls by booting the agent out and removing its plist', () =>
    Effect.gen(function* () {
      const { home, launcher } = yield* scratchHome
      const host = hostOn('darwin', home)
      yield* install({
        host,
        definition: definitionFor({ home, launcher }),
      }).pipe(
        Effect.provide(
          stubRunner(stubbed([[['launchctl', 'print'], notLoaded]])),
        ),
      )
      const stub = stubbed()
      expect(
        yield* uninstall(host).pipe(Effect.provide(stubRunner(stub))),
      ).toEqual({ manager: 'launchd', file: launchAgent(home), removed: true })
      expect(stub.ran).toEqual([
        ['launchctl', 'print', 'gui/501/fabrica.engine'],
        ['launchctl', 'bootout', 'gui/501/fabrica.engine'],
      ])
      expect(yield* there(launchAgent(home))).toBe(false)
    }),
  )

  it.effect(
    'uninstalling what is not installed boots nothing out and removes nothing',
    () =>
      Effect.gen(function* () {
        const { home } = yield* scratchHome
        const stub = stubbed([[['launchctl', 'print'], notLoaded]])
        expect(
          yield* uninstall(hostOn('darwin', home)).pipe(
            Effect.provide(stubRunner(stub)),
          ),
        ).toEqual({
          manager: 'launchd',
          file: launchAgent(home),
          removed: false,
        })
        expect(stub.ran).toEqual([
          ['launchctl', 'print', 'gui/501/fabrica.engine'],
        ])
      }),
  )

  it.effect(
    "reports the agent running with launchd's pid, loaded but stopped, or not loaded",
    () =>
      Effect.gen(function* () {
        const { home, launcher } = yield* scratchHome
        const host = hostOn('darwin', home)
        const statusWith = (answer: Answer) =>
          status(host).pipe(
            Effect.provide(
              stubRunner(stubbed([[['launchctl', 'print'], answer]])),
            ),
          )
        expect(yield* statusWith(notLoaded)).toEqual({
          manager: 'launchd',
          file: launchAgent(home),
          installed: false,
          state: { _tag: 'NotLoaded' },
        })
        yield* install({
          host,
          definition: definitionFor({ home, launcher }),
        }).pipe(
          Effect.provide(
            stubRunner(stubbed([[['launchctl', 'print'], notLoaded]])),
          ),
        )
        const running = [
          'gui/501/fabrica.engine = {',
          '\tactive count = 1',
          '\tpath = /Users/ada/Library/LaunchAgents/fabrica.engine.plist',
          '\ttype = LaunchAgent',
          '\tstate = running',
          '',
          '\tprogram = /Users/ada/.local/bin/fabrica',
          '\tpid = 4321',
          '\tlast exit code = (never exited)',
          '}',
        ].join('\n')
        expect(yield* statusWith({ code: 0, stdout: running })).toEqual({
          manager: 'launchd',
          file: launchAgent(home),
          installed: true,
          state: { _tag: 'Running', pid: 4321 },
        })
        const stopped = [
          'gui/501/fabrica.engine = {',
          '\tstate = not running',
          '\tlast exit code = 0',
          '}',
        ].join('\n')
        expect((yield* statusWith({ code: 0, stdout: stopped })).state).toEqual(
          {
            _tag: 'Stopped',
            state: 'not running',
          },
        )
      }),
  )
})

describe('the systemd user unit', () => {
  it.effect(
    'installs by writing the unit, reloading, enabling and starting it, and enabling linger',
    () =>
      Effect.gen(function* () {
        const { home, launcher } = yield* scratchHome
        const stub = stubbed()
        const definition = definitionFor({ home, launcher })
        const installed = yield* install({
          host: hostOn('linux', home),
          definition,
        }).pipe(Effect.provide(stubRunner(stub)))
        expect(installed).toEqual({
          _tag: 'systemd',
          file: userUnit(home),
          command: [launcher, 'serve'],
          linger: { _tag: 'Enabled' },
        })
        expect(yield* read(userUnit(home))).toBe(systemdUnit(definition))
        expect(stub.ran).toEqual([
          ['systemctl', '--user', 'daemon-reload'],
          ['systemctl', '--user', 'enable', 'fabrica.service'],
          ['systemctl', '--user', 'restart', 'fabrica.service'],
          ['loginctl', 'enable-linger'],
        ])
      }),
  )

  it.effect(
    'reports a refused linger with the sudo command that enables it, and still installs',
    () =>
      Effect.gen(function* () {
        const { home, launcher } = yield* scratchHome
        const refused = yield* install({
          host: hostOn('linux', home),
          definition: definitionFor({ home, launcher }),
        }).pipe(
          Effect.provide(
            stubRunner(
              stubbed([
                [
                  ['loginctl'],
                  {
                    code: 1,
                    stderr: 'Could not enable linger: Access denied\n',
                  },
                ],
              ]),
            ),
          ),
        )
        expect(refused).toMatchObject({
          linger: {
            _tag: 'Refused',
            reason: 'Could not enable linger: Access denied',
            remedy: 'sudo loginctl enable-linger ada',
          },
        })
        const absent = yield* install({
          host: hostOn('linux', home),
          definition: definitionFor({ home, launcher }),
        }).pipe(
          Effect.provide(
            stubRunner(
              stubbed([
                [
                  ['loginctl'],
                  {
                    fails: StartFailure.NotOnPath({
                      command: 'loginctl',
                      path: '/usr/bin',
                    }),
                  },
                ],
              ]),
            ),
          ),
        )
        expect(absent).toMatchObject({
          linger: {
            _tag: 'Refused',
            reason: "loginctl isn't on the PATH (/usr/bin)",
            remedy: 'sudo loginctl enable-linger ada',
          },
        })
      }),
  )

  it.effect(
    'says what systemctl said where the user manager is out of reach',
    () =>
      Effect.gen(function* () {
        const { home, launcher } = yield* scratchHome
        const stub = stubbed([
          [
            ['systemctl', '--user', 'daemon-reload'],
            {
              code: 1,
              stderr: 'Failed to connect to bus: No medium found\n',
            },
          ],
        ])
        const exit = yield* install({
          host: hostOn('linux', home),
          definition: definitionFor({ home, launcher }),
        }).pipe(Effect.provide(stubRunner(stub)), Effect.exit)
        expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
          "couldn't reload the user units: Failed to connect to bus: No medium found",
        )
        expect(stub.ran).toEqual([['systemctl', '--user', 'daemon-reload']])
      }),
  )

  it.effect(
    'uninstalls by disabling and stopping the unit, removing it and reloading',
    () =>
      Effect.gen(function* () {
        const { home, launcher } = yield* scratchHome
        const host = hostOn('linux', home)
        yield* install({
          host,
          definition: definitionFor({ home, launcher }),
        }).pipe(Effect.provide(stubRunner(stubbed())))
        const stub = stubbed()
        expect(
          yield* uninstall(host).pipe(Effect.provide(stubRunner(stub))),
        ).toEqual({ manager: 'systemd', file: userUnit(home), removed: true })
        expect(stub.ran).toEqual([
          ['systemctl', '--user', 'disable', '--now', 'fabrica.service'],
          ['systemctl', '--user', 'daemon-reload'],
        ])
        expect(yield* there(userUnit(home))).toBe(false)
        const again = stubbed()
        expect(
          yield* uninstall(host).pipe(Effect.provide(stubRunner(again))),
        ).toEqual({ manager: 'systemd', file: userUnit(home), removed: false })
        expect(again.ran).toEqual([])
      }),
  )

  it.effect(
    "reports the unit running with its main pid, stopped in the manager's words, or not loaded",
    () =>
      Effect.gen(function* () {
        const { home } = yield* scratchHome
        const host = hostOn('linux', home)
        const show = (stdout: string) =>
          status(host).pipe(
            Effect.provide(
              stubRunner(
                stubbed([
                  [['systemctl', '--user', 'show'], { code: 0, stdout }],
                ]),
              ),
            ),
          )
        const running = yield* show(
          'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=777\n',
        )
        expect(running).toEqual({
          manager: 'systemd',
          file: userUnit(home),
          installed: false,
          state: { _tag: 'Running', pid: 777 },
        })
        expect(
          (yield* show(
            'LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\n',
          )).state,
        ).toEqual({ _tag: 'Stopped', state: 'failed (failed)' })
        expect(
          (yield* show(
            'LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n',
          )).state,
        ).toEqual({ _tag: 'NotLoaded' })
      }),
  )
})
