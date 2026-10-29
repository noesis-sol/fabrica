import { Duration, Effect, Layer } from 'effect'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'

import {
  CloneOutcome,
  Git,
  type GitConfig,
  layer as gitLayer,
} from '../src/git'
import {
  CommandOutcome,
  ExitStatus,
  ProcessRunner,
  type RunnerConfig,
  commandEnvironment,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'

// Git's network commands reach the host's ssh-agent (spec §10.1, §10.3): a clone of an SSH URL runs
// a stub `ssh` ahead of the system's on the test's PATH, which writes what it was given; the engine's
// `SSH_AUTH_SOCK` reaches it, and ssh runs in batch mode; a host whose git configuration names its own
// ssh command (`core.sshCommand`) has that one run as it is. No other command gets the agent's socket.

const AGENT = '/agent/ssh.sock'

let root = ''
let home = ''
let ownHome = ''
let stubs = ''
let gitFolder = ''

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-ssh-agent-')))
  home = join(root, 'home')
  ownHome = join(root, 'own-home')
  stubs = join(root, 'stubs')
  mkdirSync(home)
  mkdirSync(ownHome)
  mkdirSync(stubs)
  const user = '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n'
  writeFileSync(join(home, '.gitconfig'), user)
  writeFileSync(
    join(ownHome, '.gitconfig'),
    `${user}[core]\n\tsshCommand = own-ssh --own-flag\n`,
  )
  // ssh as git runs it, and a host's own: each writes its name, the agent's socket it saw and its
  // arguments, then refuses.
  for (const name of ['ssh', 'own-ssh']) {
    writeFileSync(
      join(stubs, name),
      `#!/bin/sh\necho "by=${name}" > "$HOME/ssh-saw"\necho "agent=\${SSH_AUTH_SOCK-none}" >> "$HOME/ssh-saw"\necho "args=$*" >> "$HOME/ssh-saw"\necho "stub ssh refused" >&2\nexit 255\n`,
    )
    chmodSync(join(stubs, name), 0o755)
  }
  // A command that prints the agent's socket it was given.
  writeFileSync(
    join(stubs, 'show-agent'),
    '#!/bin/sh\necho "agent=${SSH_AUTH_SOCK-none}"\n',
  )
  chmodSync(join(stubs, 'show-agent'), 0o755)
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
})

/** The runner's host facts, its home folder `homeFolder`. */
const runnerConfig = (homeFolder: string): RunnerConfig => ({
  hostEnvironment: {
    PATH: `${stubs}:${gitFolder}:/usr/bin:/bin`,
    HOME: homeFolder,
    LANG: 'C',
    SSH_AUTH_SOCK: AGENT,
  },
  enginePriority: 0,
  priority: hostPriority,
  listProcesses,
  pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
  self: process.pid,
  killGrace: Duration.seconds(2),
  outputGrace: Duration.millis(200),
})

const config: GitConfig = {
  timeLimit: Duration.minutes(1),
  readRetries: { times: 0, spacing: Duration.zero },
}

const runner = (homeFolder: string) =>
  Layer.provide(runnerLayer(runnerConfig(homeFolder)), layerClock)

/** The runner and git, their home folder `homeFolder` (the one whose git names no ssh command unless given). */
const services = (homeFolder = home) =>
  Layer.merge(
    runner(homeFolder),
    Layer.provide(gitLayer(config), runner(homeFolder)),
  )

describe('commandEnvironment', () => {
  it('gives the host’s ssh-agent to a network command alone', () => {
    const host = { PATH: '/usr/bin', SSH_AUTH_SOCK: AGENT }
    expect(commandEnvironment({ host, extra: {} })).toEqual({
      PATH: '/usr/bin',
    })
    expect(commandEnvironment({ host, extra: {}, network: true })).toEqual({
      PATH: '/usr/bin',
      SSH_AUTH_SOCK: AGENT,
    })
  })
})

describe('Git.clone', () => {
  it.live('reaches the host’s ssh-agent through ssh in batch mode', () =>
    Effect.gen(function* () {
      const into = join(root, 'cloned')
      const outcome = yield* (yield* Git).clone({
        url: 'ssh://git@git.invalid/repo.git',
        into,
      })
      expect(outcome).toEqual(
        CloneOutcome.Refused({
          message: expect.stringContaining('stub ssh refused'),
        }),
      )
      const saw = readFileSync(join(home, 'ssh-saw'), 'utf8')
      expect(saw).toContain(`by=ssh\nagent=${AGENT}\n`)
      expect(saw).toMatch(/^args=.*-o BatchMode=yes.*git@git\.invalid/m)
      expect(existsSync(into)).toBe(false)
    }).pipe(Effect.provide(services())),
  )

  it.live('runs the host’s own ssh command as it is, with the agent', () =>
    Effect.gen(function* () {
      const into = join(root, 'cloned-own')
      const outcome = yield* (yield* Git).clone({
        url: 'ssh://git@git.invalid/repo.git',
        into,
      })
      expect(outcome).toEqual(
        CloneOutcome.Refused({
          message: expect.stringContaining('stub ssh refused'),
        }),
      )
      const saw = readFileSync(join(ownHome, 'ssh-saw'), 'utf8')
      expect(saw).toContain(`by=own-ssh\nagent=${AGENT}\n`)
      expect(saw).toMatch(/^args=--own-flag .*git@git\.invalid/m)
      expect(saw).not.toContain('BatchMode')
    }).pipe(Effect.provide(services(ownHome))),
  )
})

describe('ProcessRunner', () => {
  it.live(
    'keeps the host’s ssh-agent from a command that isn’t a network one',
    () =>
      Effect.gen(function* () {
        const outcome = yield* (yield* ProcessRunner).run({
          command: 'show-agent',
          args: [],
          cwd: home,
          timeLimit: Duration.seconds(30),
        })
        expect(outcome).toEqual(
          CommandOutcome.Exited({
            status: ExitStatus.Code({ code: 0 }),
            stdout: 'agent=none\n',
            stderr: '',
          }),
        )
      }).pipe(Effect.provide(services())),
  )
})
