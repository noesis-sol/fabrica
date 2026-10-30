import { Option } from 'effect'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from '@effect/vitest'

import { type Git, workingTree } from './check-own'

// `workingTree` against real git, for a file edited in the second its index was written: git takes
// such an entry as racily clean, and checks its content, by the index file's own mtime, so the copy
// of the index must keep it (fab-adb: "passes kept by tree" named a tree without such an edit, now and
// then). The race is made, not waited on: the file and the index are given one fixed time, and ctime
// is left out of git's checks (`core.trustctime`), as a ctime can't be set.

const folders: Array<string> = []
afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true })
  }
})

describe('the working tree with a racily clean file', () => {
  it('holds a same-size edit made in the second the index was written', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'fabrica-check-own-racy-'))
    folders.push(cwd)
    const runner: Git = {
      command: '/usr/bin/git',
      cwd,
      env: {
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(cwd, '.gitconfig'),
        GIT_AUTHOR_NAME: 'Fabrica',
        GIT_AUTHOR_EMAIL: 'fabrica@example.com',
        GIT_COMMITTER_NAME: 'Fabrica',
        GIT_COMMITTER_EMAIL: 'fabrica@example.com',
      },
    }
    const git = (...args: Array<string>) =>
      execFileSync(runner.command, args, {
        cwd,
        env: runner.env,
        encoding: 'utf8',
      }).trim()
    git('init', '--quiet', '--initial-branch=main')
    git('config', 'core.trustctime', 'false')
    const file = join(cwd, 'a.ts')
    writeFileSync(file, 'export const a = 1\n')
    git('add', 'a.ts')
    git('commit', '--quiet', '-m', 'a')
    const head = git('rev-parse', 'HEAD^{tree}')

    // The index records a.ts at a fixed time, then is itself given that time, and the file is
    // edited to the same size and set back to it: only its content tells it changed.
    const second = new Date(1_700_000_000_000)
    utimesSync(file, second, second)
    git('update-index', '--refresh')
    utimesSync(
      resolve(cwd, git('rev-parse', '--git-path', 'index')),
      second,
      second,
    )
    writeFileSync(file, 'export const a = 2\n')
    utimesSync(file, second, second)

    const tree = Option.getOrThrow(workingTree(runner, join(cwd, '.git')))
    expect(tree).not.toBe(head)
    expect(git('show', `${tree}:a.ts`)).toBe('export const a = 2')
  })
})
