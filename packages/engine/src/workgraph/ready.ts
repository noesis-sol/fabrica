import { Data, DateTime, Effect, Option } from 'effect'
import type { SqlClient, SqlError, Statement } from 'effect/sql'

import type {
  Ticket,
  TicketId,
  TicketStatus,
  TicketType,
} from '@fabrica/contracts'

import type { StoreFailed } from './errors'
import { type TicketRow, ticketFromRow } from './rows'

// The ready rule and why a ticket waits (spec §13.3, orchestra's rule): a ticket is ready when it is
// open (or deferred past `defer_until`), a worker's type (not an epic, a question or a maintainer task,
// H52), not set aside in this run, every `blocks` blocker closed and merged, and the ticket it was
// filed from merged. A closed ticket is merged when it has a `merged_commit`, has no branch (its type
// isn't a worker's), or git says its branch is on Base; one git doesn't is CLOSED_UNMERGED
// (orchestra-lx4d.1). As orchestra has it, the ticket it was filed from holds it only while that
// ticket runs or is closed unmerged: one open, not running, may never run. The rule is `ownReasons`
// and `holdOf`; `ready` and `why` both read it, so they never disagree. Queries stay small and
// indexed (§11.2): the open and deferred tickets by `tickets(status, …)`, their prerequisites by the
// edges' keys, and git is asked once for each closed blocker, only of tickets nothing else holds.

/** Whether closed ticket `id`'s work is on Base, as git says: its branch merged, or no branch with work of its own. */
export type OnBase = (id: TicketId) => Effect.Effect<boolean>

/** What the ready rule reads beside the store. */
export interface ReadyOptions {
  /** Asked of each closed blocker with no `merged_commit`; a failure to tell is `false`, not merged. */
  readonly onBase: OnBase
  /** The tickets set aside in this run. */
  readonly setAside?: ReadonlyArray<TicketId>
}

/** Why a ticket isn't ready, one reason each. */
export type WaitReason = Data.TaggedEnum<{
  /** It is being worked on, or done. */
  NotOpen: { readonly status: Exclude<TicketStatus, 'open' | 'deferred'> }
  /** Deferred until a time not yet come, or until undeferred. */
  Deferred: { readonly until: Option.Option<DateTime.Utc> }
  /** Its type is never given to a worker. */
  NotForWorkers: { readonly type: Exclude<TicketType, WorkerType> }
  /** Set aside in this run. */
  SetAside: {}
  /** A `blocks` blocker not closed yet; a question shows its question (H81). */
  Blocked: {
    readonly blocker: TicketId
    readonly type: TicketType
    readonly status: Exclude<TicketStatus, 'closed'>
    readonly title: string
  }
  /** A `blocks` blocker closed, its branch not on Base (CLOSED_UNMERGED). */
  ClosedUnmerged: { readonly blocker: TicketId }
  /** The ticket it was filed from, running or closed unmerged. */
  FiledFrom: {
    readonly origin: TicketId
    readonly status: 'in_progress' | 'closed'
  }
}>
export const WaitReason = Data.taggedEnum<WaitReason>()

/** A reason in words, as the log and the console say it (H81). */
export const describeWait: (reason: WaitReason) => string = WaitReason.$match({
  NotOpen: ({ status }) =>
    status === 'closed' ? 'it is closed' : 'it is in progress',
  Deferred: ({ until }) =>
    Option.match(until, {
      onNone: () => 'it is deferred',
      onSome: at => `it is deferred until ${DateTime.formatIso(at)}`,
    }),
  NotForWorkers: ({ type }) => notForWorkersWords[type],
  SetAside: () => 'it was set aside in this run',
  Blocked: ({ blocker, type, status, title }) =>
    type === 'question'
      ? `waits on the question ${blocker}: ${title}`
      : type === 'manual'
        ? `waits for the maintainer task ${blocker}: ${title}`
        : type === 'epic'
          ? `waits for the epic ${blocker} to close`
          : `waits for ${blocker} to merge: it is ${statusWords[status]}`,
  ClosedUnmerged: ({ blocker }) =>
    `waits for ${blocker} to merge: it is closed but not merged`,
  FiledFrom: ({ origin, status }) =>
    status === 'closed'
      ? `waits for ${origin}, the ticket it was filed from, to merge: it is closed but not merged`
      : `waits for ${origin}, the ticket it was filed from, to merge`,
})

