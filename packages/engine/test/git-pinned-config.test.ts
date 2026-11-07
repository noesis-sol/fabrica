import { Duration, Effect, Layer } from 'effect'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from '@effect/vitest'
import { CommitHash } from '@fabrica/contracts'

import {
  CloneOutcome,
  Git,
  type GitConfig,
  PushOutcome,
  layer as gitLayer,
} from '../src/git'
import {
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import { pushBase } from '../src/projects/base-sync'

// The engine's own git runs no fsmonitor and no hook a repository's configuration names (spec §12.6,
// §20.2), against real git in temp folders: wherever a worker put them (its worktree's configuration,
// the configuration every worktree shares, `.git/hooks`), the engine's commands leave them unrun, and
// git run plainly in the same place runs them, so each test shows what the pin holds off.

let root = ''
let home = ''
let gitFolder = ''
let counter = 0

/** Runs git for a test's fixture, unpinned, its output trimmed. */
const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync('git', args, {
    cwd,
    env: {
      PATH: `${gitFolder}:/usr/bin:/bin`,
      HOME: home,
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

const commit = (cwd: string, name: string): CommitHash => {
  writeFileSync(join(cwd, name), `${name}\n`)
  git(cwd, 'add', '--all')
  git(cwd, 'commit', '--quiet', '--message', name)
  return CommitHash.make(git(cwd, 'rev-parse', 'HEAD'))
}

const freshFolder = (name: string): string => {
  counter += 1
  const folder = join(root, `${name}-${counter}`)
  mkdirSync(folder)
  return folder
}

/** `main` with a ticket's worktree one commit off it, and Base moved on beside it. */
const repository = () => {
  const checkout = freshFolder('repo')
  git(checkout, 'init', '--quiet', '--initial-branch=main')
  commit(checkout, 'one')
  const worktree = join(freshFolder('worktrees'), 'ticket')
  git(checkout, 'worktree', 'add', '--quiet', '-b', 'ticket', worktree)
  commit(worktree, 'change')
  return { checkout, worktree, onto: commit(checkout, 'moved') }
}

/**
 * Commands that write down that they ran, by their own names: one file hard-linked, since a file's
 * first run is what macOS makes wait.
 */
const planted = () => {
  const marks = freshFolder('marks')
  const folder = freshFolder('planted')
  const first = join(folder, 'fsmonitor')
  writeFileSync(first, `#!/bin/sh\n: > '${marks}'/"$(basename "$0")"\n`)
  chmodSync(first, 0o755)
  const inHooks = (hooks: string) => {
    mkdirSync(hooks, { recursive: true })
    for (const hook of [
      'post-checkout',
      'post-index-change',
      'post-merge',
      'post-rewrite',
      'pre-push',
      'pre-rebase',
      'reference-transaction',
    ]) {
      linkSync(first, join(hooks, hook))
    }
  }
  return {
    fsmonitor: first,
    inHooks,
    ran: () => readdirSync(marks),
  }
}

/** What the engine does in a repository: its status, a new worktree, the rebase, the merge. */
const engineWork = ({
  checkout,
  worktree,
  onto,
}: ReturnType<typeof repository>) =>
  Effect.gen(function* () {
    const given = yield* Git
    yield* given.status({ worktree })
    yield* given.status({ worktree: checkout })
    yield* given.addWorktree({
      repo: checkout,
      path: join(freshFolder('worktrees'), 'another'),
      branch: 'another',
      from: onto,
    })
    const rebased = yield* given.rebase({ worktree, onto })
    expect(rebased._tag).toBe('Rebased')
    const merged = yield* given.fastForward({
      checkout,
      base: 'main',
      to: CommitHash.make(git(worktree, 'rev-parse', 'HEAD')),
    })
    expect(merged._tag).toBe('FastForwarded')
  })

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-pinned-')))
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

const services = Layer.suspend(() =>
  Layer.provide(
    gitLayer(config),
    Layer.provide(runnerLayer(runnerConfig()), layerClock),
  ),
)

describe('the engine’s git', () => {
  it.effect(
    'runs no fsmonitor or hooks a worktree’s own configuration names',
    () =>
      Effect.gen(function* () {
        const repo = repository()
        const { fsmonitor, inHooks, ran } = planted()
        const hooks = join(freshFolder('hooks'), 'hooks')
        inHooks(hooks)
        git(repo.checkout, 'config', 'extensions.worktreeConfig', 'true')
        git(repo.worktree, 'config', '--worktree', 'core.fsmonitor', fsmonitor)
        git(repo.worktree, 'config', '--worktree', 'core.hooksPath', hooks)

        yield* engineWork(repo)
        expect(ran()).toEqual([])

        git(repo.worktree, 'status')
        expect(ran()).toContain('fsmonitor')
        git(repo.worktree, 'checkout', '--quiet', '-b', 'plain')
        expect(ran()).toContain('post-checkout')
      }).pipe(Effect.provide(services)),
  )

  it.effect(
    'runs no fsmonitor or hooks the configuration every worktree shares names',
    () =>
      Effect.gen(function* () {
        const repo = repository()
        const { fsmonitor, inHooks, ran } = planted()
        const hooks = join(freshFolder('hooks'), 'hooks')
        inHooks(hooks)
        git(repo.checkout, 'config', 'core.fsmonitor', fsmonitor)
        git(repo.checkout, 'config', 'core.hooksPath', hooks)

        yield* engineWork(repo)
        expect(ran()).toEqual([])

        git(repo.checkout, 'status')
        expect(ran()).toContain('fsmonitor')
        git(repo.checkout, 'checkout', '--quiet', '-b', 'plain')
        expect(ran()).toContain('post-checkout')
      }).pipe(Effect.provide(services)),
  )

  it.effect('runs no hook in the repository’s own hooks folder', () =>
    Effect.gen(function* () {
      const repo = repository()
      const { inHooks, ran } = planted()
      inHooks(join(repo.checkout, '.git', 'hooks'))

      yield* engineWork(repo)
      expect(ran()).toEqual([])

      git(repo.checkout, 'checkout', '--quiet', '-b', 'plain')
      expect(ran()).toContain('post-checkout')
    }).pipe(Effect.provide(services)),
  )

  it.effect(
    'pushes past a local pre-push hook, leaving a clone’s configuration as it was',
    () =>
      Effect.gen(function* () {
        const given = yield* Git
        const remote = freshFolder('remote')
        git(remote, 'init', '--quiet', '--bare', '--initial-branch=main')
        const seed = freshFolder('seed')
        git(seed, 'init', '--quiet', '--initial-branch=main')
        commit(seed, 'one')
        git(seed, 'push', '--quiet', remote, 'main')

        const clone = join(freshFolder('clones'), 'clone')
        expect(yield* given.clone({ url: remote, into: clone })).toEqual(
          CloneOutcome.Cloned(),
        )
        expect(
          git(clone, 'config', '--default', 'unset', '--get', 'core.hooksPath'),
        ).toBe('unset')
        expect(
          git(clone, 'config', '--default', 'unset', '--get', 'core.fsmonitor'),
        ).toBe('unset')

        const hook = join(clone, '.git', 'hooks', 'pre-push')
        writeFileSync(hook, '#!/bin/sh\nexit 1\n')
        chmodSync(hook, 0o755)
        const head = commit(clone, 'two')
        expect(
          yield* given.push({
            repo: clone,
            remote: 'origin',
            commit: head,
            ref: 'refs/heads/main',
          }),
        ).toEqual(PushOutcome.Pushed())
        expect(git(remote, 'rev-parse', 'main')).toBe(head)

        expect(() => git(clone, 'push', 'origin', 'main:plain')).toThrow()
      }).pipe(Effect.provide(services)),
  )

  it.effect('pushes a Base with no file under git-lfs', () =>
    Effect.gen(function* () {
      const remote = freshFolder('remote')
      git(remote, 'init', '--quiet', '--bare', '--initial-branch=main')
      const checkout = freshFolder('no-lfs')
      git(checkout, 'init', '--quiet', '--initial-branch=main')
      commit(checkout, 'one')
      git(checkout, 'remote', 'add', 'origin', remote)
      git(checkout, 'push', '--quiet', '--set-upstream', 'origin', 'main')

      writeFileSync(
        join(checkout, '.gitattributes'),
        '*.bin filter=lfs diff=lfs merge=lfs -text\n',
      )
      const head = commit(checkout, 'two')
      const pushed = yield* pushBase({ checkout, base: 'main' })
      expect(pushed._tag).toBe('Pushed')
      expect(git(remote, 'rev-parse', 'main')).toBe(head)
    }).pipe(Effect.provide(services)),
  )
})
