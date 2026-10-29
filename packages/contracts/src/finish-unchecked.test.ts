import { Effect, Exit } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import { FinishTool, decodeArguments, finishFor } from './tools'

// `finish` where the project's `check_own` is "none" (spec §12.3, H62): nothing records a pass, so it
// takes "none" in the pass's place, and the engine finishes the work unchecked.

const result = { _tag: 'summary', summary: 'Changed it.' }

const refuses = (input: unknown) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(decodeArguments(FinishTool)(input))
    expect(Exit.isFailure(exit)).toBe(true)
  })

describe('finish with check_own "none"', () => {
  it.effect('takes "none" in the pass’s place', () =>
    Effect.gen(function* () {
      const finished = yield* decodeArguments(FinishTool)({
        checkOwn: 'none',
        result,
      })
      expect(finished.checkOwn).toBe('none')
      const kind = yield* decodeArguments(finishFor('summary'))({
        checkOwn: 'none',
        result,
      })
      expect(kind.checkOwn).toBe('none')
    }),
  )

  it.effect('refuses any other word, or none at all', () =>
    Effect.gen(function* () {
      yield* refuses({ checkOwn: 'unchecked', result })
      yield* refuses({ checkOwn: '', result })
      yield* refuses({ checkOwn: null, result })
    }),
  )
})
