import { Duration, Effect, Layer, Option, Ref } from 'effect'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { CommitHash, type Push } from '@fabrica/contracts'

import {
  type GitConfig,
  PushOutcome,
  layer as gitLayer,
  parsePushed,
  parseUpstream,
} from '../src/git'
import {
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import {
  type BaseNote,
  BasePushed,
  BaseSynced,
  basePushes,
  pushBase,
  pushSetting,
  syncBase,
  syncedNote,
} from '../src/projects/base-sync'
import {
  type Project,
  file,
  ofKind,
  project,
  commit as runCommit,
  git as runGit,
  runOf,
  setUpRuns,
  settings,
} from './run-harness'

// Base, fetching and pushing (spec §10.3, H10), against real git with a bare remote: before a run,
// Base is fetched and fast-forwarded where its upstream moved and it has no commits of its own, and
// left as it is where they diverged (`BASE_DIVERGED`); Base is pushed as `push` says, never forced, a
// push that isn't a fast-forward not made and said (`PUSH_REFUSED`). The run's start syncs Base, and
// its merge queue pushes after each merge where `push` is `after_merge`.

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

const hash = (cwd: string, revision: string): CommitHash =>
  CommitHash.make(git(cwd, 'rev-parse', '--verify', `${revision}^{commit}`))

/** Writes a file named after `message` in `cwd` and commits it, returning the commit. */
const commit = (cwd: string, message: string): CommitHash => {
  writeFileSync(join(cwd, `${message}.txt`), `${message}\n`)
  git(cwd, 'add', '--all')
  git(cwd, 'commit', '--quiet', '--message', message)
  return hash(cwd, 'HEAD')
}

/** A bare remote, a checkout on `main` tracking its `main`, and another clone that moves the remote on. */
const remoteAndClones = () => {
  counter += 1
  const folder = join(root, `f${counter}`)
  mkdirSync(folder)
  const remote = join(folder, 'remote.git')
  const checkout = join(folder, 'repo')
  const other = join(folder, 'other')
  git(folder, 'init', '--quiet', '--bare', '--initial-branch=main', remote)
  git(folder, 'init', '--quiet', '--initial-branch=main', checkout)
  const first = commit(checkout, 'one')
  git(checkout, 'remote', 'add', 'origin', remote)
  git(checkout, 'push', '--quiet', '--set-upstream', 'origin', 'main')
  git(folder, 'clone', '--quiet', remote, other)
  return { folder, remote, checkout, other, first }
}

/** Commits `message` in the other clone and pushes it: the upstream moves on. */
const moveUpstream = (other: string, message: string): CommitHash => {
  const made = commit(other, message)
  git(other, 'push', '--quiet', 'origin', 'main')
  return made
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-base-sync-')))
  home = join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n[init]\n\tdefaultBranch = main\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
  setUpRuns()
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
  readRetries: { times: 2, spacing: Duration.zero },
}

const services = () =>
  Layer.provide(
    gitLayer(config),
    Layer.provide(runnerLayer(runnerConfig()), layerClock),
  )

describe('syncBase', () => {
  it.effect(
    'fast-forwards Base when its upstream moved and Base has no commits of its own',
    () =>
      Effect.gen(function* () {
        const { checkout, other, first } = remoteAndClones()
        const theirs = moveUpstream(other, 'two')
        const synced = yield* syncBase({ checkout, base: 'main' })
        expect(synced).toEqual(
          BaseSynced.FastForwarded({
            upstream: 'origin/main',
            from: first,
            to: theirs,
          }),
        )
        expect(hash(checkout, 'main')).toBe(theirs)
        // The checkout's files are the upstream's too.
        expect(git(checkout, 'status', '--porcelain')).toBe('')
        expect(git(checkout, 'ls-files')).toContain('two.txt')
        expect(syncedNote(synced, 'main')).toEqual(
          Option.some({
            _tag: 'Progress',
            text: `start: main fast-forwarded to origin/main, ${first.slice(0, 7)}..${theirs.slice(0, 7)}`,
          }),
        )
      }).pipe(Effect.provide(services())),
  )

  it.effect(
    'leaves Base as it is and says BASE_DIVERGED where Base and its upstream diverged',
    () =>
      Effect.gen(function* () {
        const { checkout, other } = remoteAndClones()
        const theirs = moveUpstream(other, 'theirs')
        const ours = commit(checkout, 'ours')
        const synced = yield* syncBase({ checkout, base: 'main' })
        expect(synced).toEqual(
          BaseSynced.Diverged({ upstream: 'origin/main', base: ours, theirs }),
        )
        expect(hash(checkout, 'main')).toBe(ours)
        const note = syncedNote(synced, 'main')
        expect(Option.map(note, ({ _tag }) => _tag)).toEqual(
          Option.some('Warning'),
        )
        expect(note).toEqual(
          Option.some({
            _tag: 'Warning',
            tag: 'BASE_DIVERGED',
            text: `main (${ours.slice(0, 7)}) and origin/main (${theirs.slice(0, 7)}) have diverged: the run starts on main as it is`,
          }),
        )
      }).pipe(Effect.provide(services())),
  )

  it.effect(
    'leaves Base with commits of its own where the upstream hasn’t moved',
    () =>
      Effect.gen(function* () {
        const { checkout } = remoteAndClones()
        const ours = commit(checkout, 'ours')
        expect(yield* syncBase({ checkout, base: 'main' })).toEqual(
          BaseSynced.Ahead({ upstream: 'origin/main', commit: ours }),
        )
        expect(hash(checkout, 'main')).toBe(ours)
      }).pipe(Effect.provide(services())),
  )

  it.effect('says Base is up to date where the upstream is at Base', () =>
    Effect.gen(function* () {
      const { checkout, first } = remoteAndClones()
      expect(yield* syncBase({ checkout, base: 'main' })).toEqual(
        BaseSynced.UpToDate({ upstream: 'origin/main', commit: first }),
      )
    }).pipe(Effect.provide(services())),
  )

  it.effect('fetches nothing and says nothing where Base has no upstream', () =>
    Effect.gen(function* () {
      const { checkout, first } = remoteAndClones()
      git(checkout, 'branch', '--unset-upstream')
      const synced = yield* syncBase({ checkout, base: 'main' })
      expect(synced).toEqual(BaseSynced.NoUpstream())
      expect(syncedNote(synced, 'main')).toEqual(Option.none())
      expect(hash(checkout, 'main')).toBe(first)
    }).pipe(Effect.provide(services())),
  )

  it.effect(
    'starts on Base as it is where the upstream can’t be fetched, saying why',
    () =>
      Effect.gen(function* () {
        const { checkout, remote, first } = remoteAndClones()
        renameSync(remote, `${remote}-gone`)
        const synced = yield* syncBase({ checkout, base: 'main' })
        expect(synced._tag).toBe('NotSynced')
        expect(hash(checkout, 'main')).toBe(first)
        const note = syncedNote(synced, 'main')
        expect(
          Option.map(note, given =>
            given._tag === 'Warning' ? given.tag : given._tag,
          ),
        ).toEqual(Option.some('BASE_NOT_SYNCED'))
        expect(
          Option.map(note, ({ text }) => text.startsWith('origin/main')),
        ).toEqual(Option.some(true))
      }).pipe(Effect.provide(services())),
  )
})

/** The pushes `push` makes, their notes kept. */
const pushesOf = (checkout: string, push: Push) =>
  Effect.gen(function* () {
    const said = yield* Ref.make<ReadonlyArray<BaseNote>>([])
    const pushes = yield* basePushes({
      checkout,
      base: 'main',
      push,
      say: note => Ref.update(said, notes => [...notes, note]),
    })
    return { pushes, said: Ref.get(said) }
  })

describe('pushing Base', () => {
  it.effect.each<{
    readonly push: Push
    readonly pushedAt: ReadonlyArray<'after_run' | 'after_merge'>
  }>([
    { push: 'never', pushedAt: [] },
    { push: 'after_run', pushedAt: ['after_run'] },
    { push: 'after_merge', pushedAt: ['after_merge'] },
  ])('push: $push pushes Base at $pushedAt only', ({ push, pushedAt }) =>
    Effect.gen(function* () {
      const { checkout, remote, first } = remoteAndClones()
      const { pushes, said } = yield* pushesOf(checkout, push)
      const remoteAt = { after_merge: first, after_run: first }
      const merged = commit(checkout, 'merged')
      yield* pushes.after_merge
      remoteAt.after_merge = hash(remote, 'main')
      const ended = commit(checkout, 'ended')
      yield* pushes.after_run
      remoteAt.after_run = hash(remote, 'main')
      expect(remoteAt).toEqual({
        after_merge: pushedAt.includes('after_merge') ? merged : first,
        after_run: pushedAt.includes('after_run')
          ? ended
          : pushedAt.includes('after_merge')
            ? merged
            : first,
      })
      const notes = yield* said
      expect(notes).toEqual(
        pushedAt.map(moment => ({
          _tag: 'Progress',
          text: `pushed main to origin/main at ${(moment === 'after_merge' ? merged : ended).slice(0, 7)}`,
        })),
      )
      // The ref that keeps the upstream here follows the push.
      if (pushedAt.length > 0)
        expect(hash(checkout, 'origin/main')).toBe(hash(remote, 'main'))
    }).pipe(Effect.provide(services())),
  )

  it.effect(
    'makes no push that isn’t a fast-forward, and says PUSH_REFUSED',
    () =>
      Effect.gen(function* () {
        const { checkout, remote, other } = remoteAndClones()
        const theirs = moveUpstream(other, 'theirs')
        const ours = commit(checkout, 'ours')
        // Base has the upstream's old commit in view, so git refuses it here as not a fast-forward.
        expect(yield* pushBase({ checkout, base: 'main' })).toEqual(
          BasePushed.Refused({
            upstream: 'origin/main',
            commit: ours,
            reason: 'not a fast-forward (fetch first)',
          }),
        )
        expect(hash(remote, 'main')).toBe(theirs)
        // Fetched, the push is still not a fast-forward, and still not forced.
        git(checkout, 'fetch', '--quiet', 'origin')
        const { pushes, said } = yield* pushesOf(checkout, 'after_merge')
        yield* pushes.after_merge
        expect(hash(remote, 'main')).toBe(theirs)
        expect(yield* said).toEqual([
          {
            _tag: 'Warning',
            tag: 'PUSH_REFUSED',
            text: `main (${ours.slice(0, 7)}) wasn't pushed to origin/main: not a fast-forward (non-fast-forward); the engine never forces`,
          },
        ])
      }).pipe(Effect.provide(services())),
  )

  it.effect('says PUSH_REFUSED where the remote refuses the push', () =>
    Effect.gen(function* () {
      const { checkout, remote, first } = remoteAndClones()
      const hook = join(remote, 'hooks', 'pre-receive')
      writeFileSync(hook, '#!/bin/sh\necho protected >&2\nexit 1\n')
      chmodSync(hook, 0o755)
      const ours = commit(checkout, 'ours')
      expect(yield* pushBase({ checkout, base: 'main' })).toEqual(
        BasePushed.Refused({
          upstream: 'origin/main',
          commit: ours,
          reason: 'the remote refused it (pre-receive hook declined)',
        }),
      )
      expect(hash(remote, 'main')).toBe(first)
    }).pipe(Effect.provide(services())),
  )

  it.effect('says the remote has Base already where it has', () =>
    Effect.gen(function* () {
      const { checkout, first } = remoteAndClones()
      expect(yield* pushBase({ checkout, base: 'main' })).toEqual(
        BasePushed.UpToDate({ upstream: 'origin/main', commit: first }),
      )
    }).pipe(Effect.provide(services())),
  )

  it.effect('pushes nothing where Base has no upstream, saying so', () =>
    Effect.gen(function* () {
      const { checkout, remote, first } = remoteAndClones()
      git(checkout, 'branch', '--unset-upstream')
      commit(checkout, 'ours')
      expect(yield* pushBase({ checkout, base: 'main' })).toEqual(
        BasePushed.NoUpstream(),
      )
      expect(hash(remote, 'main')).toBe(first)
    }).pipe(Effect.provide(services())),
  )

  it('takes the origin’s default where the settings give no push', () => {
    expect(pushSetting(Option.none(), 'registered')).toBe('never')
    expect(pushSetting(Option.none(), 'cloned')).toBe('after_run')
    expect(pushSetting(Option.some('after_merge'), 'registered')).toBe(
      'after_merge',
    )
  })
})

describe('reading git’s answers', () => {
  it('reads a branch’s upstream from for-each-ref', () => {
    const line = (...fields: ReadonlyArray<string>) => `${fields.join('\0')}\n`
    expect(
      parseUpstream(
        line(
          'refs/heads/main',
          'refs/remotes/origin/main',
          'origin',
          'refs/heads/main',
        ),
        'main',
      ),
    ).toEqual(
      Option.some(
        Option.some({
          remote: 'origin',
          ref: 'refs/heads/main',
          tracking: 'refs/remotes/origin/main',
        }),
      ),
    )
    // A branch below it isn't it; one with no upstream has none.
    expect(
      parseUpstream(
        line('refs/heads/main/x', 'refs/remotes/origin/x', 'origin', 'x') +
          line('refs/heads/main', '', '', ''),
        'main',
      ),
    ).toEqual(Option.some(Option.none()))
    expect(parseUpstream('', 'main')).toEqual(Option.some(Option.none()))
    expect(parseUpstream('refs/heads/main\n', 'main')).toEqual(Option.none())
  })

  it('reads how push --porcelain updated the ref', () => {
    const out = (flag: string, summary: string) =>
      `To /remote.git\n${flag}\tabc:refs/heads/main\t${summary}\nDone\n`
    expect(parsePushed(out(' ', 'a..b'), 'refs/heads/main')).toEqual(
      Option.some(PushOutcome.Pushed()),
    )
    expect(parsePushed(out('*', '[new branch]'), 'refs/heads/main')).toEqual(
      Option.some(PushOutcome.Pushed()),
    )
    expect(parsePushed(out('=', '[up to date]'), 'refs/heads/main')).toEqual(
      Option.some(PushOutcome.UpToDate()),
    )
    expect(
      parsePushed(out('!', '[rejected] (non-fast-forward)'), 'refs/heads/main'),
    ).toEqual(
      Option.some(PushOutcome.NotFastForward({ reason: 'non-fast-forward' })),
    )
    expect(
      parsePushed(
        out('!', '[remote rejected] (protected branch)'),
        'refs/heads/main',
      ),
    ).toEqual(Option.some(PushOutcome.Rejected({ reason: 'protected branch' })))
    expect(parsePushed(out(' ', 'a..b'), 'refs/heads/other')).toEqual(
      Option.none(),
    )
    expect(parsePushed('', 'refs/heads/main')).toEqual(Option.none())
  })
})

/** A bare remote for the run's project, its checkout's `main` tracking it, and a clone that moves it on. */
const remoteFor = (fixture: Project) => {
  const remote = join(fixture.checkout, '..', 'remote.git')
  const other = join(fixture.checkout, '..', 'other')
  runGit(fixture.checkout, 'init', '--quiet', '--bare', remote)
  runGit(fixture.checkout, 'remote', 'add', 'origin', remote)
  runGit(
    fixture.checkout,
    'push',
    '--quiet',
    '--set-upstream',
    'origin',
    'main',
  )
  runGit(fixture.checkout, 'clone', '--quiet', remote, other)
  return { remote, other }
}

const headOf = (cwd: string, revision: string) =>
  runGit(cwd, 'rev-parse', '--verify', `${revision}^{commit}`)

describe('a run', () => {
  it.effect(
    'fast-forwards Base to its upstream as it starts, and starts there',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const { other } = remoteFor(fixture)
        runCommit(other, 'theirs', { 'theirs.txt': 'theirs\n' })
        runGit(other, 'push', '--quiet', 'origin', 'main')
        const theirs = headOf(other, 'HEAD')
        const { events } = yield* runOf(fixture, Effect.void)
        expect(headOf(fixture.checkout, 'main')).toBe(theirs)
        expect(ofKind(events, 'start').map(({ commit }) => commit)).toEqual([
          theirs,
        ])
        expect(
          ofKind(events, 'info').some(({ text }) =>
            text.startsWith('start: main fast-forwarded to origin/main'),
          ),
        ).toBe(true)
      }),
  )

  it.effect(
    'starts on Base as it is where it diverged from its upstream, saying BASE_DIVERGED',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const { other } = remoteFor(fixture)
        runCommit(other, 'theirs', { 'theirs.txt': 'theirs\n' })
        runGit(other, 'push', '--quiet', 'origin', 'main')
        runCommit(fixture.checkout, 'ours', { 'ours.txt': 'ours\n' })
        const ours = headOf(fixture.checkout, 'main')
        const { events } = yield* runOf(fixture, Effect.void)
        expect(headOf(fixture.checkout, 'main')).toBe(ours)
        expect(ofKind(events, 'start').map(({ commit }) => commit)).toEqual([
          ours,
        ])
        expect(
          ofKind(events, 'warn')
            .filter(({ detail }) => detail === 'BASE_DIVERGED')
            .map(({ text }) => text.startsWith('BASE_DIVERGED: main (')),
        ).toEqual([true])
      }),
  )

  it.effect('pushes Base after each merge where push is after_merge', () =>
    Effect.gen(function* () {
      const fixture = project({ ...settings, push: 'after_merge' })
      const { remote } = remoteFor(fixture)
      const { events } = yield* runOf(fixture, file('Add one', 'finish'))
      const merged = headOf(fixture.checkout, 'main')
      expect(ofKind(events, 'closed').length).toBe(1)
      expect(headOf(remote, 'main')).toBe(merged)
      expect(
        ofKind(events, 'info').some(
          ({ text }) =>
            text === `pushed main to origin/main at ${merged.slice(0, 7)}`,
        ),
      ).toBe(true)
    }),
  )

  it.effect('reads its settings from Base as the fast-forward left it', () =>
    Effect.gen(function* () {
      // The checkout says nothing of push (never, for a registered checkout); the upstream's commit
      // says after_merge, and the run, starting on it, pushes after its merge.
      const fixture = project()
      const { remote, other } = remoteFor(fixture)
      runCommit(other, 'push after each merge', {
        '.fabrica/settings.json': `${JSON.stringify({ ...settings, push: 'after_merge' }, null, 2)}\n`,
      })
      runGit(other, 'push', '--quiet', 'origin', 'main')
      const theirs = headOf(other, 'HEAD')
      const { events } = yield* runOf(fixture, file('Add one', 'finish'))
      expect(ofKind(events, 'start').map(({ commit }) => commit)).toEqual([
        theirs,
      ])
      expect(ofKind(events, 'closed').length).toBe(1)
      const merged = headOf(fixture.checkout, 'main')
      expect(merged).not.toBe(theirs)
      expect(headOf(remote, 'main')).toBe(merged)
    }),
  )

  it.effect('pushes nothing after a merge where push is never', () =>
    Effect.gen(function* () {
      const fixture = project({ ...settings, push: 'never' })
      const { remote } = remoteFor(fixture)
      const before = headOf(remote, 'main')
      const { events } = yield* runOf(fixture, file('Add one', 'finish'))
      expect(ofKind(events, 'closed').length).toBe(1)
      expect(headOf(fixture.checkout, 'main')).not.toBe(before)
      expect(headOf(remote, 'main')).toBe(before)
    }),
  )
})
