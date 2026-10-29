import { DateTime, Duration, Effect, Layer, Option, Ref } from 'effect'
import { TestClock } from 'effect/testing'

import { describe, expect, it } from '@effect/vitest'
import {
  type Actor,
  Assignee,
  CommitHash,
  Edge,
  EngineId,
  SessionId,
  type Ticket,
  TicketId,
} from '@fabrica/contracts'

import {
  type OnBase,
  TicketNotFound,
  WaitReason,
  WorkGraph,
  describeWait,
  makeWorkGraph,
  storeLayer,
} from '../src/workgraph'

// The ready rule and why a ticket waits (spec §13.3), with the epics that close themselves and what
// closing a ticket offers to close with it (§11.1), against an in-memory work graph. Git's word on a
// closed ticket's branch is the `onBase` the test gives.

const graphLayer = Layer.effect(
  WorkGraph,
  makeWorkGraph({ prefix: 'fa' }),
).pipe(Layer.provide(storeLayer(':memory:')))

const maintainer: Actor = { _tag: 'maintainer' }
const engineActor: Actor = { _tag: 'engine', engine: EngineId.make('engine-1') }
const assignee = new Assignee({
  engine: EngineId.make('engine-1'),
  session: SessionId.make('session-1'),
})
const commit = CommitHash.make('a'.repeat(40))

/** Git with no branch off Base: every closed ticket's work is on it. */
const allOnBase: OnBase = () => Effect.succeed(true)
/** Git finding every closed ticket's branch off Base. */
const noneOnBase: OnBase = () => Effect.succeed(false)

/** An `onBase` saying `on` of each ticket, recording what it is asked. */
const askedGit = (on: (id: TicketId) => boolean) =>
  Effect.map(Ref.make<ReadonlyArray<TicketId>>([]), asked => ({
    asked,
    onBase: (id: TicketId) =>
      Effect.as(
        Ref.update(asked, ids => [...ids, id]),
        on(id),
      ),
  }))

const file = (
  title: string,
  extra: Partial<{
    readonly type: 'task' | 'bug' | 'epic' | 'manual'
    readonly priority: 0 | 1 | 2 | 3 | 4
    readonly parent: TicketId
  }> = {},
) =>
  Effect.flatMap(WorkGraph, graph =>
    // A millisecond apart, so that tickets of a priority list in the order they were filed.
    Effect.andThen(
      TestClock.adjust(Duration.millis(1)),
      graph.create({
        ticket: { type: extra.type ?? 'task', title, ...extra },
        actor: maintainer,
      }),
    ),
  )

const blocks = (from: Ticket, to: Ticket) =>
  Effect.flatMap(WorkGraph, graph =>
    graph.addDependency({
      edge: new Edge({ from: from.id, to: to.id, kind: 'blocks' }),
      actor: maintainer,
    }),
  )

/** Files a ticket found while working on `from`. */
const discovered = (from: Ticket, title: string) =>
  Effect.flatMap(WorkGraph, graph =>
    Effect.andThen(
      TestClock.adjust(Duration.millis(1)),
      graph.fileDiscovered({
        from: from.id,
        link: 'discovered_from',
        ticket: { type: 'task', title },
        actor: maintainer,
      }),
    ),
  )

