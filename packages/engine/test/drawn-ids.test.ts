import { Effect, Random } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import { drawEngineId } from '../src/engine/database'
import {
  drawBase36,
  drawNoteId,
  drawTicketId,
  ticketIdRandomLength,
} from '../src/workgraph/ids'

// Drawn IDs keep their full length (fab-mgi.20): each character is drawn from the 36 of base36, the
// top one included, and never from one past it, which would be no character at all.

/** A Random whose every double is the highest below 1, the draw that lands on the top index. */
const highest: Random.Random = {
  nextIntUnsafe: () => Number.MAX_SAFE_INTEGER,
  nextDoubleUnsafe: () => 1 - Number.EPSILON,
}

describe('drawn IDs', () => {
  it.effect('a draw at the top of the range gives z, not nothing', () =>
    Effect.gen(function* () {
      expect(yield* drawBase36(4)).toBe('zzzz')
      expect(yield* drawTicketId('fa')).toBe(
        `fa-${'z'.repeat(ticketIdRandomLength)}`,
      )
      expect(yield* drawNoteId).toBe('z'.repeat(16))
      expect(yield* drawEngineId).toBe(`engine-${'z'.repeat(16)}`)
    }).pipe(Effect.provideService(Random.Random, highest)),
  )

  it.effect('every seeded draw has its full length in base36', () =>
    Effect.gen(function* () {
      const seeds = Array.from({ length: 200 }, (_, n) => `seed-${n}`)
      const ids = yield* Effect.forEach(seeds, seed =>
        Effect.all([drawTicketId('fa'), drawNoteId, drawEngineId]).pipe(
          Random.withSeed(seed),
        ),
      )
      for (const [ticket, note, engine] of ids) {
        expect(ticket).toMatch(
          new RegExp(`^fa-[0-9a-z]{${ticketIdRandomLength}}$`, 'u'),
        )
        expect(note).toMatch(/^[0-9a-z]{16}$/u)
        expect(engine).toMatch(/^engine-[0-9a-z]{16}$/u)
      }
    }),
  )
})