const notForWorkersWords: Record<Exclude<TicketType, WorkerType>, string> = {
  epic: 'it is an epic: it closes itself once its children are closed and merged',
  question: 'it is a question, for the maintainer to answer',
  manual: 'it is a maintainer task, never given to a worker',
}

const statusWords: Record<Exclude<TicketStatus, 'closed'>, string> = {
  open: 'open',
  in_progress: 'in progress',
  deferred: 'deferred',
}

/** The types a worker is given; the others are never dispatched and have no branch. */
type WorkerType = 'task' | 'bug' | 'feature' | 'chore'

const isWorkerType = (type: TicketType): type is WorkerType =>
  type === 'task' || type === 'bug' || type === 'feature' || type === 'chore'

/** How far a ticket's work has come, as its row says: not closed, merged, or closed with only git to say. */
type Progress = 'unfinished' | 'merged' | 'asks_git'

const progressOf = (ticket: Ticket): Progress =>
  ticket.status !== 'closed'
    ? 'unfinished'
    : Option.isSome(ticket.mergedCommit) || !isWorkerType(ticket.type)
      ? 'merged'
      : 'asks_git'

/** Whether the ticket counts as open: open, or deferred until a time that has come. `claim` takes such a ticket. */
export const isDueOpen = (ticket: Ticket, now: DateTime.Utc): boolean =>
  ticket.status === 'open' ||
  (ticket.status === 'deferred' &&
    Option.match(ticket.deferUntil, {
      onNone: () => false,
      onSome: until => DateTime.isLessThanOrEqualTo(until, now),
    }))

/** The reasons of the ticket's own: its status, its type, whether this run set it aside. */
const ownReasons = (
  ticket: Ticket,
  now: DateTime.Utc,
  setAside: ReadonlySet<TicketId>,
): ReadonlyArray<WaitReason> => [
  ...(ticket.status === 'in_progress' || ticket.status === 'closed'
    ? [WaitReason.NotOpen({ status: ticket.status })]
    : []),
  ...(ticket.status === 'deferred' && !isDueOpen(ticket, now)
    ? [WaitReason.Deferred({ until: ticket.deferUntil })]
    : []),
  ...(isWorkerType(ticket.type)
    ? []
    : [WaitReason.NotForWorkers({ type: ticket.type })]),
  ...(setAside.has(ticket.id) ? [WaitReason.SetAside()] : []),
]

/** A ticket another must merge before it: a `blocks` blocker, or the ticket it was filed from. */
interface Prerequisite {
  readonly link: 'blocks' | 'discovered_from'
  readonly ticket: Ticket
}

/** What a prerequisite holds the ticket back with: nothing, a reason, or a reason unless git says its branch is on Base. */
type Hold = Data.TaggedEnum<{
  Free: {}
  Waits: { readonly reason: WaitReason }
  AsksGit: { readonly id: TicketId; readonly reason: WaitReason }
}>
const Hold = Data.taggedEnum<Hold>()

const holdOf = ({ link, ticket }: Prerequisite): Hold => {
  const progress = progressOf(ticket)
  if (progress === 'merged') return Hold.Free()
  if (link === 'blocks') {
    return ticket.status === 'closed'
      ? Hold.AsksGit({
          id: ticket.id,
          reason: WaitReason.ClosedUnmerged({ blocker: ticket.id }),
        })
      : Hold.Waits({
          reason: WaitReason.Blocked({
            blocker: ticket.id,
            type: ticket.type,
            status: ticket.status,
            title: ticket.title,
          }),
        })
  }
  if (ticket.status === 'closed') {
    return Hold.AsksGit({
      id: ticket.id,
      reason: WaitReason.FiledFrom({ origin: ticket.id, status: 'closed' }),
    })
  }
  return ticket.status === 'in_progress'
    ? Hold.Waits({
        reason: WaitReason.FiledFrom({
          origin: ticket.id,
          status: 'in_progress',
        }),
      })
    : Hold.Free()
}

