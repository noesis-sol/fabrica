import { Duration, Effect, Layer } from 'effect'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

// `Git.restoreTracked` against real git in temp folders (spec §13.7 What a check leaves): the tracked
// files named are put back as HEAD has them, in the index and the worktree, each by its literal name, and
// an untracked or ignored one is never touched.

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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-restore-')))
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

const restoreTracked = (input: {
  readonly worktree: string
  readonly files: ReadonlyArray<string>
}) => Effect.flatMap(Git, given => given.restoreTracked(input))

describe('Git.restoreTracked', () => {
  it.effect(
    'puts the tracked files named back as HEAD has them, by their literal names, and no others',
    () =>
      Effect.gen(function* () {
        const repo = repository({
          'README.md': 'one\n',
          '.gitignore': 'ignored.txt\n',
          'src/a*.ts': 'a\n',
          'src/ab.ts': 'ab\n',
          'src/gone.ts': 'gone\n',
          'src/staged.ts': 'staged\n',
        })
        write(repo, {
          'src/a*.ts': 'formatted a\n',
          'src/ab.ts': 'formatted ab\n',
          'src/staged.ts': 'staged change\n',
          'src/added.ts': 'added\n',
          'ignored.txt': 'ignored\n',
          'kept.txt': 'kept\n',
        })
        rmSync(join(repo, 'src', 'gone.ts'))
        git(repo, 'add', '--', 'src/staged.ts', 'src/added.ts')
        yield* restoreTracked({
          worktree: repo,
          files: [
            'src/a*.ts',
            'src/gone.ts',
            'src/staged.ts',
            'src/added.ts',
            'kept.txt',
            'ignored.txt',
            'missing.ts',
          ],
        })
        expect(readFileSync(join(repo, 'src', 'a*.ts'), 'utf8')).toBe('a\n')
        expect(readFileSync(join(repo, 'src', 'gone.ts'), 'utf8')).toBe(
          'gone\n',
        )
        expect(readFileSync(join(repo, 'src', 'staged.ts'), 'utf8')).toBe(
          'staged\n',
        )
        // One HEAD doesn't have is taken out of the index and the worktree.
        expect(existsSync(join(repo, 'src', 'added.ts'))).toBe(false)
        // A file a pattern would match, an untracked one and an ignored one stay as they are.
        expect(readFileSync(join(repo, 'src', 'ab.ts'), 'utf8')).toBe(
          'formatted ab\n',
        )
        expect(existsSync(join(repo, 'kept.txt'))).toBe(true)
        expect(existsSync(join(repo, 'ignored.txt'))).toBe(true)
        expect(git(repo, 'status', '--porcelain')).toBe(
          'M src/ab.ts\n?? kept.txt',
        )
      }).pipe(Effect.provide(services)),
  )
})
