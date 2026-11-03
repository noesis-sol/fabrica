import { Effect, Exit, Schema } from 'effect'

import { expect, layer } from '@effect/vitest'
import { Rebuilt } from '@fabrica/contracts'
import { layerToolbox } from '@fabrica/testkit'

import { onlyJson, testEngine } from './tickets-engine'

// `fabrica tickets rebuild` (spec §11.3, §19): the test engine's project rebuilt from its tickets ref,
// which the engine commits on its own as the backlog changes: at once on a close (§11.3).

const createdId = (out: ReadonlyArray<string>): string => {
  const decoded = Schema.decodeUnknownSync(
    Schema.Struct({ id: Schema.String }),
  )(onlyJson(out))
  return decoded.id
}

// The engine runs on the live clock: its sockets and its git's time limits are real.
layer(layerToolbox({ tools: ['git'] }), { excludeTestServices: true })(
  'fabrica tickets rebuild',
  it => {
    it.effect(
      'refuses with no ref; once a close has committed one, rebuilds from it',
      () =>
        Effect.gen(function* () {
          const { tickets } = yield* testEngine
          const none = yield* tickets('rebuild')
          expect(Exit.isFailure(none.exit)).toBe(true)
          expect(none.err.join('\n')).toContain('no tickets ref')

          const id = createdId((yield* tickets('create', 'One', '--json')).out)
          yield* tickets('close', id)
          // The engine commits on its own: rebuild answers once it has.
          const rebuilt = yield* tickets('rebuild', '--json').pipe(
            Effect.repeat({ until: ({ exit }) => Exit.isSuccess(exit) }),
          )
          const answer = Schema.decodeUnknownSync(Rebuilt)(
            onlyJson(rebuilt.out),
          )
          expect(answer.tickets).toBe(1)
          expect(answer.tombstones).toBe(0)

          const text = yield* tickets('rebuild')
          expect(text.out).toStrictEqual([
            'rebuilt 1 ticket and 0 tombstones from the tickets ref',
          ])
          const shown = yield* tickets('show', id)
          expect(shown.out.join('\n')).toContain('closed')
        }).pipe(Effect.scoped),
    )
  },
)
