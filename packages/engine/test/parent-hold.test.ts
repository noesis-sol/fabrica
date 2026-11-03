import { DateTime, Effect, Layer, Option, Ref, Schema } from 'effect'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  CommitHash,
  EngineId,
  type RunEvent,
  Ticket,
  TicketId,
  TicketMetadata,
} from '@fabrica/contracts'

import {
  makeApartFiles,
  makeRepository,
  noMentions,
  ticketFootprint,
} from '../src/footprints'
import { type ReadyTicket, gate, parentWords } from '../src/run/footprints-gate'
import {
  type OnBase,
  WorkGraph,
  makeWorkGraph,
  storeLayer,
} from '../src/workgraph'
import { file, ofKind, project, runOf, setUpRuns } from './run-harness'

// A parent runs after its subtickets (spec §13.4, as orchestra's "Parents run last"): a ticket with a
// subticket (a `parent` edge) not closed and merged is held back with reason `parent`, and dispatched
// once each has merged. First the work graph's read of such parents, then the gate's rule, then a run.

// ---- The work graph ----------------------------------------------------------------------------

const graphLayer = Layer.effect(
  WorkGraph,
  makeWorkGraph({ prefix: 'fa' }),
).pipe(Layer.provide(storeLayer(':memory:')))

const maintainer: Actor = { _tag: 'maintainer' }
const engineActor: Actor = { _tag: 'engine', engine: EngineId.make('engine-1') }
const commit = CommitHash.make('a'.repeat(40))

const allOnBase: OnBase = () => Effect.succeed(true)
const noneOnBase: OnBase = () => Effect.succeed(false)

/** An `onBase` saying `on` of each ticket, recording what it is asked. */
const askedGit = (on: boolean) =>
  Effect.map(Ref.make<ReadonlyArray<TicketId>>([]), asked => ({
    asked,
    onBase: (id: TicketId) =>
      Effect.as(
        Ref.update(asked, ids => [...ids, id]),
        on,
      ),
  }))

const fileTicket = (
  title: string,
  extra: Partial<{
    readonly type: 'task' | 'epic' | 'manual'
    readonly parent: TicketId
  }> = {},
) =>
  Effect.flatMap(WorkGraph, graph =>
    graph.create({
      ticket: { type: extra.type ?? 'task', title, ...extra },
      actor: maintainer,
    }),
  )

/** Closes the ticket, its work merged when `merged`. */
const close = (ticket: Ticket, merged: boolean) =>
  Effect.flatMap(WorkGraph, graph =>
    Effect.andThen(
      graph.close({ id: ticket.id, resolution: 'done', actor: engineActor }),
      merged
        ? Effect.asVoid(
            graph.update({
              id: ticket.id,
              changes: { mergedCommit: Option.some(commit) },
              actor: engineActor,
            }),
          )
        : Effect.void,
    ),
  )

const unfinished = (ids: ReadonlyArray<TicketId>, onBase: OnBase) =>
  Effect.flatMap(WorkGraph, graph =>
    Effect.map(graph.unfinishedParents({ ids, onBase }), parents =>
      [...parents].toSorted(),
    ),
  )

