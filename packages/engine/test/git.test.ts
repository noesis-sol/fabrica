import { Duration, Effect, Layer, Option } from 'effect'
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
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { CommitHash, TicketId } from '@fabrica/contracts'

import {
  AbortOutcome,
  CantTell,
  FastForwardOutcome,
  Git,
  type GitConfig,
  GitVersion,
  Prepared,
  RebaseOutcome,
  Worktrees,
  besideCheckout,
  layer as gitLayer,
  inFolder,
  parseGitVersion,
  parseStatus,
  parseWorktrees,
  ticketBranch,
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

// The Git and Worktrees services against real git in temp folders (spec §13.7, §10.2, §24). The git
// the tests run is the one `git --exec-path` names, found once; the commands get a home of the test's
// own, so no user configuration is read, and a `GIT_DIR` in the engine's environment that must never
// reach them.

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

const hash = (cwd: string, revision: string): CommitHash =>
  CommitHash.make(git(cwd, 'rev-parse', '--verify', `${revision}^{commit}`))

/** Writes `files` in `cwd` and commits them as `message`, returning the commit. */
const commit = (
  cwd: string,
  message: string,
  files: Readonly<Record<string, string>>,
): CommitHash => {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(cwd, name, '..'), { recursive: true })
    writeFileSync(join(cwd, name), content)
  }
  git(cwd, 'add', '--all')
  git(cwd, 'commit', '--quiet', '--message', message)
  return hash(cwd, 'HEAD')
}

/** A new repository on `main` with one commit, in a folder of its own. */
const repository = (
  files: Readonly<Record<string, string>> = { 'README.md': 'one\n' },
) => {
  counter += 1
  const checkout = join(root, `repo-${counter}`)
  mkdirSync(checkout)
  git(checkout, 'init', '--quiet', '--initial-branch=main')
  const first = commit(checkout, 'one', files)
  return { checkout, first }
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-git-')))
  home = join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n[init]\n\tdefaultBranch = main\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
  elsewhere = repository().checkout
})