const claim = (ticket: Ticket) =>
  Effect.flatMap(WorkGraph, graph =>
    graph.claim({ id: ticket.id, assignee, actor: maintainer }),
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

const readyIds = (onBase: OnBase = allOnBase, setAside: Array<TicketId> = []) =>
  Effect.flatMap(WorkGraph, graph =>
    Effect.map(graph.ready({ onBase, setAside }), tickets =>
      tickets.map(ticket => ticket.id),
    ),
  )

const why = (
  ticket: Ticket,
  onBase: OnBase = allOnBase,
  setAside: Array<TicketId> = [],
) =>
  Effect.flatMap(WorkGraph, graph =>
    graph.why({ id: ticket.id, onBase, setAside }),
  )

describe('ready', () => {
  it.effect('gives the open tickets, most urgent first, then oldest', () =>
    Effect.gen(function* () {
      const later = yield* file('Later', { priority: 3 })
      const first = yield* file('First', { priority: 1 })
      const second = yield* file('Second', { priority: 1 })
      const bug = yield* file('Bug', { type: 'bug' })
      expect(yield* readyIds()).toEqual([first.id, second.id, bug.id, later.id])
      expect(yield* why(first)).toEqual([])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('leaves out a ticket in progress or closed', () =>
    Effect.gen(function* () {
      const running = yield* file('Running')
      const done = yield* file('Done')
      yield* claim(running)
      yield* close(done, true)
      expect(yield* readyIds()).toEqual([])
      expect(yield* why(running)).toEqual([
        WaitReason.NotOpen({ status: 'in_progress' }),
      ])
      expect(yield* why(done)).toEqual([
        WaitReason.NotOpen({ status: 'closed' }),
      ])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('leaves out a deferred ticket until its time has come', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const aside = yield* file('Aside')
      const timed = yield* file('Timed')
      const until = DateTime.makeUnsafe(60_000)
      yield* graph.defer({
        id: aside.id,
        until: Option.none(),
        actor: maintainer,
      })
      yield* graph.defer({
        id: timed.id,
        until: Option.some(until),
        actor: maintainer,
      })
      expect(yield* readyIds()).toEqual([])
      expect(yield* why(aside)).toEqual([
        WaitReason.Deferred({ until: Option.none() }),
      ])
      expect(yield* why(timed)).toEqual([
        WaitReason.Deferred({ until: Option.some(until) }),
      ])

      yield* TestClock.adjust(Duration.minutes(1))
      expect(yield* readyIds()).toEqual([timed.id])
      expect(yield* why(timed)).toEqual([])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('never gives an epic, a question or a maintainer task', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const epic = yield* file('M1', { type: 'epic' })
      const manual = yield* file('Set up the account', { type: 'manual' })
      const question = yield* graph.ask({
        question: {
          title: 'Which database?',
          consequential: false,
          maintainerOnly: false,
        },
        actor: maintainer,
      })
      const blocker = yield* file('Blocker')
      yield* blocks(blocker, manual)
      yield* close(blocker, true)
      expect(yield* readyIds()).toEqual([])
      expect(yield* why(epic)).toEqual([
        WaitReason.NotForWorkers({ type: 'epic' }),
      ])
      expect(yield* why(question)).toEqual([
        WaitReason.NotForWorkers({ type: 'question' }),
      ])
      expect(yield* why(manual)).toEqual([
        WaitReason.NotForWorkers({ type: 'manual' }),
      ])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('leaves out a ticket set aside in this run', () =>
    Effect.gen(function* () {
      const aside = yield* file('Aside')
      const other = yield* file('Other')
      expect(yield* readyIds(allOnBase, [aside.id])).toEqual([other.id])
      expect(yield* why(aside, allOnBase, [aside.id])).toEqual([
        WaitReason.SetAside(),
      ])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('holds a ticket until each blocker is closed', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const open = yield* file('Open blocker')
      const running = yield* file('Running blocker')
      const deferred = yield* file('Deferred blocker')
      const waiting = yield* file('Waiting')
      yield* blocks(open, waiting)
      yield* blocks(running, waiting)
      yield* blocks(deferred, waiting)
      yield* claim(running)
      yield* graph.defer({
        id: deferred.id,
        until: Option.none(),
        actor: maintainer,
      })
      expect(yield* readyIds()).toEqual([open.id])
      expect((yield* why(waiting)).map(describeWait).toSorted()).toEqual(
        [
          `waits for ${open.id} to merge: it is open`,
          `waits for ${running.id} to merge: it is in progress`,
          `waits for ${deferred.id} to merge: it is deferred`,
        ].toSorted(),
      )

      for (const blocker of [open, running, deferred]) {
        yield* close(blocker, true)
      }
      expect(yield* readyIds()).toEqual([waiting.id])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect(
    'holds a ticket behind a blocker closed but not merged (CLOSED_UNMERGED)',
    () =>
      Effect.gen(function* () {
        const blocker = yield* file('Blocker')
        const waiting = yield* file('Waiting')
        yield* blocks(blocker, waiting)
        yield* close(blocker, false)
        expect(yield* readyIds(noneOnBase)).toEqual([])
        expect(yield* why(waiting, noneOnBase)).toEqual([
          WaitReason.ClosedUnmerged({ blocker: blocker.id }),
        ])
        // Its branch on Base, as git says: merged.
        expect(yield* readyIds(allOnBase)).toEqual([waiting.id])
        expect(yield* why(waiting, allOnBase)).toEqual([])
      }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('takes a merged commit as merged without asking git', () =>
    Effect.gen(function* () {
      const blocker = yield* file('Blocker')
      const waiting = yield* file('Waiting')
      yield* blocks(blocker, waiting)
      yield* close(blocker, true)
      const git = yield* askedGit(() => false)
      expect(yield* readyIds(git.onBase)).toEqual([waiting.id])
      expect(yield* Ref.get(git.asked)).toEqual([])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect(
    'frees what an answered question or a done maintainer task blocks, with no branch to ask of',
    () =>
      Effect.gen(function* () {
        const graph = yield* WorkGraph
        const waiting = yield* file('Waiting')
        const question = yield* graph.ask({
          question: {
            title: 'Which database?',
            consequential: false,
            maintainerOnly: false,
            blocks: [waiting.id],
          },
          actor: maintainer,
        })
        const manual = yield* file('Set up the account', { type: 'manual' })
        yield* blocks(manual, waiting)
        expect((yield* why(waiting)).map(describeWait).toSorted()).toEqual(
          [
            `waits on the question ${question.id}: Which database?`,
            `waits for the maintainer task ${manual.id}: Set up the account`,
          ].toSorted(),
        )
        yield* graph.answer({
          id: question.id,
          answer: 'SQLite',
          actor: maintainer,
        })
        yield* graph.close({
          id: manual.id,
          resolution: 'done',
          actor: maintainer,
        })
        const git = yield* askedGit(() => false)
        expect(yield* readyIds(git.onBase)).toEqual([waiting.id])
        expect(yield* Ref.get(git.asked)).toEqual([])
      }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('holds a ticket until the ticket it was filed from merges', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const origin = yield* file('Origin')
      yield* claim(origin)
      const found = yield* discovered(origin, 'Found')
      expect(yield* readyIds()).toEqual([])
      expect(yield* why(found)).toEqual([
        WaitReason.FiledFrom({ origin: origin.id, status: 'in_progress' }),
      ])

      yield* close(origin, false)
      expect(yield* readyIds(noneOnBase)).toEqual([])
      expect(yield* why(found, noneOnBase)).toEqual([
        WaitReason.FiledFrom({ origin: origin.id, status: 'closed' }),
      ])
      expect(yield* readyIds(allOnBase)).toEqual([found.id])

      // Reopened and not running, as orchestra has it, it may never run: it holds nothing.
      yield* graph.reopen({ id: origin.id, actor: maintainer })
      expect(yield* readyIds(noneOnBase)).toEqual([origin.id, found.id])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect(
    'asks git once of each closed blocker, and only for tickets nothing else holds',
    () =>
      Effect.gen(function* () {
        const shared = yield* file('Shared blocker')
        const other = yield* file('Other blocker')
        const first = yield* file('First')
        const second = yield* file('Second')
        const held = yield* file('Held by an open blocker too')
        const open = yield* file('Open blocker')
        yield* blocks(shared, first)
        yield* blocks(shared, second)
        yield* blocks(other, held)
        yield* blocks(open, held)
        yield* close(shared, false)
        yield* close(other, false)
        const git = yield* askedGit(id => id === shared.id)
        expect(yield* readyIds(git.onBase)).toEqual([
          first.id,
          second.id,
          open.id,
        ])
        expect(yield* Ref.get(git.asked)).toEqual([shared.id])
      }).pipe(Effect.provide(graphLayer)),
  )
})

describe('why', () => {
  it.effect('gives every reason at once, its own first', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const blocker = yield* file('Blocker')
      const waiting = yield* file('Waiting')
      yield* blocks(blocker, waiting)
      yield* graph.defer({
        id: waiting.id,
        until: Option.none(),
        actor: maintainer,
      })
      expect(yield* why(waiting, allOnBase, [waiting.id])).toEqual([
        WaitReason.Deferred({ until: Option.none() }),
        WaitReason.SetAside(),
        WaitReason.Blocked({
          blocker: blocker.id,
          type: 'task',
          status: 'open',
          title: 'Blocker',
        }),
      ])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('refuses a ticket that isn’t there', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const ticket = yield* file('Gone')
      yield* graph.delete({ id: ticket.id, actor: maintainer })
      expect(yield* Effect.flip(why(ticket))).toBeInstanceOf(TicketNotFound)
    }).pipe(Effect.provide(graphLayer)),
  )

  it('says each reason in words', () => {
    const words = (reason: WaitReason) => describeWait(reason)
    const blocker = TicketId.make('fa-12')
    expect([
      words(WaitReason.NotOpen({ status: 'in_progress' })),
      words(WaitReason.NotOpen({ status: 'closed' })),
      words(WaitReason.Deferred({ until: Option.none() })),
      words(
        WaitReason.Deferred({
          until: Option.some(DateTime.makeUnsafe(Date.UTC(2026, 9, 30, 9))),
        }),
      ),
      words(WaitReason.NotForWorkers({ type: 'epic' })),
      words(WaitReason.NotForWorkers({ type: 'question' })),
      words(WaitReason.NotForWorkers({ type: 'manual' })),
      words(WaitReason.SetAside()),
      words(
        WaitReason.Blocked({
          blocker: blocker,
          type: 'feature',
          status: 'in_progress',
          title: 'Auth',
        }),
      ),
      words(
        WaitReason.Blocked({
          blocker: blocker,
          type: 'question',
          status: 'open',
          title: 'Which database?',
        }),
      ),
      words(
        WaitReason.Blocked({
          blocker: blocker,
          type: 'manual',
          status: 'open',
          title: 'Set up the account',
        }),
      ),
      words(
        WaitReason.Blocked({
          blocker: blocker,
          type: 'epic',
          status: 'open',
          title: 'M1',
        }),
      ),
      words(WaitReason.ClosedUnmerged({ blocker: blocker })),
      words(
        WaitReason.FiledFrom({
          origin: TicketId.make('fa-3'),
          status: 'in_progress',
        }),
      ),
      words(
        WaitReason.FiledFrom({
          origin: TicketId.make('fa-3'),
          status: 'closed',
        }),
      ),
    ]).toEqual([
      'it is in progress',
      'it is closed',
      'it is deferred',
      'it is deferred until 2026-10-30T09:00:00.000Z',
      'it is an epic: it closes itself once its children are closed and merged',
      'it is a question, for the maintainer to answer',
      'it is a maintainer task, never given to a worker',
      'it was set aside in this run',
      'waits for fa-12 to merge: it is in progress',
      'waits on the question fa-12: Which database?',
      'waits for the maintainer task fa-12: Set up the account',
      'waits for the epic fa-12 to close',
      'waits for fa-12 to merge: it is closed but not merged',
      'waits for fa-3, the ticket it was filed from, to merge',
      'waits for fa-3, the ticket it was filed from, to merge: it is closed but not merged',
    ])
  })
})

describe('epics', () => {
  const closeEpics = (onBase: OnBase) =>
    Effect.flatMap(WorkGraph, graph =>
      Effect.map(graph.closeEpics({ onBase, actor: engineActor }), epics =>
        epics.map(epic => epic.id),
      ),
    )

  it.effect('closes an epic once its children are closed and merged', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const epic = yield* file('M1', { type: 'epic' })
      const one = yield* file('One', { parent: epic.id })
      const two = yield* file('Two', { parent: epic.id })
      const empty = yield* file('M2', { type: 'epic' })
      expect(yield* closeEpics(allOnBase)).toEqual([])

      yield* close(one, true)
      expect(yield* closeEpics(allOnBase)).toEqual([])
      yield* close(two, false)
      expect(yield* closeEpics(noneOnBase)).toEqual([])
      expect(yield* closeEpics(allOnBase)).toEqual([epic.id])

      const closed = yield* graph.show(epic.id)
      expect(closed.ticket.status).toBe('closed')
      expect(closed.ticket.resolution).toEqual(Option.some('done'))
      expect((yield* graph.history(epic.id)).at(-1)?.actor).toEqual(
        Option.some(engineActor),
      )
      // An epic with no children stays open: its breakdown may be still to come.
      expect((yield* graph.show(empty.id)).ticket.status).toBe('open')
      expect(yield* closeEpics(allOnBase)).toEqual([])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('asks git nothing of an epic a child not closed keeps open', () =>
    Effect.gen(function* () {
      const epic = yield* file('M1', { type: 'epic' })
      const closed = yield* file('Closed', { parent: epic.id })
      yield* file('Open', { parent: epic.id })
      yield* close(closed, false)
      const git = yield* askedGit(() => true)
      expect(yield* closeEpics(git.onBase)).toEqual([])
      expect(yield* Ref.get(git.asked)).toEqual([])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('closes an epic of epics in the same call, inner first', () =>
    Effect.gen(function* () {
      const outer = yield* file('Product', { type: 'epic' })
      const inner = yield* file('M1', { type: 'epic', parent: outer.id })
      const leaf = yield* file('Work', { parent: inner.id })
      yield* close(leaf, true)
      expect(yield* closeEpics(allOnBase)).toEqual([inner.id, outer.id])
    }).pipe(Effect.provide(graphLayer)),
  )

  it.effect('frees what a closed epic blocks', () =>
    Effect.gen(function* () {
      const epic = yield* file('M1', { type: 'epic' })
      const child = yield* file('Work', { parent: epic.id })
      const after = yield* file('After M1')
      yield* blocks(epic, after)
      expect((yield* why(after)).map(describeWait)).toEqual([
        `waits for the epic ${epic.id} to close`,
      ])
      yield* close(child, true)
      yield* closeEpics(allOnBase)
      expect(yield* readyIds()).toEqual([after.id])
    }).pipe(Effect.provide(graphLayer)),
  )
})

describe('close', () => {
  it.effect('offers to close the tickets it blocks that aren’t closed', () =>
    Effect.gen(function* () {
      const graph = yield* WorkGraph
      const ticket = yield* file('Superseded')
      const first = yield* file('First', { priority: 1 })
      const second = yield* file('Second')
      const done = yield* file('Done')
      yield* blocks(ticket, second)
      yield* blocks(ticket, first)
      yield* blocks(ticket, done)
      yield* close(done, true)
      const closed = yield* graph.close({
        id: ticket.id,
        resolution: 'superseded',
        actor: maintainer,
      })
      expect(closed.ticket.status).toBe('closed')
      expect(closed.offers.map(offer => offer.id)).toEqual([
        first.id,
        second.id,
      ])
    }).pipe(Effect.provide(graphLayer)),
  )
})
