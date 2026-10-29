import { Duration, Effect, Layer } from 'effect'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from '@effect/vitest'

import { Git, type GitConfig, layer as gitLayer } from '../src/git'
import {
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'

// `Git.removeUntracked` against real git in temp folders (spec §13.7 What a check leaves): the
// untracked files named are removed, each by its literal name, and a tracked or ignored one never.

let root = ''
let home = ''
let gitFolder = ''
let counter = 0

const fixtureEnv = () => ({
  PATH: `${gitFolder}:/usr/bin:/bin`,
  HOME: home,
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
})

/** Runs git for a test's fixture, its output trimmed. */
const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync('git', args, {
    cwd,
    env: fixtureEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

const write = (cwd: string, files: Readonly<Record<string, string>>) => {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(cwd, name, '..'), { recursive: true })
    writeFileSync(join(cwd, name), content)
  }
}

/** A new repository on `main` with `files` in one commit. */
const repository = (files: Readonly<Record<string, string>>) => {
  counter += 1
  const checkout = join(root, `repo-${counter}`)
  mkdirSync(checkout)
  git(checkout, 'init', '--quiet', '--initial-branch=main')
  write(checkout, files)
  git(checkout, 'add', '--all')
  git(checkout, 'commit', '--quiet', '--message', 'one')
  return checkout
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-untracked-')))
  home = join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const runnerConfig = (): RunnerConfig => ({
  hostEnvironment: {
    PATH: `${gitFolder}:/usr/bin:/bin`,
    HOME: home,
    LANG: 'C',
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
  readRetries: { times: 1, spacing: Duration.zero },
}

const services = Layer.provide(
  gitLayer(config),
  Layer.provide(runnerLayer(runnerConfig()), layerClock),
)

const removeUntracked = (input: {
  readonly worktree: string
  readonly files: ReadonlyArray<string>
}) => Effect.flatMap(Git, given => given.removeUntracked(input))

describe('Git.removeUntracked', () => {
  it.effect(
    'removes the untracked files named, by their literal names, and no others',
    () =>
      Effect.gen(function* () {
        const repo = repository({
          'README.md': 'one\n',
          '.gitignore': 'ignored.txt\n',
        })
        write(repo, {
          'reports/a*.txt': 'a\n',
          'reports/ab.txt': 'b\n',
          'top.txt': 'top\n',
          'ignored.txt': 'ignored\n',
          'kept.txt': 'kept\n',
        })
        yield* removeUntracked({
          worktree: repo,
          files: [
            'reports/a*.txt',
            'top.txt',
            'README.md',
            'ignored.txt',
            'gone.txt',
          ],
        })
        expect(existsSync(join(repo, 'reports', 'a*.txt'))).toBe(false)
        expect(existsSync(join(repo, 'top.txt'))).toBe(false)
        // A file a pattern would match, a tracked one, an ignored one and one not named stay.
        expect(existsSync(join(repo, 'reports', 'ab.txt'))).toBe(true)
        expect(existsSync(join(repo, 'README.md'))).toBe(true)
        expect(existsSync(join(repo, 'ignored.txt'))).toBe(true)
        expect(existsSync(join(repo, 'kept.txt'))).toBe(true)
        expect(git(repo, 'status', '--porcelain')).toBe(
          '?? kept.txt\n?? reports/',
        )
      }).pipe(Effect.provide(services)),
  )
})
