import { Effect, Layer, Option, Schema } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  Assignee,
  EngineId,
  SessionId,
  TicketId,
  Verdict,
} from '@fabrica/contracts'

import {
  TicketNotFound,
  type VerifierRound,
  WorkGraph,
  makeWorkGraph,
  storeLayer,
} from '../src/workgraph'

// The verifier's rounds kept in the work graph's store (spec §11.2, §13.6): by ticket, in order, kept
// across the engine's restarts so a ticket dispatched again goes on counting them, and dropped as the
// ticket closes or is deleted.

const graphLayer = (filename: string) =>
  Layer.effect(WorkGraph, makeWorkGraph({ prefix: 'fa' })).pipe(
    Layer.provide(storeLayer(filename)),
  )

const maintainer: Actor = { _tag: 'maintainer' }
const assignee = new Assignee({
  engine: EngineId.make('engine-1'),
  session: SessionId.make('session-1'),
})

const decodeVerdict = Schema.decodeUnknownSync(Verdict)

/** Round `round`'s FAIL, a finding disagreeing with `disagrees` where it is given. */
const failed = (round: number, disagrees?: number): VerifierRound => ({
  round,
  verdict: decodeVerdict({
    _tag: 'FAIL',
    summary: `A gap in round ${round}.`,
    findings: [
      {
        gap: `src/x.ts:1 has no test, round ${round}`,
        blocking: true,
        ...(disagrees === undefined ? {} : { disagreesWithRound: disagrees }),
      },
      { gap: 'a clearer name', blocking: false },
    ],
  }),
})

/** A task filed and claimed for a worker. */
const claimed = (title: string) =>
  Effect.gen(function* () {
    const graph = yield* WorkGraph
    const ticket = yield* graph.create({
      ticket: { type: 'task', title },
      actor: maintainer,
    })
    yield* graph.claim({ id: ticket.id, assignee, actor: maintainer })
    return ticket.id
  })

/** A temporary folder for one test, removed when the test ends. */
const scratch = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(NodePath.join(tmpdir(), 'fabrica-rounds-'))),
  folder => Effect.promise(() => rm(folder, { recursive: true, force: true })),
)

describe('verifier rounds in the store', () => {
  it.effect('keeps each round by ticket, first first, its verdict whole', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const ticket = yield* claimed('Verified')
      const other = yield* claimed('Unverified')
      expect(yield* graph.verifierRounds(ticket)).toEqual([])

      yield* graph.recordVerifierRound({ ticket, round: failed(2, 1) })
      yield* graph.recordVerifierRound({ ticket, round: failed(1) })
      const kept = yield* graph.verifierRounds(ticket)
      expect(kept).toEqual([failed(1), failed(2, 1)])
      expect(kept[1]?.verdict.findings[0]?.disagreesWithRound).toEqual(
        Option.some(1),
      )
      expect(kept[0]?.verdict.findings[0]?.disagreesWithRound).toEqual(
        Option.none(),
      )
      expect(yield* graph.verifierRounds(other)).toEqual([])
    }).pipe(Effect.provide(graphLayer(':memory:'))),
  )

  it.effect('writes a round kept again afresh', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const ticket = yield* claimed('Again')
      yield* graph.recordVerifierRound({ ticket, round: failed(1) })
      yield* graph.recordVerifierRound({ ticket, round: failed(1, 1) })
      expect(yield* graph.verifierRounds(ticket)).toEqual([failed(1, 1)])
    }).pipe(Effect.provide(graphLayer(':memory:'))),
  )

  it.effect('refuses a round of a ticket the graph hasn’t', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const missing = TicketId.make('fa-none')
      expect(
        yield* Effect.flip(
          graph.recordVerifierRound({ ticket: missing, round: failed(1) }),
        ),
      ).toEqual(new TicketNotFound({ id: missing }))
    }).pipe(Effect.provide(graphLayer(':memory:'))),
  )

  it.effect('keeps the rounds across the engine’s restart', () =>
    Effect.gen(function* () {
      const filename = NodePath.join(yield* scratch, 'work.db')
      const ticket = yield* Effect.gen(function* () {
        const graph = yield* WorkGraph
        const ticket = yield* claimed('Carried over')
        yield* graph.recordVerifierRound({ ticket, round: failed(1) })
        yield* graph.recordVerifierRound({ ticket, round: failed(2, 1) })
        return ticket
      }).pipe(Effect.provide(graphLayer(filename)))

      yield* Effect.gen(function* () {
        const graph = yield* WorkGraph
        expect(yield* graph.verifierRounds(ticket)).toEqual([
          failed(1),
          failed(2, 1),
        ])
      }).pipe(Effect.provide(graphLayer(filename)))
    }).pipe(Effect.scoped),
  )

  it.effect('drops a ticket’s rounds as it closes, and only its own', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const merged = yield* claimed('Merged')
      const running = yield* claimed('Running')
      yield* graph.recordVerifierRound({ ticket: merged, round: failed(1) })
      yield* graph.recordVerifierRound({ ticket: running, round: failed(1) })

      yield* graph.close({ id: merged, resolution: 'done', actor: maintainer })
      expect(yield* graph.verifierRounds(merged)).toEqual([])
      expect(yield* graph.verifierRounds(running)).toEqual([failed(1)])

      // Reopened, it is verified afresh.
      yield* graph.reopen({ id: merged, actor: maintainer })
      expect(yield* graph.verifierRounds(merged)).toEqual([])
    }).pipe(Effect.provide(graphLayer(':memory:'))),
  )

  it.effect('drops a ticket’s rounds as it is deleted', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const ticket = yield* claimed('Gone')
      yield* graph.recordVerifierRound({ ticket, round: failed(1) })
      yield* graph.delete({ id: ticket, actor: maintainer })
      expect(yield* graph.verifierRounds(ticket)).toEqual([])
    }).pipe(Effect.provide(graphLayer(':memory:'))),
  )
})
