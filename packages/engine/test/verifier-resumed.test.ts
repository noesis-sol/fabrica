import { Effect, Option, Schema } from 'effect'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { Verdict } from '@fabrica/contracts'

import { runProject } from '../src/run'
import { readEvents } from '../src/runlog'
import { WorkGraph } from '../src/workgraph'
import {
  configOf,
  entriesOf,
  fakeProvider,
  maintainer,
  ofKind,
  phasesOf,
  project,
  promptsOf,
  run,
  services,
  setUpFixtures,
  settings,
  wholeRun,
} from './verifier-harness'

// The verifier's rounds outlast a dispatch (spec §13.6): a ticket dispatched again, its question
// answered or carried over, goes on counting its rounds toward `verifier.rounds`, and its verifier
// weighs the earlier rounds' findings, over `verifier-harness`'s scripted Pi.

beforeAll(setUpFixtures)

/** Files a task whose verifier gives `verify`, round by round. */
const filed = (verify: string) =>
  Effect.gen(function* () {
    const graph = yield* WorkGraph
    const made = yield* graph.create({
      ticket: {
        type: 'task',
        title: 'Add the widget',
        description: `Adds the widget.\n\nverify: ${verify}`,
      },
      actor: maintainer,
    })
    return made.id
  })

describe('verifier rounds across dispatches', () => {
  it.effect(
    'goes on from the last round once the question a disagreement asked is answered',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const provider = yield* fakeProvider
        yield* Effect.gen(function* () {
          const graph = yield* WorkGraph
          const id = yield* filed('FAIL,DISAGREE,PASS')
          yield* runProject(configOf(fixture))
          const first = yield* readEvents({
            root: fixture.checkout,
            run: Option.some(run),
          })
          const [asked] = ofKind(first.events, 'asked')
          expect(asked?.ticket).toBe(id)
          expect(
            (yield* graph.verifierRounds(id)).map(({ round }) => round),
          ).toEqual([1, 2])

          yield* graph.answer({
            id: Option.getOrThrow(Option.fromUndefinedOr(asked)).question,
            answer: 'Round 2',
            actor: maintainer,
          })
          yield* runProject(configOf(fixture))

          const entries = entriesOf(fixture, id)
          const verifiers = promptsOf(entries, 'verifier')
          expect(verifiers).toHaveLength(3)
          const third = verifiers[2]?.message ?? ''
          expect(third).toContain('round 3 of at most 3')
          expect(third).toContain("The earlier rounds' findings")
          expect(third).toContain('Round 1: FAIL. A gap in round 1.')
          expect(third).toContain(
            '- [blocking] src/x.ts:1 has no test, round 1',
          )
          expect(third).toContain(
            '- [blocking] DISAGREES WITH ROUND 1: the ticket asks for no such test',
          )
          const detail = yield* graph.show(id)
          expect(detail.ticket.status).toBe('closed')
          // Merged, its rounds are dropped.
          expect(yield* graph.verifierRounds(id)).toEqual([])
          const { events } = yield* readEvents({
            root: fixture.checkout,
            run: Option.some(run),
          })
          expect(phasesOf(events, id)).toContain('verifying (finished again)')
          expect(
            ofKind(events, 'info').some(event =>
              event.text.includes(`${id} verified in round 3`),
            ),
          ).toBe(true)
        }).pipe(Effect.provide(services(fixture, provider.url)))
      }).pipe(Effect.scoped),
    wholeRun,
  )

  it.effect(
    'sends a finish past the last round kept from an earlier dispatch to the merge queue unverified',
    () =>
      Effect.gen(function* () {
        const fixture = project({ ...settings, verifier: { rounds: 2 } })
        const provider = yield* fakeProvider
        yield* Effect.gen(function* () {
          const graph = yield* WorkGraph
          const id = yield* filed('FAIL')
          const verdict = Schema.decodeUnknownSync(Verdict)({
            _tag: 'FAIL',
            summary: 'A gap.',
            findings: [{ gap: 'src/x.ts:1 has no test', blocking: true }],
          })
          // Two rounds an earlier dispatch was given, before its ticket was deferred and undeferred.
          yield* graph.recordVerifierRound({
            ticket: id,
            round: { round: 1, verdict },
          })
          yield* graph.recordVerifierRound({
            ticket: id,
            round: { round: 2, verdict },
          })
          yield* runProject(configOf(fixture))

          expect(promptsOf(entriesOf(fixture, id), 'verifier')).toEqual([])
          const { events } = yield* readEvents({
            root: fixture.checkout,
            run: Option.some(run),
          })
          expect(phasesOf(events, id)).toContain(
            "waiting_to_merge (finished past the verifier's last round, 2)",
          )
          expect((yield* graph.show(id)).ticket.status).toBe('closed')
        }).pipe(Effect.provide(services(fixture, provider.url)))
      }).pipe(Effect.scoped),
    wholeRun,
  )
})