/** The tickets of `holds` git is to be asked of. */
const asksGit = (holds: ReadonlyArray<Hold>): ReadonlyArray<TicketId> =>
  holds.flatMap(hold => (hold._tag === 'AsksGit' ? [hold.id] : []))

/** Asks git of each ticket once, side by side: whether its branch is on Base, by ID. */
const askGit = (
  onBase: OnBase,
  ids: Iterable<TicketId>,
): Effect.Effect<ReadonlyMap<TicketId, boolean>> => {
  const distinct = [...new Set(ids)]
  return Effect.map(
    Effect.forEach(distinct, onBase, { concurrency: 'unbounded' }),
    answers => new Map(distinct.map((id, n) => [id, answers[n] === true])),
  )
}

/** The reasons the holds give, git's answers taken: an `AsksGit` whose branch is on Base gives none. */
const holdReasons = (
  holds: ReadonlyArray<Hold>,
  onBase: ReadonlyMap<TicketId, boolean>,
): ReadonlyArray<WaitReason> =>
  holds.flatMap(
    Hold.$match({
      Free: () => [],
      Waits: ({ reason }) => [reason],
      AsksGit: ({ id, reason }) => (onBase.get(id) === true ? [] : [reason]),
    }),
  )

type Read<A> = Effect.Effect<A, SqlError.SqlError | StoreFailed>

/** The tickets that may be ready, as `tickets(status, priority, created_at)` gives them: the rule decides the rest. */
const candidateClause = (sql: SqlClient.SqlClient) =>
  sql`status IN ('open', 'deferred')`

type PrerequisiteRow = TicketRow & {
  readonly waiting: string
  readonly link: Prerequisite['link']
}

/** The prerequisites of the tickets `waiting` selects (a subquery of IDs), by the waiting ticket's ID. */
const prerequisitesOf = (
  sql: SqlClient.SqlClient,
  waiting: Statement.Fragment,
): Read<ReadonlyMap<string, ReadonlyArray<Prerequisite>>> =>
  Effect.gen(function* () {
    const rows = yield* sql<PrerequisiteRow>`
      SELECT edges.to_id AS waiting, 'blocks' AS link, tickets.* FROM edges
        JOIN tickets ON tickets.id = edges.from_id
        WHERE edges.kind = 'blocks' AND edges.to_id IN (SELECT id FROM tickets WHERE ${waiting})
      UNION ALL
      SELECT edges.from_id AS waiting, 'discovered_from' AS link, tickets.* FROM edges
        JOIN tickets ON tickets.id = edges.to_id
        WHERE edges.kind = 'discovered_from' AND edges.from_id IN (SELECT id FROM tickets WHERE ${waiting})
      ORDER BY waiting, link, id`
    const byTicket = new Map<string, Array<Prerequisite>>()
    for (const row of rows) {
      const prerequisite = { link: row.link, ticket: yield* ticketFromRow(row) }
      const known = byTicket.get(row.waiting)
      if (known === undefined) byTicket.set(row.waiting, [prerequisite])
      else known.push(prerequisite)
    }
    return byTicket
  })

/** The tickets ready to dispatch, most urgent first, then oldest. */
export const readyTickets = (
  sql: SqlClient.SqlClient,
  options: ReadyOptions,
): Read<ReadonlyArray<Ticket>> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now
    const setAside = new Set(options.setAside ?? [])
    const rows =
      yield* sql<TicketRow>`SELECT * FROM tickets WHERE ${candidateClause(sql)} ORDER BY priority, created_at, id`
    const tickets = yield* Effect.forEach(rows, ticketFromRow)
    const open = tickets.filter(
      ticket => ownReasons(ticket, now, setAside).length === 0,
    )
    if (open.length === 0) return []
    const prerequisites = yield* prerequisitesOf(sql, candidateClause(sql))
    const held = open.flatMap(ticket => {
      const holds = (prerequisites.get(ticket.id) ?? []).map(holdOf)
      return holds.some(hold => hold._tag === 'Waits')
        ? []
        : [{ ticket, holds }]
    })
    const onBase = yield* askGit(
      options.onBase,
      held.flatMap(({ holds }) => asksGit(holds)),
    )
    return held.flatMap(({ ticket, holds }) =>
      holdReasons(holds, onBase).length === 0 ? [ticket] : [],
    )
  })

