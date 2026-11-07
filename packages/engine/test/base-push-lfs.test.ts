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
import { dirname, join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from '@effect/vitest'

import { type GitConfig, layer as gitLayer } from '../src/git'
import {
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import { BasePushed, pushBase } from '../src/projects/base-sync'

// The engine uploads a Base's git-lfs objects itself (spec §10.3), since its git runs no `pre-push` hook. Real
// git in temp folders, with a stub git-lfs that says what it was asked and fails on request; where the host
// has git-lfs, as CI's runners do, a last test takes the real tool to a local remote.

const oid = 'a'.repeat(64)
const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 5\n`

let root = ''
let home = ''
let gitFolder = ''
let stubs = ''
let counter = 0

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

const freshFolder = (name: string): string => {
  counter += 1
  const folder = join(root, `${name}-${counter}`)
  mkdirSync(folder)
  return folder
}

const commitFile = (cwd: string, name: string, text: string): string => {
  writeFileSync(join(cwd, name), text)
  git(cwd, 'add', '--all')
  git(cwd, 'commit', '--quiet', '--message', name)
  return git(cwd, 'rev-parse', 'HEAD')
}

/** A checkout pushed to a bare remote, its `main` tracking it. */
const project = () => {
  const remote = freshFolder('remote')
  git(remote, 'init', '--quiet', '--bare', '--initial-branch=main')
  const checkout = freshFolder('checkout')
  git(checkout, 'init', '--quiet', '--initial-branch=main')
  const first = commitFile(checkout, 'one', 'one\n')
  git(checkout, 'remote', 'add', 'origin', remote)
  git(checkout, 'push', '--quiet', '--set-upstream', 'origin', 'main')
  return { remote, checkout, first }
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-lfs-')))
  home = join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
  stubs = join(root, 'stubs')
  mkdirSync(stubs)
  writeFileSync(
    join(stubs, 'git-lfs'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${root}/asked'\nif [ -e '${root}/fails' ]; then echo 'no route to the store' >&2; exit 2; fi\n`,
  )
  chmodSync(join(stubs, 'git-lfs'), 0o755)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const runnerConfig = (path: () => string): RunnerConfig => ({
  hostEnvironment: { PATH: path(), HOME: home, LANG: 'C' },
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

const services = (path: () => string) =>
  Layer.suspend(() =>
    Layer.provide(
      gitLayer(config),
      Layer.provide(runnerLayer(runnerConfig(path)), layerClock),
    ),
  )

const withStub = services(() => `${stubs}:${gitFolder}:/usr/bin:/bin`)
const withoutLfs = services(() => `${gitFolder}:/usr/bin:/bin`)

const asked = (): ReadonlyArray<string> =>
  existsSync(join(root, 'asked'))
    ? readFileSync(join(root, 'asked'), 'utf8').trim().split('\n')
    : []

/** Starts a test's count of what the stub was asked over, and its failing off. */
const forgetStub = () => {
  rmSync(join(root, 'asked'), { force: true })
  rmSync(join(root, 'fails'), { force: true })
}

const reasonOf = (pushed: BasePushed): string =>
  BasePushed.$is('NotPushed')(pushed) ? pushed.reason : pushed._tag

describe('pushing a Base with git-lfs files', () => {
  it.effect('uploads their objects, then pushes the ref', () =>
    Effect.gen(function* () {
      forgetStub()
      const { remote, checkout } = project()
      const head = commitFile(checkout, 'image.bin', pointer)
      const pushed = yield* pushBase({ checkout, base: 'main' })
      expect(pushed._tag).toBe('Pushed')
      expect(asked()).toEqual([`push -- origin ${head}`])
      expect(git(remote, 'rev-parse', 'main')).toBe(head)
    }).pipe(Effect.provide(withStub)),
  )

  it.effect('leaves the ref where it was when the upload fails', () =>
    Effect.gen(function* () {
      forgetStub()
      writeFileSync(join(root, 'fails'), '')
      const { remote, checkout, first } = project()
      commitFile(checkout, 'image.bin', pointer)
      const pushed = yield* pushBase({ checkout, base: 'main' })
      expect(pushed._tag).toBe('NotPushed')
      expect(reasonOf(pushed)).toContain('no route to the store')
      expect(git(remote, 'rev-parse', 'main')).toBe(first)
    }).pipe(Effect.provide(withStub)),
  )

  it.effect('says so when the host has no git-lfs', () =>
    Effect.gen(function* () {
      const { remote, checkout, first } = project()
      commitFile(checkout, 'image.bin', pointer)
      const pushed = yield* pushBase({ checkout, base: 'main' })
      expect(reasonOf(pushed)).toContain("git-lfs isn't installed")
      expect(git(remote, 'rev-parse', 'main')).toBe(first)
    }).pipe(Effect.provide(withoutLfs)),
  )

  it.effect('sees a pointer only earlier in the pushed range', () =>
    Effect.gen(function* () {
      forgetStub()
      const { checkout } = project()
      commitFile(checkout, 'image.bin', pointer)
      git(checkout, 'rm', '--quiet', 'image.bin')
      git(checkout, 'commit', '--quiet', '--message', 'gone')
      const head = git(checkout, 'rev-parse', 'HEAD')
      const pushed = yield* pushBase({ checkout, base: 'main' })
      expect(pushed._tag).toBe('Pushed')
      expect(asked()).toEqual([`push -- origin ${head}`])
    }).pipe(Effect.provide(withStub)),
  )

  it.effect('reads only the range: older pointers are on the remote', () =>
    Effect.gen(function* () {
      forgetStub()
      const { checkout } = project()
      commitFile(checkout, 'image.bin', pointer)
      git(checkout, 'push', '--quiet')
      commitFile(checkout, 'plain', 'plain\n')
      const pushed = yield* pushBase({ checkout, base: 'main' })
      expect(pushed._tag).toBe('Pushed')
      expect(asked()).toEqual([])
    }).pipe(Effect.provide(withStub)),
  )

  it.effect('calls a Base already at its upstream up to date', () =>
    Effect.gen(function* () {
      const { checkout } = project()
      commitFile(checkout, 'image.bin', pointer)
      git(checkout, 'push', '--quiet')
      // No git-lfs here: nothing needs one.
      const pushed = yield* pushBase({ checkout, base: 'main' })
      expect(pushed._tag).toBe('UpToDate')
    }).pipe(Effect.provide(withoutLfs)),
  )

  it.effect(
    'pushes with no git-lfs a Base whose attributes name it unused',
    () =>
      Effect.gen(function* () {
        const { remote, checkout } = project()
        const head = commitFile(
          checkout,
          '.gitattributes',
          '*.bin filter=lfs diff=lfs merge=lfs -text\n',
        )
        const pushed = yield* pushBase({ checkout, base: 'main' })
        expect(pushed._tag).toBe('Pushed')
        expect(git(remote, 'rev-parse', 'main')).toBe(head)
      }).pipe(Effect.provide(withoutLfs)),
  )

  it.effect(
    'refuses a transfer command the repository’s own configuration names',
    () =>
      Effect.gen(function* () {
        forgetStub()
        const { remote, checkout, first } = project()
        commitFile(checkout, 'image.bin', pointer)
        git(
          checkout,
          'config',
          'lfs.customtransfer.mine.path',
          '/planted/agent',
        )
        const pushed = yield* pushBase({ checkout, base: 'main' })
        expect(reasonOf(pushed)).toContain('lfs.customtransfer.mine.path')
        expect(asked()).toEqual([])
        expect(git(remote, 'rev-parse', 'main')).toBe(first)
      }).pipe(Effect.provide(withStub)),
  )

  it.effect('refuses one a worktree’s configuration names', () =>
    Effect.gen(function* () {
      forgetStub()
      const { checkout } = project()
      commitFile(checkout, 'image.bin', pointer)
      git(checkout, 'config', 'extensions.worktreeConfig', 'true')
      git(
        checkout,
        'config',
        '--worktree',
        'lfs.standalonetransferagent',
        'mine',
      )
      const pushed = yield* pushBase({ checkout, base: 'main' })
      expect(reasonOf(pushed)).toContain('lfs.standalonetransferagent')
      expect(asked()).toEqual([])
    }).pipe(Effect.provide(withStub)),
  )

  it.effect('runs no diff driver’s command reading the range', () =>
    Effect.gen(function* () {
      forgetStub()
      const { checkout } = project()
      const mark = join(freshFolder('mark'), 'ran')
      git(checkout, 'config', 'diff.planted.textconv', `touch '${mark}'; cat`)
      commitFile(checkout, '.gitattributes', '*.txt diff=planted\n')
      commitFile(checkout, 'note.txt', 'note\n')
      const pushed = yield* pushBase({ checkout, base: 'main' })
      expect(pushed._tag).toBe('Pushed')
      expect(existsSync(mark)).toBe(false)
    }).pipe(Effect.provide(withStub)),
  )

  // The real tool, where the host has it.
  const realLfs = ((): string | undefined => {
    try {
      return dirname(
        execFileSync('which', ['git-lfs'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
      )
    } catch {
      return undefined
    }
  })()

  it.effect.runIf(realLfs !== undefined)(
    'uploads through the real git-lfs to a local remote',
    () =>
      Effect.gen(function* () {
        const lfsPath = `${realLfs ?? ''}:${gitFolder}:/usr/bin:/bin`
        const fixture = (cwd: string, ...args: ReadonlyArray<string>) =>
          execFileSync('git', args, {
            cwd,
            env: {
              PATH: lfsPath,
              HOME: home,
              LC_ALL: 'C',
              GIT_CONFIG_NOSYSTEM: '1',
            },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }).trim()
        const { remote, checkout } = project()
        fixture(checkout, 'lfs', 'install', '--local')
        fixture(checkout, 'lfs', 'track', '*.bin')
        writeFileSync(
          join(checkout, 'image.bin'),
          'not a pointer in the tree\n',
        )
        fixture(checkout, 'add', '--all')
        fixture(checkout, 'commit', '--quiet', '--message', 'image')
        const head = fixture(checkout, 'rev-parse', 'HEAD')
        const held = fixture(checkout, 'cat-file', '-p', 'HEAD:image.bin')
        expect(held).toContain('git-lfs.github.com/spec/v1')
        const stored = /oid sha256:([0-9a-f]{64})/u.exec(held)?.[1] ?? ''
        const object = join(
          remote,
          'lfs',
          'objects',
          stored.slice(0, 2),
          stored.slice(2, 4),
          stored,
        )
        expect(existsSync(object)).toBe(false)
        const pushed = yield* pushBase({ checkout, base: 'main' }).pipe(
          Effect.provide(services(() => lfsPath)),
        )
        expect(pushed._tag).toBe('Pushed')
        expect(existsSync(object)).toBe(true)
        expect(git(remote, 'rev-parse', 'main')).toBe(head)
      }),
  )
})
