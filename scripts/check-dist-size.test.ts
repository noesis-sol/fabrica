import { Effect, Result } from 'effect'
import { truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, layer } from '@effect/vitest'

import {
  Toolbox,
  layerToolbox,
  runCommandExit,
  tempFolder,
} from '../packages/testkit/src/index.ts'
import {
  ARCHIVE_BUDGET_BYTES,
  checkSizes,
  describeOver,
  describeWithin,
} from './check-dist-size'

// The engine distribution's size budget (spec §22.5, H64): each archive the release builds is checked
// against it, and one over it fails the release with the sizes.

describe('checkSizes', () => {
  const small = { path: 'fabrica-0.1.0-linux-arm64.tar.gz', bytes: 87_164_818 }
  const large = { path: 'fabrica-0.1.0-darwin-x64.tar.gz', bytes: 99_161_272 }

  it('passes the archives under the budget, or one at it', () => {
    expect(
      checkSizes({ archives: [small, large], budget: ARCHIVE_BUDGET_BYTES }),
    ).toEqual(Result.succeed([small, large]))
    expect(checkSizes({ archives: [large], budget: large.bytes })).toEqual(
      Result.succeed([large]),
    )
  })

  it('fails with the archives over the budget', () => {
    expect(
      checkSizes({ archives: [small, large], budget: 90_000_000 }),
    ).toEqual(Result.fail([large]))
  })

  it('says each size and the budget', () => {
    expect(describeWithin(small, ARCHIVE_BUDGET_BYTES)).toBe(
      'fabrica-0.1.0-linux-arm64.tar.gz: 87.2 MB (87,164,818 bytes), within the budget of 119.0 MB',
    )
    expect(describeOver(large, 90_000_000)).toBe(
      'fabrica-0.1.0-darwin-x64.tar.gz: 99.2 MB (99,161,272 bytes), 9.2 MB over the budget of 90.0 MB',
    )
  })

  it('leaves room over the largest archive measured, darwin-x64’s at 0.0.0', () => {
    expect(ARCHIVE_BUDGET_BYTES).toBeGreaterThanOrEqual(large.bytes * 1.2)
    expect(ARCHIVE_BUDGET_BYTES).toBeLessThan(large.bytes * 1.2 + 1_000_000)
  })
})

const repository = join(import.meta.dirname, '..')

layer(layerToolbox({ tools: ['node'] }))('the script', it => {
  const script = (cwd: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const tools = yield* Toolbox
      return yield* runCommandExit({
        command: 'node',
        args: [join(repository, 'scripts', 'check-dist-size.ts'), ...args],
        cwd,
        env: tools.env({}),
      })
    })

  it.effect('passes archives within the budget and fails one over it', () =>
    Effect.gen(function* () {
      const root = yield* tempFolder('check-dist-size')
      // Sparse files: their size is the length truncate gives them, with nothing written.
      yield* Effect.promise(async () => {
        await writeFile(join(root, 'within.tar.gz'), '')
        await truncate(join(root, 'within.tar.gz'), ARCHIVE_BUDGET_BYTES)
        await writeFile(join(root, 'over.tar.gz'), '')
        await truncate(
          join(root, 'over.tar.gz'),
          ARCHIVE_BUDGET_BYTES + 1_000_000,
        )
      })
      const within = yield* script(root, ['within.tar.gz'])
      expect(within).toEqual({
        code: 0,
        stdout:
          'within.tar.gz: 119.0 MB (119,000,000 bytes), within the budget of 119.0 MB\n',
        stderr: '',
      })
      const over = yield* script(root, ['within.tar.gz', 'over.tar.gz'])
      expect(over).toEqual({
        code: 1,
        stdout:
          'within.tar.gz: 119.0 MB (119,000,000 bytes), within the budget of 119.0 MB\n',
        stderr:
          'check-dist-size: over.tar.gz: 120.0 MB (120,000,000 bytes), 1.0 MB over the budget of 119.0 MB\n',
      })
      const missing = yield* script(root, ['missing.tar.gz'])
      expect(missing).toEqual({
        code: 1,
        stdout: '',
        stderr: "check-dist-size: missing.tar.gz isn't there\n",
      })
      const usage = yield* script(root, [])
      expect(usage.code).toBe(2)
    }),
  )
})
