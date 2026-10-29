import { Effect, Redacted } from 'effect'
import { randomBytes, timingSafeEqual } from 'node:crypto'

import type { Edge, TicketId } from '@fabrica/contracts'

// An agent's control token and what it reaches (spec §12.2, §20.2): drawn for each session, handed to
// the agent in its environment, checked on every request in constant time; it reaches the session's
// own ticket and the tickets linked to it, either way.

/** A new token: 32 random bytes, in hex. */
export const drawToken: Effect.Effect<Redacted.Redacted<string>> = Effect.sync(
  () => Redacted.make(randomBytes(32).toString('hex')),
)

/** Whether `given` is the token, compared in constant time. */
export const tokenMatches = (
  token: Redacted.Redacted<string>,
  given: string,
): boolean => {
  const expected = Buffer.from(Redacted.value(token))
  const actual = Buffer.from(given)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Whether a session on `own`, linked by `edges`, may act on `target`: its own ticket, or one linked to it. */
export const inScope = (input: {
  readonly own: TicketId
  readonly edges: ReadonlyArray<Edge>
  readonly target: TicketId
}): boolean =>
  input.target === input.own ||
  input.edges.some(
    edge =>
      (edge.from === input.own && edge.to === input.target) ||
      (edge.to === input.own && edge.from === input.target),
  )