/** Each reason the ticket isn't ready, its own first, then its blockers', then the ticket it was filed from; none when it is. */
export const whyWaiting = (
  sql: SqlClient.SqlClient,
  ticket: Ticket,
  options: ReadyOptions,
): Read<ReadonlyArray<WaitReason>> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now
    const prerequisites = yield* prerequisitesOf(sql, sql`id = ${ticket.id}`)
    const holds = (prerequisites.get(ticket.id) ?? []).map(holdOf)
    const onBase = yield* askGit(options.onBase, asksGit(holds))
    return [
      ...ownReasons(ticket, now, new Set(options.setAside ?? [])),
      ...holdReasons(holds, onBase),
    ]
  })

type ChildRow = TicketRow & { readonly parent: string }

/** The epics not closed that have children, as `tickets(status, …)` gives them. */
const openEpicClause = (sql: SqlClient.SqlClient) =>
  sql`status IN ('open', 'in_progress', 'deferred') AND type = 'epic'`

/**
 * The epics whose children are all closed and merged, each after the epics among its children that
 * close with it: an epic with no children stays open, as its breakdown may be still to come.
 */
export const finishedEpics = (
  sql: SqlClient.SqlClient,
  onBase: OnBase,
): Read<ReadonlyArray<Ticket>> =>
  Effect.gen(function* () {
    const [epicRows, childRows] = yield* Effect.all([
      sql<TicketRow>`SELECT * FROM tickets WHERE ${openEpicClause(sql)} ORDER BY priority, created_at, id`,
      sql<ChildRow>`SELECT edges.from_id AS parent, tickets.* FROM edges
        JOIN tickets ON tickets.id = edges.to_id
        WHERE edges.kind = 'parent' AND edges.from_id IN (SELECT id FROM tickets WHERE ${openEpicClause(sql)})
        ORDER BY parent, id`,
    ])
    const epics = yield* Effect.forEach(epicRows, ticketFromRow)
    const children = new Map<string, Array<Ticket>>()
    for (const row of childRows) {
      const child = yield* ticketFromRow(row)
      const known = children.get(row.parent)
      if (known === undefined) children.set(row.parent, [child])
      else known.push(child)
    }
    // Git is asked only of the children of epics nothing else keeps open: a child not closed keeps
    // its epic open, unless it is an epic that may close in this call.
    const merged = yield* askGit(
      onBase,
      [...children.values()]
        .filter(each =>
          each.every(
            child =>
              progressOf(child) !== 'unfinished' || child.type === 'epic',
          ),
        )
        .flat()
        .flatMap(child => (progressOf(child) === 'asks_git' ? [child.id] : [])),
    )
    const closing: Array<Ticket> = []
    const closes = new Set<TicketId>()
    const done = (child: Ticket) => {
      const progress = progressOf(child)
      return progress === 'merged'
        ? true
        : progress === 'asks_git'
          ? merged.get(child.id) === true
          : closes.has(child.id)
    }
    // An epic closing makes its parent's child merged: go round until a round closes none.
    let changed = true
    while (changed) {
      changed = false
      for (const epic of epics) {
        const each = children.get(epic.id) ?? []
        if (closes.has(epic.id) || each.length === 0 || !each.every(done))
          continue
        closes.add(epic.id)
        closing.push(epic)
        changed = true
      }
    }
    return closing
  })

/** The tickets `id` blocks that aren't closed: what closing it offers to close with it (§11.1). */
export const blockedTickets = (
  sql: SqlClient.SqlClient,
  id: TicketId,
): Read<ReadonlyArray<Ticket>> =>
  Effect.flatMap(
    sql<TicketRow>`SELECT tickets.* FROM edges JOIN tickets ON tickets.id = edges.to_id
      WHERE edges.from_id = ${id} AND edges.kind = 'blocks' AND tickets.status != 'closed'
      ORDER BY tickets.priority, tickets.created_at, tickets.id`,
    rows => Effect.forEach(rows, ticketFromRow),
  )
