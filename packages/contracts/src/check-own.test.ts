import { Effect, Exit, Schema } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import { CheckOwnRan, CheckOwnTool, decodeArguments } from './tools'

// The `check_own` tool (spec §12.3, §13.6, H89): it takes no arguments, and answers with what the
// check came to, the tree it ran on in each case that ran.

const tree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

describe('check_own', () => {
  it.effect('takes no arguments, refusing any', () =>
    Effect.gen(function* () {
      expect(yield* decodeArguments(CheckOwnTool)({})).toEqual({})
      const exit = yield* Effect.exit(
        decodeArguments(CheckOwnTool)({ command: 'true' }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect('answers with the tree each run ran on, and why one did not', () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(CheckOwnRan)
      const passed = yield* decode({
        _tag: 'passed',
        tree,
        committed: false,
        output: '/project/.fabrica/run/checks/fa-a1b2.own.log',
      })
      expect(passed._tag === 'passed' && passed.tree).toBe(tree)
      const failed = yield* decode({
        _tag: 'failed',
        tree,
        exit: 'exit 3',
        output: 'log',
      })
      expect(failed._tag).toBe('failed')
      const notRun = yield* Effect.exit(
        decode({ _tag: 'not_run', reason: ' ' }),
      )
      expect(Exit.isFailure(notRun)).toBe(true)
      const noTree = yield* Effect.exit(
        decode({ _tag: 'timed_out', tree: 'HEAD', output: 'log' }),
      )
      expect(Exit.isFailure(noTree)).toBe(true)
    }),
  )
})
