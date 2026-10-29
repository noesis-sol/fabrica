import { Duration, Effect, Layer } from 'effect'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

// `Git.worktreeTree` against real git, for a file edited in the second its index was written: git
// takes such an entry as racily clean, and checks its content, by the index file's own mtime, so the
// engine's copy of the index must keep it. The race is made, not waited on: the file and the index
// are given one fixed time, and ctime is left out of git's checks (`core.trustctime`), as a ctime
// can't be set.

let root = ''
let home = ''
let gitFolder = ''

const fixtureEnv = () => ({
  PATH: `${gitFolder}:/usr/bin:/bin`,
  HOME: home,
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
})

/** Runs git for the fixture, its output trimmed. */
const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync('git', args, {
    cwd,
    env: fixtureEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-tree-racy-')))
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

describe('the tree of a worktree with a racily clean file', () => {
  it.live(
    'holds a same-size edit made in the second the index was written',
    () =>
      Effect.gen(function* () {
        const worktree = join(root, 'repo')
        mkdirSync(worktree)
        git(worktree, 'init', '--quiet', '--initial-branch=main')
        git(worktree, 'config', 'core.trustctime', 'false')
        const readme = join(worktree, 'README.md')
        writeFileSync(readme, 'one\n')
        git(worktree, 'add', '--all')
        git(worktree, 'commit', '--quiet', '--message', 'one')
        const head = git(worktree, 'rev-parse', 'HEAD^{tree}')

        // The index records README.md at a fixed time, then is itself given that time, and the
        // file is edited to the same size and set back to it: only its content tells it changed.
        const second = new Date(1_700_000_000_000)
        utimesSync(readme, second, second)
        git(worktree, 'update-index', '--refresh')
        const index = resolve(
          worktree,
          git(worktree, 'rev-parse', '--git-path', 'index'),
        )
        utimesSync(index, second, second)
        writeFileSync(readme, 'two\n')
        utimesSync(readme, second, second)

        const tree = yield* Effect.gen(function* () {
          return yield* (yield* Git).worktreeTree({ worktree })
        }).pipe(Effect.provide(services))

        expect(tree).not.toBe(head)
        expect(git(worktree, 'show', `${tree}:README.md`)).toBe('two')
      }),
  )
})
