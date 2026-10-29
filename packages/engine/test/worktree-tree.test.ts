import { Duration, Effect, Layer } from 'effect'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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

// `Git.worktreeTree` against real git in temp folders (spec §13.6, H89): the tree a worktree has as
// it is, HEAD's with its uncommitted and untracked files, is the tree a commit of everything gives,
// and reading it changes nothing in the worktree, its index among it. The engine's environment points
// git at another repository and index, which must never reach the commands.

let root = ''
let home = ''
let gitFolder = ''
let elsewhere = ''
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
const repository = (
  files: Readonly<Record<string, string>> = { 'README.md': 'one\n' },
) => {
  counter += 1
  const checkout = join(root, `repo-${counter}`)
  mkdirSync(checkout)
  git(checkout, 'init', '--quiet', '--initial-branch=main')
  write(checkout, files)
  git(checkout, 'add', '--all', '--force')
  git(checkout, 'commit', '--quiet', '--message', 'one')
  return checkout
}

/** The worktree's status and index, as a read must leave them. */
const state = (worktree: string) => ({
  status: git(worktree, 'status', '--porcelain=v1', '--untracked-files=all'),
  index: readFileSync(
    resolve(worktree, git(worktree, 'rev-parse', '--git-path', 'index')),
  ),
})

/** The tree a commit of everything in the worktree has, committed on a throwaway branch. */
const committedTree = (worktree: string): string => {
  git(worktree, 'switch', '--quiet', '--create', `everything-${counter}`)
  git(worktree, 'add', '--all')
  git(worktree, 'commit', '--quiet', '--allow-empty', '--message', 'all')
  return git(worktree, 'rev-parse', 'HEAD^{tree}')
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-tree-')))
  home = join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
  elsewhere = repository()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const runnerConfig = (): RunnerConfig => ({
  hostEnvironment: {
    PATH: `${gitFolder}:/usr/bin:/bin`,
    HOME: home,
    LANG: 'C',
    GIT_DIR: join(elsewhere, '.git'),
    GIT_WORK_TREE: elsewhere,
    GIT_INDEX_FILE: join(elsewhere, '.git', 'index'),
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

const treeOf = (worktree: string) =>
  Effect.gen(function* () {
    return yield* (yield* Git).worktreeTree({ worktree })
  }).pipe(Effect.provide(services))

describe('the tree of a worktree as it is', () => {
  it.live('is HEAD’s for a clean worktree', () =>
    Effect.gen(function* () {
      const worktree = repository()
      const before = state(worktree)
      const tree = yield* treeOf(worktree)
      expect(tree).toBe(git(worktree, 'rev-parse', 'HEAD^{tree}'))
      expect(state(worktree)).toEqual(before)
    }),
  )

  it.live(
    'holds the uncommitted and untracked files, as committing everything would, changing nothing',
    () =>
      Effect.gen(function* () {
        const worktree = repository({
          'README.md': 'one\n',
          'gone.txt': 'gone\n',
          'src/main.sh': 'echo main\n',
          '.gitignore': '*.log\nbuild/\n',
          'kept.log': 'tracked though ignored\n',
        })
        write(worktree, {
          'README.md': 'one, staged\n',
          'kept.log': 'changed\n',
          'src/new/deep.txt': 'untracked\n',
          'notes.txt': 'untracked\n',
          'build/out.txt': 'ignored\n',
          'debug.log': 'ignored\n',
        })
        git(worktree, 'add', 'README.md')
        write(worktree, { 'README.md': 'one, staged, then changed again\n' })
        rmSync(join(worktree, 'gone.txt'))
        chmodSync(join(worktree, 'src/main.sh'), 0o755)
        const before = state(worktree)

        const tree = yield* treeOf(worktree)

        expect(state(worktree)).toEqual(before)
        expect(tree).not.toBe(git(worktree, 'rev-parse', 'HEAD^{tree}'))
        expect(tree).toBe(committedTree(worktree))
        const files = git(worktree, 'ls-tree', '-r', '--name-only', tree)
        expect(files.split('\n')).not.toContain('debug.log')
        expect(files.split('\n')).toContain('kept.log')
      }),
  )

  it.live(
    'reads a linked worktree’s own files, leaving nothing in its git folder',
    () =>
      Effect.gen(function* () {
        const checkout = repository()
        const linked = join(root, `linked-${counter}`)
        git(checkout, 'worktree', 'add', '--quiet', '-b', 'linked', linked)
        write(checkout, { 'README.md': 'the checkout’s own change\n' })
        write(linked, { 'feature.txt': 'the worktree’s\n' })
        const ownFolder = git(linked, 'rev-parse', '--absolute-git-dir')
        const before = state(linked)

        const tree = yield* treeOf(linked)

        expect(state(linked)).toEqual(before)
        expect(existsSync(join(ownFolder, 'fabrica-tree'))).toBe(false)
        expect(git(checkout, 'worktree', 'list').split('\n')).toHaveLength(2)
        expect(git(linked, 'show', `${tree}:README.md`)).toBe('one')
        expect(tree).toBe(committedTree(linked))
      }),
  )
})
