import { Duration, Effect, Layer, Option } from 'effect'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from '@effect/vitest'

import {
  CHECK_ATTR_SOURCE_GIT,
  Git,
  type GitConfig,
  gitAtLeast,
  layer as gitLayer,
  parseCheckAttr,
} from '../src/git'
import {
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'

// `Git.unionMerged` against real git in temp folders (spec §13.4): the files tracked at a revision
// whose `merge` attribute is `union`, read from that revision's `.gitattributes` where git reads them
// from a tree, and from the checkout's where an older git can't. The engine's environment points git
// at another repository, which must never reach the commands.

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

/** Writes `files` in `cwd` and commits them as `message`. */
const commit = (
  cwd: string,
  message: string,
  files: Readonly<Record<string, string>>,
) => {
  write(cwd, files)
  git(cwd, 'add', '--all')
  git(cwd, 'commit', '--quiet', '--message', message)
}

/** A new repository on `main` with `files` in one commit. */
const repository = (
  files: Readonly<Record<string, string>> = { 'README.md': 'one\n' },
) => {
  counter += 1
  const checkout = join(root, `repo-${counter}`)
  mkdirSync(checkout)
  git(checkout, 'init', '--quiet', '--initial-branch=main')
  commit(checkout, 'one', files)
  return checkout
}

/** A folder with a `git` that says it is `version` and refuses `--source`, running the real git otherwise. */
const olderGit = (version: string): string => {
  counter += 1
  const folder = join(root, `older-${counter}`)
  mkdirSync(folder)
  writeFileSync(
    join(folder, 'git'),
    [
      '#!/bin/sh',
      `if [ "$2" = version ]; then echo "git version ${version}"; exit 0; fi`,
      'for arg in "$@"; do case "$arg" in --source*) echo "unknown option" >&2; exit 129;; esac; done',
      `exec "${join(gitFolder, 'git')}" "$@"`,
      '',
    ].join('\n'),
  )
  chmodSync(join(folder, 'git'), 0o755)
  return folder
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-union-')))
  home = join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
  elsewhere = repository({
    '.gitattributes': '* merge=union\n',
    'README.md': 'one\n',
  })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
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
  readRetries: { times: 1, spacing: Duration.zero },
}

/** The Git service, its git found on `path` (the real git's folder unless given). */
const services = (path = `${gitFolder}:/usr/bin:/bin`) =>
  Layer.provide(
    gitLayer(config),
    Layer.provide(runnerLayer(runnerConfig(path)), layerClock),
  )

const unionMerged = (input: {
  readonly repo: string
  readonly revision: string
}) =>
  Effect.gen(function* () {
    return yield* (yield* Git).unionMerged(input)
  })

const ATTRIBUTES =
  'CHANGELOG.md merge=union\n*.log merge=union\ndocs/*.md merge=binary\n'

describe('Git.unionMerged', () => {
  it.effect('gives the files the revision’s attributes merge by union', () =>
    Effect.gen(function* () {
      const repo = repository({ 'README.md': 'one\n', 'CHANGELOG.md': '' })
      commit(repo, 'attributes', {
        '.gitattributes': ATTRIBUTES,
        'logs/a.log': 'a\n',
        'docs/guide.md': 'guide\n',
        'docs/CHANGELOG.md': 'docs\n',
      })
      // The checkout's own attributes, uncommitted, aren't the revision's.
      write(repo, { '.gitattributes': 'README.md merge=union\n' })
      write(repo, { 'logs/b.log': 'untracked\n' })
      // `docs/CHANGELOG.md` is `binary`: git's later line wins.
      expect(yield* unionMerged({ repo, revision: 'main' })).toEqual([
        'CHANGELOG.md',
        'logs/a.log',
      ])
      expect(yield* unionMerged({ repo, revision: 'main~1' })).toEqual([])
    }).pipe(Effect.provide(services())),
  )

  it.effect('gives paths from the root when read from a folder below it', () =>
    Effect.gen(function* () {
      const repo = repository({
        '.gitattributes': ATTRIBUTES,
        'CHANGELOG.md': '',
        'logs/a.log': 'a\n',
      })
      expect(
        yield* unionMerged({ repo: join(repo, 'logs'), revision: 'HEAD' }),
      ).toEqual(['CHANGELOG.md', 'logs/a.log'])
    }).pipe(Effect.provide(services())),
  )

  it.effect('reads more files than one command’s arguments take', () =>
    Effect.gen(function* () {
      const name = (at: number) =>
        `notes/${String(at).padStart(4, '0')}-${'n'.repeat(240)}.log`
      const files = Object.fromEntries(
        Array.from({ length: 300 }, (_, at) => [name(at), `${at}\n`]),
      )
      const repo = repository({ '.gitattributes': ATTRIBUTES, ...files })
      const unioned = yield* unionMerged({ repo, revision: 'main' })
      expect(unioned).toHaveLength(300)
      expect(unioned.at(0)).toBe(name(0))
      expect(unioned.at(-1)).toBe(name(299))
    }).pipe(Effect.provide(services())),
  )

  it.effect('reads the checkout’s attributes with a git before 2.40', () =>
    Effect.gen(function* () {
      const repo = repository({
        '.gitattributes': ATTRIBUTES,
        'CHANGELOG.md': '',
        'README.md': 'one\n',
      })
      write(repo, { '.gitattributes': 'README.md merge=union\n' })
      expect(yield* unionMerged({ repo, revision: 'main' })).toEqual([
        'README.md',
      ])
    }).pipe(Effect.provide(services(`${olderGit('2.39.3')}:/usr/bin:/bin`))),
  )

  it.effect('is "can’t tell" for a revision that names nothing', () =>
    Effect.gen(function* () {
      const repo = repository()
      const read = yield* Effect.flip(
        unionMerged({ repo, revision: 'no-such-branch' }),
      )
      expect(read._tag).toBe('CantTell')
    }).pipe(Effect.provide(services())),
  )
})

describe('reading check-attr', () => {
  it('parses the values git gives', () => {
    expect(
      parseCheckAttr(
        'a b.md\0merge\0union\0c\0merge\0unspecified\0d\0merge\0\0',
        'merge',
      ),
    ).toEqual(
      Option.some([
        { path: 'a b.md', value: 'union' },
        { path: 'c', value: 'unspecified' },
        { path: 'd', value: '' },
      ]),
    )
    expect(parseCheckAttr('', 'merge')).toEqual(Option.some([]))
    expect(Option.isNone(parseCheckAttr('a\0merge\0union', 'merge'))).toBe(true)
    expect(Option.isNone(parseCheckAttr('a\0merge\0', 'merge'))).toBe(true)
    expect(Option.isNone(parseCheckAttr('a\0diff\0set\0', 'merge'))).toBe(true)
  })

  it('takes `--source` from git 2.40', () => {
    expect(gitAtLeast('2.40.0', CHECK_ATTR_SOURCE_GIT)).toBe(true)
    expect(gitAtLeast('2.54.0', CHECK_ATTR_SOURCE_GIT)).toBe(true)
    expect(gitAtLeast('3.0.0', CHECK_ATTR_SOURCE_GIT)).toBe(true)
    expect(gitAtLeast('2.39.3.windows.1', CHECK_ATTR_SOURCE_GIT)).toBe(false)
    expect(gitAtLeast('2.38.0', CHECK_ATTR_SOURCE_GIT)).toBe(false)
    expect(gitAtLeast('unknown', CHECK_ATTR_SOURCE_GIT)).toBe(false)
  })
})
