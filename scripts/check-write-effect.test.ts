import { Effect, Option } from 'effect'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, layer } from '@effect/vitest'

import {
  Toolbox,
  layerToolbox,
  tempFolder,
} from '../packages/testkit/src/index.ts'
import { checkWritten, repositoryRoot, spawnRun } from './check-write'

// The type check after a write is effect-tsgo's, so Effect's diagnostics gate it as tsconfig.base.json
// configures them: the real effect-tsgo, the repository's own, on a repository of the test's whose
// tsconfig extends the repository's base and whose node_modules is the repository's.
layer(layerToolbox({ tools: ['node'] }))("Effect's diagnostics", it => {
  it.effect(
    'find an Effect error in the written file, and nothing in a clean one',
    () =>
      Effect.gen(function* () {
        const tools = yield* Toolbox
        const repo = yield* tempFolder('check-write-effect')
        const own = repositoryRoot()
        const write = (file: string, text: string) =>
          Effect.promise(async () => {
            await mkdir(join(repo, file, '..'), { recursive: true })
            await writeFile(join(repo, file), text)
          })
        yield* Effect.promise(() =>
          symlink(join(own, 'node_modules'), join(repo, 'node_modules')),
        )
        const base = yield* Effect.promise(() =>
          readFile(join(own, 'tsconfig.base.json'), 'utf8'),
        )
        yield* write('tsconfig.base.json', base)
        yield* write(
          'packages/a/package.json',
          JSON.stringify({
            scripts: { typecheck: 'effect-tsgo tsc --noEmit -p tsconfig.json' },
          }),
        )
        yield* write(
          'packages/a/tsconfig.json',
          JSON.stringify({
            extends: '../../tsconfig.base.json',
            include: ['src/*.ts'],
          }),
        )
        yield* write('.oxlintrc.json', JSON.stringify({ rules: {} }))
        yield* write(
          'packages/a/src/never.ts',
          [
            "import { Effect } from 'effect'",
            'export const forever = Effect.gen(function* () {',
            '  yield* Effect.never',
            '})',
            '',
          ].join('\n'),
        )
        yield* write(
          'packages/a/src/good.ts',
          [
            "import { Effect } from 'effect'",
            'export const forever = Effect.gen(function* () {',
            '  return yield* Effect.never',
            '})',
            '',
          ].join('\n'),
        )
        const check = (path: string) =>
          Effect.promise(() =>
            checkWritten({
              root: repo,
              cwd: repo,
              paths: [path],
              run: spawnRun(repo, tools.env()),
              bin: tool => join(own, 'node_modules', '.bin', tool),
            }),
          )
        const found = Option.getOrThrow(yield* check('packages/a/src/never.ts'))
        expect(found).toContain('packages/a/src/never.ts(3,3): error TS377006')
        expect(found).toContain('effect(missingReturnYieldStar)')
        expect(yield* check('packages/a/src/good.ts')).toEqual(Option.none())
      }),
    60_000,
  )
})
