import { Duration, Effect, Layer, Option, Redacted } from 'effect'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'

import {
  type RunnerConfig,
  commandEnvironment,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import {
  KeyringCli,
  KeyringOutcome,
  SecretName,
  layerKeyringCli,
  runKeyCommand,
} from '../src/secrets'

// The commands reaching the host's secret stores get its desktop session and password managers'
// sessions (spec §20.2, §20.3): a keyring CLI reaches the Secret Service over the session's D-Bus
// and prompts on its display, and a key's command signs in to its password manager with the
// session its user started. No other command gets them.

/** The host's desktop session and password managers' sessions. */
const sessions = {
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  DISPLAY: ':0',
  WAYLAND_DISPLAY: 'wayland-0',
  OP_SERVICE_ACCOUNT_TOKEN: 'ops_token',
  OP_CONNECT_HOST: 'https://connect.invalid',
  OP_CONNECT_TOKEN: 'connect-token',
  OP_ACCOUNT: 'my.1password.com',
  OP_SESSION_my: 'op-session',
  BW_SESSION: 'bw-session',
  PASSWORD_STORE_DIR: '/home/a/.password-store',
  GNUPGHOME: '/home/a/.gnupg',
}

/** What a secret store's command never needs: never passed. */
const others = {
  ANTHROPIC_API_KEY: 'secret',
  CLAUDECODE: '1',
  OP_SESSION_: 'no account',
  SSH_AUTH_SOCK: '/agent/ssh.sock',
}

describe('commandEnvironment', () => {
  const host = { PATH: '/usr/bin', ...sessions, ...others }

  it('gives the host’s sessions to a secret store’s command alone', () => {
    expect(commandEnvironment({ host, extra: {} })).toEqual({
      PATH: '/usr/bin',
    })
    expect(commandEnvironment({ host, extra: {}, network: true })).toEqual({
      PATH: '/usr/bin',
      SSH_AUTH_SOCK: '/agent/ssh.sock',
    })
    expect(commandEnvironment({ host, extra: {}, secrets: true })).toEqual({
      PATH: '/usr/bin',
      ...sessions,
    })
  })
})

let root = ''

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-secret-stores-')))
})

/** The runner's host facts: the system's tools, and the host's sessions. */
const runnerConfig = (): RunnerConfig => ({
  hostEnvironment: { PATH: '/usr/bin:/bin', ...sessions, ...others },
  enginePriority: 0,
  priority: hostPriority,
  listProcesses,
  pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
  self: process.pid,
  killGrace: Duration.seconds(2),
  outputGrace: Duration.millis(200),
})

const runner = () => Layer.provide(runnerLayer(runnerConfig()), layerClock)

/** A shell script printing what it was given of the host's environment, a name a line. */
const PRINT =
  'for name in DBUS_SESSION_BUS_ADDRESS DISPLAY OP_SESSION_my BW_SESSION GNUPGHOME ANTHROPIC_API_KEY SSH_AUTH_SOCK; do echo "$name=$(printenv "$name")"; done'

/** What `PRINT` prints for a command given the host's sessions. */
const printed = [
  'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
  'DISPLAY=:0',
  'OP_SESSION_my=op-session',
  'BW_SESSION=bw-session',
  'GNUPGHOME=/home/a/.gnupg',
  'ANTHROPIC_API_KEY=',
  'SSH_AUTH_SOCK=',
].join('\n')

describe('a secret store’s command', () => {
  it.effect('runs a key’s command with the host’s sessions', () =>
    Effect.gen(function* () {
      const key = yield* runKeyCommand({
        name: SecretName.make('anthropic'),
        command: PRINT,
        cwd: root,
      })
      expect(Redacted.value(key)).toBe(printed)
    }).pipe(Effect.provide(runner())),
  )

  it.effect.each(['without input', 'with input'] as const)(
    'runs a keyring CLI %s with the host’s sessions',
    kind =>
      Effect.gen(function* () {
        const cli = yield* KeyringCli
        const outcome = yield* cli.call({
          command: 'sh',
          args: ['-c', `cat > /dev/null; ${PRINT}`],
          input:
            kind === 'with input'
              ? Option.some(Redacted.make('an item'))
              : Option.none(),
        })
        expect(
          KeyringOutcome.$match(outcome, {
            Exited: ({ code, stdout }) => ({
              code,
              stdout: Redacted.value(stdout).trim(),
            }),
            Failed: ({ reason }) => ({ failed: reason }),
          }),
        ).toEqual({ code: 0, stdout: printed })
      }).pipe(Effect.provide(Layer.provide(layerKeyringCli(root), runner()))),
  )
})
