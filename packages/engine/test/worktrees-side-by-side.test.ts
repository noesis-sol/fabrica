import { Deferred, Duration, Effect, Layer } from 'effect'
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
import { CommitHash, TicketId } from '@fabrica/contracts'

import {
  CantTell,
  Git,
  type GitConfig,
  GitFailed,
  type WorktreeHome,
  Worktrees,
  layer as gitLayer,
  worktreePath,
  worktreesLayer,
} from '../src/git'
import {
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'

// `Worktrees.prepare` side by side against real git in temp folders (spec §13.2): a run starts its
// tickets together, and `git worktree add` beside another can die reading the `commondir` the other has
// made but not yet written (fab-50w), so a checkout's worktrees are added one at a time.

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

/** A new checkout on `main` with one commit, where its worktrees go, and that commit. */
const checkout = () => {
  counter += 1
  const repo = join(root, `repo-${counter}`)
  mkdirSync(repo)
  git(repo, 'init', '--quiet', '--initial-branch=main')
  writeFileSync(join(repo, 'README.md'), 'one\n')
  git(repo, 'add', '--all')
  git(repo, 'commit', '--quiet', '--message', 'one')
  const home: WorktreeHome = {
    checkout: repo,
    folder: join(root, `worktrees-${counter}`),
  }
  return { home, base: CommitHash.make(git(repo, 'rev-parse', 'HEAD')) }
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-adds-')))
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

const realGit = () =>
  Layer.provide(
    gitLayer(config),
    Layer.provide(runnerLayer(runnerConfig()), layerClock),
  )

/** The worktrees service over git whose `addWorktree` goes through `around`, given the add's repository. */
const worktreesOver = (
  around: (
    repo: string,
    add: Effect.Effect<void, GitFailed>,
  ) => Effect.Effect<void, GitFailed>,
) =>
  Layer.provide(
    worktreesLayer,
    Layer.effect(
      Git,
      Effect.map(Git, real =>
        Git.of({
          ...real,
          addWorktree: input => around(input.repo, real.addWorktree(input)),
        }),
      ),
    ).pipe(Layer.provide(realGit())),
  )

const tickets = ['fa-a1', 'fa-a2', 'fa-a3', 'fa-a4'].map(id =>
  TicketId.make(id),
)

describe('worktrees prepared side by side', () => {
  it.effect('adds one at a time to a checkout', () => {
    const { home: worktreeHome, base } = checkout()
    let adding = 0
    let most = 0
    return Effect.gen(function* () {
      const worktrees = yield* Worktrees
      yield* Effect.forEach(
        tickets,
        ticket => worktrees.prepare({ home: worktreeHome, ticket, base }),
        { concurrency: 'unbounded', discard: true },
      )
      expect(most).toBe(1)
      for (const ticket of tickets)
        expect(existsSync(worktreePath({ home: worktreeHome, ticket }))).toBe(
          true,
        )
    }).pipe(
      Effect.provide(
        worktreesOver((_repo, add) =>
          Effect.suspend(() => {
            adding += 1
            most = Math.max(most, adding)
            return add
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                adding -= 1
              }),
            ),
          ),
        ),
      ),
    )
  })

  it.effect("doesn't keep one checkout's add waiting on another's", () => {
    const one = checkout()
    const other = checkout()
    return Effect.gen(function* () {
      const otherAdding = yield* Deferred.make<void>()
      yield* Effect.gen(function* () {
        const worktrees = yield* Worktrees
        yield* Effect.forEach(
          [one, other],
          ({ home: worktreeHome, base }) =>
            worktrees.prepare({
              home: worktreeHome,
              ticket: TicketId.make('fa-a1'),
              base,
            }),
          { concurrency: 'unbounded', discard: true },
        )
      }).pipe(
        Effect.provide(
          // The first checkout's add ends only once the other's has begun.
          worktreesOver((repo, add) =>
            repo === one.home.checkout
              ? Effect.andThen(Deferred.await(otherAdding), add)
              : Effect.andThen(Deferred.succeed(otherAdding, undefined), add),
          ),
        ),
      )
    })
  })
})

describe("git's failures, in words", () => {
  it('says the command that failed and why', () => {
    expect(
      new GitFailed({
        command: 'worktree add',
        reason: 'exit 128: fatal: no',
      }).message,
    ).toBe('git worktree add: exit 128: fatal: no')
  })

  it('says the read it can’t tell and why', () => {
    expect(
      new CantTell({ read: 'worktrees', reason: 'timed out' }).message,
    ).toBe("can't tell worktrees: timed out")
  })
})