describe('unfinishedParents', () => {
  it.effect(
    'gives a ticket with a subticket not closed and merged, until each is',
    () =>
      Effect.gen(function* () {
        const parent = yield* fileTicket('Parent')
        const one = yield* fileTicket('One', { parent: parent.id })
        const two = yield* fileTicket('Two', { parent: parent.id })
        const alone = yield* fileTicket('Alone')
        const asked = [parent.id, alone.id]
        expect(yield* unfinished(asked, allOnBase)).toEqual([parent.id])

        yield* close(one, true)
        expect(yield* unfinished(asked, allOnBase)).toEqual([parent.id])
        // Closed, its branch not on Base: CLOSED_UNMERGED holds its parent still.
        yield* close(two, false)
        expect(yield* unfinished(asked, noneOnBase)).toEqual([parent.id])
        expect(yield* unfinished(asked, allOnBase)).toEqual([])
      }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('asks git nothing of a parent a subticket not closed holds', () =>
    Effect.gen(function* () {
      const parent = yield* fileTicket('Parent')
      const closed = yield* fileTicket('Closed', { parent: parent.id })
      yield* fileTicket('Open', { parent: parent.id })
      yield* close(closed, false)
      const git = yield* askedGit(true)
      expect(yield* unfinished([parent.id], git.onBase)).toEqual([parent.id])
      expect(yield* Ref.get(git.asked)).toEqual([])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect(
    'asks git only of a closed subticket with no merged commit, once',
    () =>
      Effect.gen(function* () {
        const parent = yield* fileTicket('Parent')
        const merged = yield* fileTicket('Merged', { parent: parent.id })
        const closed = yield* fileTicket('Closed', { parent: parent.id })
        // A maintainer task has no branch: closed, it is merged.
        const manual = yield* fileTicket('By hand', {
          type: 'manual',
          parent: parent.id,
        })
        yield* close(merged, true)
        yield* close(closed, false)
        yield* close(manual, false)
        const git = yield* askedGit(true)
        expect(yield* unfinished([parent.id], git.onBase)).toEqual([])
        expect(yield* Ref.get(git.asked)).toEqual([closed.id])
      }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('holds a ticket on an open subticket of any type', () =>
    Effect.gen(function* () {
      const parent = yield* fileTicket('Parent')
      const manual = yield* fileTicket('By hand', {
        type: 'manual',
        parent: parent.id,
      })
      expect(yield* unfinished([parent.id], allOnBase)).toEqual([parent.id])
      yield* close(manual, false)
      expect(yield* unfinished([parent.id], allOnBase)).toEqual([])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('reads only the tickets asked of, and none for none', () =>
    Effect.gen(function* () {
      const parent = yield* fileTicket('Parent')
      yield* fileTicket('Child', { parent: parent.id })
      const other = yield* fileTicket('Other')
      expect(yield* unfinished([other.id], allOnBase)).toEqual([])
      expect(yield* unfinished([], allOnBase)).toEqual([])
    }).pipe(Effect.provide(graphLayer)),
  )
})

// ---- The gate ----------------------------------------------------------------------------------

const repository = makeRepository(['src/x.ts', 'src/y.ts'])
const apart = makeApartFiles({ unioned: [], checks: [], shared: [] })
const id = (n: number) => TicketId.make(`fa-${n}`)

const ready = (
  n: number,
  files: ReadonlyArray<string>,
  solo = false,
): ReadyTicket => {
  const ticket = new Ticket({
    id: id(n),
    type: 'task',
    title: `Ticket ${n}`,
    description: Option.none(),
    design: Option.none(),
    acceptance: Option.none(),
    status: 'open',
    resolution: Option.none(),
    priority: 2,
    deferUntil: Option.none(),
    assignee: Option.none(),
    model: Option.none(),
    metadata: Schema.decodeUnknownSync(TicketMetadata)({ files }),
    result: Option.none(),
    question: Option.none(),
    mergedCommit: Option.none(),
    closeReason: Option.none(),
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
  })
  return {
    ticket,
    footprint: ticketFootprint({
      ticket: { ticket, labels: solo ? ['solo'] : [] },
      repository,
      declared: { declares: () => false },
    }),
    solo,
  }
}

const gated = (
  candidates: ReadonlyArray<ReadyTicket>,
  parents: ReadonlyArray<TicketId>,
  free = 4,
) =>
  gate({
    ready: candidates,
    parents: new Set(parents),
    running: [],
    free,
    mentions: noMentions,
    apart,
  })

describe('the gate', () => {
  it('holds a parent back, in words, taking no slot and holding nothing apart', () => {
    const result = gated(
      [ready(1, ['src/x.ts']), ready(2, ['src/x.ts']), ready(3, ['src/y.ts'])],
      [id(1)],
      2,
    )
    expect(result.take.map(({ ticket }) => ticket.id)).toEqual([id(2), id(3)])
    expect(result.held).toEqual([
      {
        ticket: id(1),
        reason: 'parent',
        detail: 'its subtickets are not all closed and merged',
      },
    ])
    expect(parentWords).toBe('its subtickets are not all closed and merged')
  })

  it('holds a solo parent as a parent, the solo ticket not in line', () => {
    const result = gated([ready(1, [], true), ready(2, ['src/y.ts'])], [id(1)])
    expect(result.held.map(({ reason }) => reason)).toEqual(['parent'])
    expect(result.take.map(({ ticket }) => ticket.id)).toEqual([id(2)])
    expect(Option.isNone(result.solo)).toBe(true)
  })
})

// ---- A run -------------------------------------------------------------------------------------

beforeAll(() => {
  setUpRuns()
})

/** Each ticket's phase records, in order: where it went, and why. */
const phasesOf = (events: ReadonlyArray<RunEvent>, ticket: TicketId) =>
  ofKind(events, 'phase')
    .filter(event => event.ticket === ticket)
    .map(({ to, cause }) => ({ to, cause }))

const indexOf = (
  events: ReadonlyArray<RunEvent>,
  kind: 'dispatch' | 'closed',
  ticket: TicketId,
) =>
  events.findIndex(
    event =>
      event.kind === kind && 'ticket' in event && event.ticket === ticket,
  )

describe('a run with a parent', () => {
  it.effect(
    'holds the parent back until its subtickets merged, then dispatches it',
    () =>
      Effect.gen(function* () {
        const { end, events, made, ticketOf } = yield* runOf(
          project(),
          Effect.gen(function* () {
            const parent = yield* file('Parent', 'finish', { priority: 0 })
            const one = yield* file('One', 'finish', { parent: parent.id })
            const two = yield* file('Two', 'finish', { parent: parent.id })
            return { parent, children: [one, two] }
          }),
        )
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        const { parent, children } = made
        expect(phasesOf(events, parent.id).slice(0, 2)).toEqual([
          { to: 'queued', cause: 'ready' },
          { to: 'held_back', cause: parentWords },
        ])
        const dispatches = ofKind(events, 'dispatch')
        expect(dispatches[0]).toEqual(
          expect.objectContaining({ held: 1, held_by: { parent: 1 } }),
        )
        for (const child of children)
          expect(indexOf(events, 'closed', child.id)).toBeLessThan(
            indexOf(events, 'dispatch', parent.id),
          )
        for (const ticket of [parent, ...children])
          expect(Option.isSome(ticketOf(ticket.id).mergedCommit)).toBe(true)
      }),
  )
})