const runnerConfig = (path: string): RunnerConfig => ({
  hostEnvironment: {
    PATH: path,
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
  readRetries: { times: 2, spacing: Duration.zero },
}

/** The services, their git found on `path` (the real git's folder unless given). */
const services = (path = `${gitFolder}:/usr/bin:/bin`) => {
  const runner = Layer.provide(runnerLayer(runnerConfig(path)), layerClock)
  const gitService = Layer.provide(gitLayer(config), runner)
  return Layer.merge(gitService, Layer.provide(worktreesLayer, gitService))
}

/** A folder of stubs, `git` among them, to put ahead of the real git. */
const stubs = (script: string): string => {
  counter += 1
  const folder = join(root, `stubs-${counter}`)
  mkdirSync(folder)
  writeFileSync(join(folder, 'git'), script)
  chmodSync(join(folder, 'git'), 0o755)
  return folder
}

const ticket = TicketId.make('fa-a1b2')

describe('Git.version', () => {
  it.effect('takes the git it runs as supported', () =>
    Effect.gen(function* () {
      const version = yield* (yield* Git).version
      expect(version._tag).toBe('Supported')
    }).pipe(Effect.provide(services())),
  )

  it.effect('says a git older than 2.38 is too old', () =>
    Effect.gen(function* () {
      const version = yield* (yield* Git).version
      expect(version).toEqual(
        GitVersion.TooOld({ version: '2.34.1', minimum: '2.38' }),
      )
    }).pipe(
      Effect.provide(services(stubs('#!/bin/sh\necho "git version 2.34.1"\n'))),
    ),
  )

  it.effect('says git is missing when the PATH has none', () =>
    Effect.gen(function* () {
      const empty = join(root, 'no-git')
      mkdirSync(empty, { recursive: true })
      const version = yield* Effect.provide(
        Effect.gen(function* () {
          return yield* (yield* Git).version
        }),
        services(empty),
      )
      expect(version).toEqual(GitVersion.Missing({ path: empty }))
    }),
  )

  it('reads versions as git prints them', () => {
    expect(parseGitVersion('git version 2.54.0 (Apple Git-157)\n')).toEqual(
      Option.some({ version: '2.54.0', supported: true }),
    )
    expect(parseGitVersion('git version 2.38.0')).toEqual(
      Option.some({ version: '2.38.0', supported: true }),
    )
    expect(parseGitVersion('git version 2.39.3.windows.1')).toEqual(
      Option.some({ version: '2.39.3.windows.1', supported: true }),
    )
    expect(parseGitVersion('git version 2.37.7')).toEqual(
      Option.some({ version: '2.37.7', supported: false }),
    )
    expect(parseGitVersion('git version 3.0.0')).toEqual(
      Option.some({ version: '3.0.0', supported: true }),
    )
    expect(Option.isNone(parseGitVersion('not git'))).toBe(true)
  })
})

describe('Git readers', () => {
  it.effect('reads a worktree status: uncommitted and untracked files', () =>
    Effect.gen(function* () {
      const service = yield* Git
      const { checkout } = repository({
        'a.txt': 'a\n',
        'b.txt': 'b\n',
        'c.txt': 'c\n',
      })
      expect(yield* service.status({ worktree: checkout })).toEqual({
        uncommitted: [],
        untracked: [],
      })
      writeFileSync(join(checkout, 'a.txt'), 'changed\n')
      writeFileSync(join(checkout, 'b.txt'), 'staged\n')
      git(checkout, 'add', 'b.txt')
      rmSync(join(checkout, 'c.txt'))
      mkdirSync(join(checkout, 'new', 'deep'), { recursive: true })
      writeFileSync(join(checkout, 'new', 'deep', 'file name.txt'), 'x\n')
      const status = yield* service.status({ worktree: checkout })
      expect([...status.uncommitted].sort()).toEqual([
        'a.txt',
        'b.txt',
        'c.txt',
      ])
      expect(status.untracked).toEqual(['new/deep/file name.txt'])
    }).pipe(Effect.provide(services())),
  )

  it.effect('gives CantTell for a status git can’t read, never clean', () =>
    Effect.gen(function* () {
      const { checkout } = repository()
      writeFileSync(join(checkout, '.git', 'index'), 'not an index')
      const error = yield* Effect.flip(
        (yield* Git).status({ worktree: checkout }),
      )
      expect(error).toBeInstanceOf(CantTell)
      expect(error.read).toBe('status')
      expect(error.reason).toContain('exit 128')
    }).pipe(Effect.provide(services())),
  )

  it.effect('tries a failed read again before it can’t tell', () =>
    Effect.gen(function* () {
      const { checkout } = repository()
      const count = join(root, `count-${counter}`)
      const path = `${stubs(
        `#!/bin/sh\nn=$(cat '${count}' 2>/dev/null || echo 0)\necho $((n + 1)) > '${count}'\n` +
          `if [ "$n" -lt 2 ]; then echo "fatal: busy" >&2; exit 128; fi\nexec '${join(gitFolder, 'git')}' "$@"\n`,
      )}:${gitFolder}:/usr/bin:/bin`
      const status = yield* Effect.provide(
        Effect.gen(function* () {
          return yield* (yield* Git).status({ worktree: checkout })
        }),
        services(path),
      )
      expect(status).toEqual({ uncommitted: [], untracked: [] })
      expect(readFileSync(count, 'utf8').trim()).toBe('3')
    }),
  )

  it.effect('reads whether a branch is on Base, and the merge base', () =>
    Effect.gen(function* () {
      const service = yield* Git
      const { checkout, first } = repository()
      git(checkout, 'branch', 'merged')
      git(checkout, 'switch', '--quiet', '--create', 'ahead')
      const ahead = commit(checkout, 'ahead', { 'ahead.txt': 'x\n' })
      git(checkout, 'switch', '--quiet', 'main')
      const main = commit(checkout, 'main moves', { 'main.txt': 'y\n' })
      const repo = checkout
      expect(
        yield* service.isOnBase({ repo, branch: 'merged', base: 'main' }),
      ).toBe(true)
      expect(yield* service.isOnBase({ repo, branch: ahead, base: main })).toBe(
        false,
      )
      expect(
        yield* service.mergeBase({ repo, branch: 'ahead', base: 'main' }),
      ).toEqual(Option.some(first))
      git(checkout, 'switch', '--quiet', '--orphan', 'unrelated')
      commit(checkout, 'unrelated', { 'other.txt': 'z\n' })
      expect(
        yield* service.mergeBase({ repo, branch: 'unrelated', base: 'main' }),
      ).toEqual(Option.none())
      const error = yield* Effect.flip(
        service.isOnBase({ repo, branch: 'no-such-branch', base: 'main' }),
      )
      expect(error.read).toBe('isOnBase')
    }).pipe(Effect.provide(services())),
  )

  it.effect('reads a commit’s hash, none for a name that names none', () =>
    Effect.gen(function* () {
      const service = yield* Git
      const { checkout, first } = repository()
      // The engine's own GIT_DIR names another repository, which no command ever reads.
      expect(
        yield* service.commitHash({ repo: checkout, revision: 'main' }),
      ).toEqual(Option.some(first))
      expect(
        yield* service.commitHash({ repo: checkout, revision: 'missing' }),
      ).toEqual(Option.none())
      expect(yield* service.currentBranch({ repo: checkout })).toEqual(
        Option.some('main'),
      )
      git(checkout, 'switch', '--quiet', '--detach')
      expect(yield* service.currentBranch({ repo: checkout })).toEqual(
        Option.none(),
      )
      const error = yield* Effect.flip(
        service.commitHash({ repo: join(root, 'home'), revision: 'main' }),
      )
      expect(error.read).toBe('commitHash')
    }).pipe(Effect.provide(services())),
  )

  it.effect('reads the files a branch changed and the files tracked', () =>
    Effect.gen(function* () {
      const service = yield* Git
      const { checkout, first } = repository({ 'a.txt': 'a\n', 'c.txt': 'c\n' })
      git(checkout, 'switch', '--quiet', '--create', 'feature')
      commit(checkout, 'feature', { 'a.txt': 'changed\n', 'dir/b.txt': 'b\n' })
      git(checkout, 'switch', '--quiet', 'main')
      commit(checkout, 'base moves', { 'c.txt': 'moved\n' })
      const changed = yield* service.changedFiles({
        repo: checkout,
        branch: 'feature',
        base: 'main',
      })
      expect([...changed].sort()).toEqual(['a.txt', 'dir/b.txt'])
      expect(
        yield* service.trackedFiles({ repo: checkout, revision: 'feature' }),
      ).toEqual(['a.txt', 'c.txt', 'dir/b.txt'])
      expect(
        yield* service.trackedFiles({ repo: checkout, revision: first }),
      ).toEqual(['a.txt', 'c.txt'])
    }).pipe(Effect.provide(services())),
  )

  it.effect('reads git’s answers for a Base named like a folder', () =>
    Effect.gen(function* () {
      const service = yield* Git
      const { checkout } = repository({ 'src/main.ts': 'one\n' })
      git(checkout, 'switch', '--quiet', '--create', 'src')
      const base = commit(checkout, 'on src', { 'src/main.ts': 'two\n' })
      git(checkout, 'switch', '--quiet', '--create', 'fabrica/fa-a1b2')
      const tip = commit(checkout, 'ticket', { 'src/new.ts': 'new\n' })
      git(checkout, 'switch', '--quiet', 'src')
      const repo = checkout
      const branch = 'fabrica/fa-a1b2'
      expect(yield* service.commitHash({ repo, revision: 'src' })).toEqual(
        Option.some(base),
      )
      expect(yield* service.isOnBase({ repo, branch, base: 'src' })).toBe(false)
      expect(yield* service.mergeBase({ repo, branch, base: 'src' })).toEqual(
        Option.some(base),
      )
      expect(
        yield* service.changedFiles({ repo, branch, base: 'src' }),
      ).toEqual(['src/new.ts'])
      expect(yield* service.trackedFiles({ repo, revision: 'src' })).toEqual([
        'src/main.ts',
      ])
      expect(
        yield* service.fastForward({ checkout, base: 'src', to: tip }),
      ).toEqual(FastForwardOutcome.FastForwarded({ from: base, to: tip }))
      expect(yield* service.isOnBase({ repo, branch, base: 'src' })).toBe(true)
    }).pipe(Effect.provide(services())),
  )

  it('parses the formats git gives', () => {
    expect(parseStatus(' M a.txt\0M  b.txt\0D  c\0UU d\0?? e f\0')).toEqual(
      Option.some({
        uncommitted: ['a.txt', 'b.txt', 'c', 'd'],
        untracked: ['e f'],
      }),
    )
    expect(Option.isNone(parseStatus('garbage\0'))).toBe(true)
    const h = 'a'.repeat(40)
    expect(
      parseWorktrees(
        `worktree /r\0HEAD ${h}\0branch refs/heads/main\0\0worktree /w\0HEAD ${h}\0detached\0locked\0prunable gitdir file points to non-existent location\0\0`,
      ),
    ).toEqual(
      Option.some([
        {
          path: '/r',
          head: Option.some(h),
          branch: Option.some('main'),
          bare: false,
          locked: false,
          prunable: false,
        },
        {
          path: '/w',
          head: Option.some(h),
          branch: Option.none(),
          bare: false,
          locked: true,
          prunable: true,
        },
      ]),
    )
  })
})

/** A checkout on `main` and a ticket's worktree with one commit of its own, beside it. */
const withTicket = Effect.gen(function* () {
  const { checkout, first } = repository({ 'shared.txt': 'base\n' })
  const prepared = yield* (yield* Worktrees).prepare({
    home: besideCheckout(checkout),
    ticket,
    base: first,
  })
  const worktree = prepared.worktree.path
  const ticketCommit = commit(worktree, 'ticket', { 'ticket.txt': 'mine\n' })
  return { checkout, first, worktree, ticketCommit }
})

describe('Git.rebase', () => {
  it.effect(
    'rebases onto a commit, moving no other branch under rebase.updateRefs',
    () =>
      Effect.gen(function* () {
        const service = yield* Git
        const { checkout, worktree, ticketCommit } = yield* withTicket
        const second = commit(worktree, 'ticket two', { 'two.txt': '2\n' })
        git(checkout, 'config', 'rebase.updateRefs', 'true')
        git(checkout, 'branch', 'pointing-in', ticketCommit)
        const base = commit(checkout, 'base moves', { 'base.txt': 'b\n' })
        const outcome = yield* service.rebase({ worktree, onto: base })
        expect(outcome._tag).toBe('Rebased')
        if (outcome._tag !== 'Rebased') return
        expect(outcome.from).toBe(second)
        expect(outcome.head).toBe(hash(worktree, 'HEAD'))
        expect(hash(worktree, 'HEAD~2')).toBe(base)
        expect(hash(checkout, 'pointing-in')).toBe(ticketCommit)
        expect(yield* service.rebase({ worktree, onto: base })).toEqual(
          RebaseOutcome.Rebased({ from: outcome.head, head: outcome.head }),
        )
      }).pipe(Effect.provide(services())),
  )

  it.effect('gives a conflict as an outcome, and aborts it', () =>
    Effect.gen(function* () {
      const service = yield* Git
      const { checkout, worktree } = yield* withTicket
      const mine = commit(worktree, 'mine', { 'shared.txt': 'mine\n' })
      const base = commit(checkout, 'theirs', { 'shared.txt': 'theirs\n' })
      expect(yield* service.rebase({ worktree, onto: base })).toEqual(
        RebaseOutcome.Conflict({ files: ['shared.txt'] }),
      )
      expect(yield* service.rebase({ worktree, onto: base })).toEqual(
        RebaseOutcome.AlreadyRebasing(),
      )
      expect(yield* service.abortRebase({ worktree })).toEqual(
        AbortOutcome.Aborted(),
      )
      expect(hash(worktree, 'HEAD')).toBe(mine)
      expect(yield* service.abortRebase({ worktree })).toEqual(
        AbortOutcome.NotRebasing(),
      )
    }).pipe(Effect.provide(services())),
  )

  it.effect('gives git’s refusal of a rebase over uncommitted changes', () =>
    Effect.gen(function* () {
      const service = yield* Git
      const { checkout, worktree, ticketCommit } = yield* withTicket
      const base = commit(checkout, 'base moves', { 'base.txt': 'b\n' })
      writeFileSync(join(worktree, 'ticket.txt'), 'uncommitted\n')
      git(worktree, 'add', 'ticket.txt')
      const outcome = yield* service.rebase({ worktree, onto: base })
      expect(outcome._tag).toBe('Refused')
      expect(hash(worktree, 'HEAD')).toBe(ticketCommit)
    }).pipe(Effect.provide(services())),
  )
})

describe('Git.fastForward', () => {
  it.effect(
    'fast-forwards Base to the hash given, not to its branch’s head',
    () =>
      Effect.gen(function* () {
        const service = yield* Git
        const { checkout, first, worktree, ticketCommit } = yield* withTicket
        commit(worktree, 'made after the check', { 'later.txt': 'later\n' })
        expect(
          yield* service.fastForward({
            checkout,
            base: 'main',
            to: ticketCommit,
          }),
        ).toEqual(
          FastForwardOutcome.FastForwarded({ from: first, to: ticketCommit }),
        )
        expect(hash(checkout, 'main')).toBe(ticketCommit)
        expect(readFileSync(join(checkout, 'ticket.txt'), 'utf8')).toBe(
          'mine\n',
        )
        expect(existsSync(join(checkout, 'later.txt'))).toBe(false)
      }).pipe(Effect.provide(services())),
  )

  it.effect(
    'refuses a commit that doesn’t fast-forward, and a checkout off Base',
    () =>
      Effect.gen(function* () {
        const service = yield* Git
        const { checkout, worktree, ticketCommit } = yield* withTicket
        const moved = commit(checkout, 'base moves', { 'base.txt': 'b\n' })
        expect(
          yield* service.fastForward({
            checkout,
            base: 'main',
            to: ticketCommit,
          }),
        ).toEqual(FastForwardOutcome.NotFastForward({ base: moved }))
        expect(hash(checkout, 'main')).toBe(moved)
        git(checkout, 'switch', '--quiet', '--create', 'elsewhere')
        expect(
          yield* service.fastForward({ checkout, base: 'main', to: moved }),
        ).toEqual(
          FastForwardOutcome.OffBranch({ branch: Option.some('elsewhere') }),
        )
        git(checkout, 'switch', '--quiet', '--detach', 'main')
        expect(
          yield* service.fastForward({ checkout, base: 'main', to: moved }),
        ).toEqual(FastForwardOutcome.OffBranch({ branch: Option.none() }))
        git(checkout, 'switch', '--quiet', 'main')
        git(worktree, 'rebase', '--quiet', 'main')
        writeFileSync(join(checkout, 'ticket.txt'), 'in the way\n')
        const outcome = yield* service.fastForward({
          checkout,
          base: 'main',
          to: hash(worktree, 'HEAD'),
        })
        expect(outcome._tag).toBe('Refused')
        expect(hash(checkout, 'main')).toBe(moved)
      }).pipe(Effect.provide(services())),
  )
})

describe('Worktrees', () => {
  it.effect(
    'creates a ticket’s worktree beside the checkout, reuses it rebased, and removes it with its branch',
    () =>
      Effect.gen(function* () {
        const worktrees = yield* Worktrees
        const { checkout, first } = repository()
        const home = besideCheckout(checkout)
        const path = join(`${checkout}-worktrees`, ticket)
        const branch = ticketBranch(ticket)
        expect(branch).toBe('fabrica/fa-a1b2')
        expect(yield* worktrees.prepare({ home, ticket, base: first })).toEqual(
          Prepared.Created({ worktree: { ticket, path, branch } }),
        )
        expect(git(path, 'symbolic-ref', '--short', 'HEAD')).toBe(branch)
        expect(hash(path, 'HEAD')).toBe(first)
        const mine = commit(path, 'mine', { 'mine.txt': 'x\n' })
        expect(yield* worktrees.list({ home })).toEqual([
          { ticket, path, branch, head: Option.some(mine) },
        ])

        const base = commit(checkout, 'base moves', { 'base.txt': 'b\n' })
        const reused = yield* worktrees.prepare({ home, ticket, base })
        expect(reused._tag).toBe('Reused')
        if (reused._tag !== 'Reused') return
        expect(reused.worktree).toEqual({ ticket, path, branch })
        expect(reused.rebase._tag).toBe('Rebased')
        expect(hash(path, 'HEAD~1')).toBe(base)

        writeFileSync(join(path, 'untracked.txt'), 'left by a check\n')
        yield* worktrees.remove({ home, ticket })
        expect(existsSync(path)).toBe(false)
        expect(git(checkout, 'branch', '--list', branch)).toBe('')
        expect(yield* worktrees.list({ home })).toEqual([])
        yield* worktrees.remove({ home, ticket })
      }).pipe(Effect.provide(services())),
  )

  it.effect(
    'makes a worktree again for a branch whose folder is gone, in a given folder',
    () =>
      Effect.gen(function* () {
        const worktrees = yield* Worktrees
        const { checkout, first } = repository()
        const folder = join(root, `clone-worktrees-${counter}`)
        const home = inFolder({ checkout, folder })
        const path = join(folder, ticket)
        yield* worktrees.prepare({ home, ticket, base: first })
        const mine = commit(path, 'mine', { 'mine.txt': 'x\n' })
        rmSync(path, { recursive: true, force: true })
        const again = yield* worktrees.prepare({ home, ticket, base: first })
        expect(again).toEqual(
          Prepared.Reused({
            worktree: { ticket, path, branch: ticketBranch(ticket) },
            rebase: RebaseOutcome.Rebased({ from: mine, head: mine }),
          }),
        )
        expect(readFileSync(join(path, 'mine.txt'), 'utf8')).toBe('x\n')
      }).pipe(Effect.provide(services())),
  )
})
