import { Effect } from 'effect'
import { join } from 'node:path'

import { describe, expect, layer } from '@effect/vitest'

import {
  Toolbox,
  makeGitRepo,
  layerToolbox,
  runCommandExit,
} from '../packages/testkit/src/index.ts'

// The gate CI leaves a release commit pushed alone to (spec §22.5): its subject, and that it changes
// only the changelog, the change files it gathered and the version; never a skip marker.

const script = join(import.meta.dirname, 'release-commit.sh')

const manifest = (version: string, extra = '') =>
  `{\n  "name": "fabrica",\n  "version": "${version}",${extra}\n  "private": true\n}\n`

/** A repository whose main holds a changelog, two change files and the manifests at 0.0.0. */
const repository = Effect.gen(function* () {
  const repo = yield* makeGitRepo(yield* Toolbox)
  yield* repo.commit({
    files: {
      'CHANGELOG.md': '# Changelog\n',
      'changes/fab-mgi.1.md': '- One.\n',
      'changes/fab-mgi.2.md': '- Two.\n',
      'package.json': manifest('0.0.0'),
      'apps/engine/package.json': manifest('0.0.0'),
      'src/a.ts': 'export const a = 1\n',
    },
    message: 'The project',
  })
  const before = yield* repo.git(['rev-parse', 'HEAD'])
  /** Removes the change files from the index and the checkout, as --gather does. */
  const gatherChanges = repo.git([
    'rm',
    '--quiet',
    'changes/fab-mgi.1.md',
    'changes/fab-mgi.2.md',
  ])
  const gate = (on: string) =>
    runCommandExit({
      command: 'sh',
      args: [script, on],
      cwd: repo.work,
      env: repo.env,
    })
  return { repo, before, gatherChanges, gate }
})

/** The release commit's own changes: the changelog's section and the versions. */
const releaseFiles = (version: string) => ({
  'CHANGELOG.md': `# Changelog\n\n## [${version}] - 2026-11-04\n\n- One.\n- Two.\n`,
  'package.json': manifest(version),
  'apps/engine/package.json': manifest(version),
})

layer(layerToolbox({ tools: ['git', 'sh', 'sed', 'grep'] }))(
  'a release commit pushed alone',
  it => {
    it.effect(
      'is one with its subject, the changelog, the change files and the version',
      () =>
        Effect.gen(function* () {
          const { repo, before, gatherChanges, gate } = yield* repository
          yield* gatherChanges
          yield* repo.commit({
            files: releaseFiles('0.1.0'),
            message: 'Release 0.1.0',
          })
          expect(yield* gate(before)).toEqual({
            code: 0,
            stdout: 'a release commit pushed alone: 0.1.0\n',
            stderr: '',
          })
        }),
    )

    it.effect("is a pre-release's too", () =>
      Effect.gen(function* () {
        const { repo, before, gate } = yield* repository
        yield* repo.commit({
          files: releaseFiles('0.1.0-rc.1'),
          message: 'Release 0.1.0-rc.1\n\nThe first pre-release.',
        })
        expect((yield* gate(before)).code).toBe(0)
      }),
    )

    describe('is not', () => {
      it.effect('a commit with another subject', () =>
        Effect.gen(function* () {
          const { repo, before, gate } = yield* repository
          yield* repo.commit({
            files: releaseFiles('0.1.0'),
            message: 'Release v0.1.0',
          })
          expect(yield* gate(before)).toEqual({
            code: 1,
            stdout:
              "not a release commit pushed alone: its subject is 'Release v0.1.0', not 'Release X.Y.Z'\n",
            stderr: '',
          })
        }),
      )

      it.effect('one pushed with the commits under it', () =>
        Effect.gen(function* () {
          const { repo, before, gate } = yield* repository
          yield* repo.commit({
            files: { 'src/a.ts': 'export const a = 2\n' },
            message: 'Work',
          })
          yield* repo.commit({
            files: releaseFiles('0.1.0'),
            message: 'Release 0.1.0',
          })
          const ran = yield* gate(before)
          expect(ran.code).toBe(1)
          expect(ran.stdout).toContain('so it holds more than this commit')
        }),
      )

      it.effect(
        'one changing a file besides the changelog and the version',
        () =>
          Effect.gen(function* () {
            const { repo, before, gate } = yield* repository
            yield* repo.commit({
              files: {
                ...releaseFiles('0.1.0'),
                'src/a.ts': 'export const a = 3\n',
              },
              message: 'Release 0.1.0',
            })
            expect(yield* gate(before)).toEqual({
              code: 1,
              stdout:
                'not a release commit pushed alone: it changes src/a.ts (M), not only the changelog and the version\n',
              stderr: '',
            })
          }),
      )

      it.effect('one adding a change file', () =>
        Effect.gen(function* () {
          const { repo, before, gate } = yield* repository
          yield* repo.commit({
            files: {
              ...releaseFiles('0.1.0'),
              'changes/fab-mgi.3.md': '- Three.\n',
            },
            message: 'Release 0.1.0',
          })
          expect((yield* gate(before)).stdout).toContain(
            'it changes changes/fab-mgi.3.md (A)',
          )
        }),
      )

      it.effect(
        "one changing a package.json's other lines, or to another version",
        () =>
          Effect.gen(function* () {
            const { repo, before, gate } = yield* repository
            yield* repo.commit({
              files: {
                ...releaseFiles('0.1.0'),
                'package.json': manifest('0.1.0', '\n  "type": "module",'),
              },
              message: 'Release 0.1.0',
            })
            expect((yield* gate(before)).stdout).toBe(
              'not a release commit pushed alone: it changes package.json other than setting its version to 0.1.0\n',
            )
            yield* repo.git(['reset', '--quiet', '--hard', before])
            yield* repo.commit({
              files: {
                ...releaseFiles('0.1.0'),
                'package.json': manifest('0.2.0'),
              },
              message: 'Release 0.1.0',
            })
            expect((yield* gate(before)).code).toBe(1)
          }),
      )

      it.effect('one whose push went on a commit this checkout lacks', () =>
        Effect.gen(function* () {
          const { repo, gate } = yield* repository
          yield* repo.commit({
            files: releaseFiles('0.1.0'),
            message: 'Release 0.1.0',
          })
          const ran = yield* gate('0000000000000000000000000000000000000000')
          expect(ran.code).toBe(1)
          expect(ran.stdout).toContain("which isn't a commit here")
        }),
      )
    })
  },
)
