import { Effect, Exit, Schema } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import {
  EventLine,
  LocalTime,
  ModelName,
  RunEvent,
  decodeEventLine,
  encodeEventLine,
} from './events'
import { RunId } from './ids'
import { ModelOverride, OrganName } from './ticket'

const at = {
  time: LocalTime.make('2026-10-29T10:15:00.000+02:00'),
  run: RunId.make('2026-10-29T10:14:58.120+02:00'),
}

const organLine = (organ: string): string =>
  JSON.stringify({
    v: 1,
    ...at,
    kind: 'organ',
    organ,
    outcome: 'answered',
    duration_ms: 1200,
  })

describe("the stream's organs and models", () => {
  it.effect.each([...OrganName.literals])(
    'records the %s organ by its ticket name',
    organ =>
      Effect.gen(function* () {
        const event = RunEvent.cases.organ.make({
          ...at,
          organ,
          outcome: 'answered',
          duration_ms: 1200,
        })
        expect(yield* decodeEventLine(encodeEventLine(event))).toEqual(
          EventLine.Known({ event }),
        )
      }),
  )

  it.effect('refuses an organ that is not an OrganName', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decodeEventLine(organLine('oracle')))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it('takes every ModelOverride as a ModelName, and a bare model name too', () => {
    const override = Schema.decodeUnknownSync(ModelOverride)(
      'anthropic/claude-opus-5-5',
    )
    expect(Schema.is(ModelName)(override)).toBe(true)
    expect(Schema.is(ModelName)('claude-opus-5-5')).toBe(true)
    expect(Schema.is(ModelOverride)('claude-opus-5-5')).toBe(false)
  })
})
