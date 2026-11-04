import { Effect } from 'effect'
import { TestClock } from 'effect/testing'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import type { TicketId } from '@fabrica/contracts'

import {
  type Project,
  entriesOf,
  ofKind,
  phasesOf,
  project,
  promptsOf,
  runOne,
  setUpFixtures,
  wholeRun,
} from './verifier-harness'

// A hold that keeps the verifier's model call at the proxy's permit past Pi's timeout and retries ends its
// turn on the error (spec §12.9, §13.6, §14.2): the verifier waits for the lift and carries on, in whole
// runs over `verifier-harness`'s scripted Pi and the real usage-limit hold, where a turn that didn't end
// on a failed call, or one that did with nothing held, is the session settling with no verdict it was.

beforeAll(setUpFixtures)

/** Until the ticket's verifier has settled a turn, between waits on the live clock. */
const untilSettled = (
  fixture: Project,
  ticket: TicketId,
): Effect.Effect<void> =>
  Effect.suspend(() =>
    entriesOf(fixture, ticket).some(
      entry => entry.role === 'verifier' && entry.event === 'settled',
    )
      ? Effect.void
      : Effect.andThen(
          TestClock.withLive(Effect.sleep('50 millis')),
          untilSettled(fixture, ticket),
        ),
  )

/** Once its verifier's turn has settled and the engine could take it, the hold's reset comes: it lifts. */
const liftsAfterSettling =
  (fixture: Project, seen: { prompts: number }) => (ticket: TicketId) =>
    Effect.gen(function* () {
      yield* untilSettled(fixture, ticket)
      yield* TestClock.withLive(Effect.sleep('300 millis'))
      seen.prompts = promptsOf(entriesOf(fixture, ticket), 'verifier').length
      yield* TestClock.adjust('2 hours')
    })

describe('a verifier a hold outlasts', () => {
  it.effect(
    'waits for the lift, then its session carries on to its verdict',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const seen = { prompts: 0 }
        const { id, events, detail, entries } = yield* runOne(
          fixture,
          'HELD',
          liftsAfterSettling(fixture, seen),
        )
        // No second turn while the hold was on.
        expect(seen.prompts).toBe(1)
        expect(ofKind(events, 'usage_limit_lifted')).toHaveLength(1)
        const verifiers = promptsOf(entries, 'verifier')
        expect(verifiers).toHaveLength(2)
        expect(verifiers[0]?.message).toContain('round 1 of at most 3')
        expect(verifiers[1]?.message).toContain('the hold has lifted')
        // The same session goes on.
        expect(verifiers[1]?.sessionFile).toBe(verifiers[0]?.sessionFile)
        expect(
          ofKind(events, 'info').some(({ text }) =>
            text.includes('verifier waits for the hold on anthropic to lift'),
          ),
        ).toBe(true)
        expect(phasesOf(events, id).join('\n')).not.toContain('set_aside')
        expect(detail.ticket.status).toBe('closed')
      }),
    wholeRun,
  )

  it.effect(
    'with its last call answered, settled with no verdict though a hold came during its turn',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const seen = { prompts: 0 }
        const { id, events, detail, entries } = yield* runOne(
          fixture,
          'HELD-ANSWERED',
          liftsAfterSettling(fixture, seen),
        )
        expect(promptsOf(entries, 'verifier')).toHaveLength(1)
        expect(phasesOf(events, id)).toContain(
          'set_aside (its verifier settled with no verdict in round 1)',
        )
        expect(detail.ticket.status).toBe('deferred')
      }),
    wholeRun,
  )

  it.effect(
    'with nothing held, its failed call settled with no verdict',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const { id, events, detail, entries } = yield* runOne(fixture, 'FAILED')
        expect(promptsOf(entries, 'verifier')).toHaveLength(1)
        expect(phasesOf(events, id)).toContain(
          'set_aside (its verifier settled with no verdict in round 1)',
        )
        expect(detail.ticket.status).toBe('deferred')
      }),
    wholeRun,
  )
})
