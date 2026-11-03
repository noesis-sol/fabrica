import { Effect, Option } from 'effect'
import { execFileSync } from 'node:child_process'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import { tempFolder } from '@fabrica/testkit'

import {
  ProjectRulesMaxBytes,
  ProjectRulesPath,
  readProjectRules,
} from '../src/rules'

// The project's own rules, read as a hostile file (spec §20.2, H62): the worktree is the agent's and
// `.fabrica/worker-rules.md` whatever a merged ticket committed, so a link, a named pipe or a device at
// its path is refused, never followed or waited on, and a file past the cap is refused whole.

const secret = 'BEGIN OPENSSH PRIVATE KEY'

/** A worktree with `.fabrica/` made, and a secret outside it a link could point at. */
const worktree = Effect.gen(function* () {
  const folder = yield* tempFolder('project-rules')
  const root = join(folder, 'worktree')
  yield* Effect.promise(async () => {
    await mkdir(join(root, '.fabrica'), { recursive: true })
    await writeFile(join(folder, 'id_ed25519'), `${secret}\n`)
  })
  return {
    root,
    rules: join(root, ProjectRulesPath),
    key: join(folder, 'id_ed25519'),
  }
})

/** Why the rules were refused, failing the test where they were read. */
const refusal = (root: string) =>
  readProjectRules(root).pipe(
    Effect.flip,
    Effect.map(error => {
      expect(error._tag).toBe('ProjectRulesUnreadable')
      expect(error.message).not.toContain(secret)
      return error.reason
    }),
  )

describe('readProjectRules', () => {
  it.effect('reads the regular file, and none where there is none', () =>
    Effect.gen(function* () {
      const { root, rules } = yield* worktree
      expect(yield* readProjectRules(root)).toEqual(Option.none())
      expect(yield* readProjectRules(join(root, 'nowhere'))).toEqual(
        Option.none(),
      )
      yield* Effect.promise(() => writeFile(rules, 'Run make lint.\n'))
      expect(yield* readProjectRules(root)).toEqual(
        Option.some('Run make lint.\n'),
      )
    }),
  )

  it.effect('refuses a link at its path, never reading what it points at', () =>
    Effect.gen(function* () {
      const { root, rules, key } = yield* worktree
      yield* Effect.promise(() => symlink(key, rules))
      expect(yield* refusal(root)).toBe('it is a symbolic link')
    }),
  )

  it.effect('refuses a link to a device', () =>
    Effect.gen(function* () {
      const { root, rules } = yield* worktree
      yield* Effect.promise(() => symlink('/dev/zero', rules))
      expect(yield* refusal(root)).toBe('it is a symbolic link')
    }),
  )

  it.effect('refuses .fabrica when it is a link to a folder', () =>
    Effect.gen(function* () {
      const { root } = yield* worktree
      const elsewhere = join(root, '..', 'elsewhere')
      const linked = join(root, '..', 'linked')
      yield* Effect.promise(async () => {
        await mkdir(elsewhere)
        await writeFile(join(elsewhere, 'worker-rules.md'), `${secret}\n`)
        await mkdir(linked)
        await symlink(elsewhere, join(linked, '.fabrica'))
      })
      expect(yield* refusal(linked)).toBe('.fabrica is not a folder')
    }),
  )

  it.effect('refuses a named pipe without waiting on it', () =>
    Effect.gen(function* () {
      const { root, rules } = yield* worktree
      yield* Effect.sync(() =>
        execFileSync('/usr/bin/mkfifo', [rules], { env: {} }),
      )
      expect(yield* refusal(root)).toBe('it is not a regular file')
    }),
  )

  it.effect('refuses a file past the cap whole', () =>
    Effect.gen(function* () {
      const { root, rules } = yield* worktree
      yield* Effect.promise(() =>
        writeFile(rules, 'a'.repeat(ProjectRulesMaxBytes)),
      )
      expect(
        Option.map(yield* readProjectRules(root), text => text.length),
      ).toEqual(Option.some(ProjectRulesMaxBytes))
      yield* Effect.promise(() =>
        writeFile(rules, 'a'.repeat(ProjectRulesMaxBytes + 1)),
      )
      expect(yield* refusal(root)).toBe(
        `it has ${ProjectRulesMaxBytes + 1} bytes, more than the ${ProjectRulesMaxBytes} allowed`,
      )
    }),
  )
})
