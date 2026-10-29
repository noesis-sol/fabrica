import { Data, DateTime, Option, Schema } from 'effect'

import {
  type EngineId,
  Ticket,
  type TicketId,
  type TicketStatus,
} from '@fabrica/contracts'

import { CodePoints, sortedUnique } from './code-points'
import {
  type ClockedField,
  type Clocks,
  type FileEdges,
  type RunLease,
  TicketFile,
  type TicketsMeta,
  type Tombstone,
  byClockedField,
  clockedFields,
  fieldTexts,
  notesById,
  ticketFileText,
} from './codec'
import { type Hlc, HlcOrder, later } from './hlc'

// The tickets ref's merge (spec §11.4, §11.7): the engine merges the ref itself, three-way, each
// ticket's file against the merge base. A ticket changed on one side only takes that side; notes are
// unioned by ID; labels and edges merge as sets, adds and removes reconciled against the base; a
// plain field both sides changed goes to the later clock, ties by engine ID; `status` both sides
// changed goes by precedence (closed, in progress, deferred, open), a reopen after a close winning by
// its clock; a claim made under a lease since expired loses to the lease holder's; a deletion against
// an edit loses to the edit. Every field both sides changed to different values, and every deletion
// lost, is a conflict the caller records (a `merge_conflict` event). Pure, and symmetric: swapping the
// sides swaps the conflicts' sides and nothing else.

/** Which side of a merge: the engine's own, or the one fetched. */
export type Side = 'ours' | 'theirs'

/** A ticket as one side of the ref has it: its file, its tombstone, or neither. */
export type Entry = Data.TaggedEnum<{
  Live: { readonly file: TicketFile }
  Deleted: { readonly tombstone: Tombstone }
}>
export const Entry = Data.taggedEnum<Entry>()

/** What a merge resolved that both sides changed; the merged state has the value kept. */
export type MergeConflict = Data.TaggedEnum<{
  /** A field both sides changed: each side's value, as the file encodes it. */
  Field: {
    readonly field: ClockedField
    readonly ours: Schema.Json
    readonly theirs: Schema.Json
  }
  /** One side deleted the ticket, the other edited it: the edit was kept. */
  Deletion: { readonly deletedBy: Side; readonly tombstone: Tombstone }
}>
export const MergeConflict = Data.taggedEnum<MergeConflict>()

/** One side's view of a ticket's field: its value as JSON, its canonical text, its clock. */
type FieldView = {
  readonly json: Schema.Json
  readonly text: string
  readonly clock: Hlc
}

type FieldViews = Record<ClockedField, FieldView>

const fieldViews = (file: TicketFile): FieldViews => {
  const texts = fieldTexts(file.ticket)
  return byClockedField(field => ({
    json: parseJson(texts[field]),
    text: texts[field],
    clock: file.clocks[field],
  }))
}

const parseJson = (text: string): Schema.Json => JSON.parse(text)

const sameView = (a: FieldView, b: FieldView): boolean =>
  a.text === b.text && HlcOrder(a.clock, b.clock) === 0

/** A field's outcome: the side whose value is kept, the clock it is kept at, and a conflict if both changed it. */
type FieldOutcome = {
  readonly side: Side
  readonly clock: Hlc
  readonly conflict: boolean
}

const other = (side: Side): Side => (side === 'ours' ? 'theirs' : 'ours')

/** The side whose clock is later; two identical clocks with different values go to the smaller value, so both sides agree. */
const byClock = (ours: FieldView, theirs: FieldView): Side => {
  const order = HlcOrder(ours.clock, theirs.clock)
  return order !== 0
    ? order > 0
      ? 'ours'
      : 'theirs'
    : CodePoints(ours.text, theirs.text) <= 0
      ? 'ours'
      : 'theirs'
}

/** `status`'s precedence where both sides changed it (spec §11.4). */
const statusRank: Record<TicketStatus, number> = {
  open: 0,
  deferred: 1,
  in_progress: 2,
  closed: 3,
}

type MergeInput = {
  readonly base: Option.Option<TicketFile>
  readonly ours: TicketFile
  readonly theirs: TicketFile
}

/** The ticket's reopen since the base, on one side: its clock, when that side reopened it after the base. */
const reopenSinceBase = (
  side: TicketFile,
  base: Option.Option<TicketFile>,
): Option.Option<Hlc> =>
  Option.filter(
    side.clocks.reopened,
    reopened =>
      !Option.exists(
        Option.flatMap(base, file => file.clocks.reopened),
        baseReopened => HlcOrder(baseReopened, reopened) === 0,
      ),
  )

/** Which side's `status` wins where both changed it: a reopen after the other side's close by its clock, else by precedence. */
const statusWinner = ({ base, ours, theirs }: MergeInput): Side => {
  const reopenBeats = (open: TicketFile, closed: TicketFile): boolean =>
    closed.ticket.status === 'closed' &&
    open.ticket.status !== 'closed' &&
    Option.exists(
      reopenSinceBase(open, base),
      reopened => HlcOrder(reopened, closed.clocks.status) > 0,
    )
  if (reopenBeats(ours, theirs)) return 'ours'
  if (reopenBeats(theirs, ours)) return 'theirs'
  return statusRank[ours.ticket.status] > statusRank[theirs.ticket.status]
    ? 'ours'
    : 'theirs'
}

/**
 * Which side's `assignee` wins where both changed it: with a run lease held, a claim naming another
 * engine (made under a lease since expired) loses to the other side, the holder's claim or its
 * release; else the later clock.
 */
const assigneeWinner = (
  { ours, theirs }: MergeInput,
  holder: Option.Option<EngineId>,
  sides: Record<Side, FieldView>,
): Side => {
  const stale = (file: TicketFile): boolean =>
    Option.exists(holder, engine =>
      Option.exists(file.ticket.assignee, claim => claim.engine !== engine),
    )
  const oursStale = stale(ours)
  return oursStale !== stale(theirs)
    ? oursStale
      ? 'theirs'
      : 'ours'
    : byClock(sides.ours, sides.theirs)
}

/** A set three ways: kept where both sides have it, or where one side added it since the base. */
const mergeSet = <A extends string>(
  base: Option.Option<ReadonlyArray<A>>,
  ours: ReadonlyArray<A>,
  theirs: ReadonlyArray<A>,
): Array<A> =>
  Option.match(base, {
    onNone: () => sortedUnique([...ours, ...theirs]),
    onSome: base => {
      const inBase = new Set(base)
      const inOurs = new Set(ours)
      const inTheirs = new Set(theirs)
      return sortedUnique(
        [...inOurs, ...inTheirs].filter(
          item => (inOurs.has(item) && inTheirs.has(item)) || !inBase.has(item),
        ),
      )
    },
  })

const mergeEdges = (
  base: Option.Option<TicketFile>,
  ours: FileEdges,
  theirs: FileEdges,
): FileEdges => {
  const edges = (kind: keyof FileEdges) =>
    mergeSet(
      Option.map(base, file => file.edges[kind]),
      ours[kind],
      theirs[kind],
    )
  return {
    blocks: edges('blocks'),
    discovered_from: edges('discovered_from'),
    parent: edges('parent'),
    related: edges('related'),
  }
}

/** A ticket file merged, and the fields both sides changed to different values. */
export type MergedTicket = {
  readonly file: TicketFile
  readonly conflicts: ReadonlyArray<MergeConflict>
}

/**
 * Two sides' files of one ticket merged against the base's, if the base had the ticket. `holder` is
 * the engine holding the run lease after the merge, whose claims win.
 */
export const mergeTicketFile = ({
  base,
  ours,
  theirs,
  holder,
}: MergeInput & {
  readonly holder: Option.Option<EngineId>
}): MergedTicket => {
  const input = { base, ours, theirs }
  const files = { ours, theirs }
  const views = { ours: fieldViews(ours), theirs: fieldViews(theirs) }
  const baseViews = Option.map(base, fieldViews)
  const changed = (side: Side, field: ClockedField): boolean =>
    Option.match(baseViews, {
      onNone: () => true,
      onSome: baseViews => !sameView(baseViews[field], views[side][field]),
    })

  const decide = (
    field: ClockedField,
    winner: (views: Record<Side, FieldView>) => Side,
  ): FieldOutcome => {
    const sides = { ours: views.ours[field], theirs: views.theirs[field] }
    const oursChanged = changed('ours', field)
    const theirsChanged = changed('theirs', field)
    if (!(oursChanged && theirsChanged)) {
      const side = theirsChanged ? 'theirs' : 'ours'
      return { side, clock: sides[side].clock, conflict: false }
    }
    const clock = later(sides.ours.clock, sides.theirs.clock)
    return sides.ours.text === sides.theirs.text
      ? { side: byClock(sides.ours, sides.theirs), clock, conflict: false }
      : { side: winner(sides), clock, conflict: true }
  }

  const decided = byClockedField(field =>
    decide(
      field,
      field === 'status'
        ? () => statusWinner(input)
        : field === 'assignee'
          ? sides => assigneeWinner(input, holder, sides)
          : sides => byClock(sides.ours, sides.theirs),
    ),
  )
  // A ticket's resolution and close reason go with the status they were set with.
  const status = decided.status
  const withStatus = status.conflict
    ? {
        ...decided,
        resolution: followOutcome(
          decided.resolution,
          status.side,
          views,
          'resolution',
        ),
        closeReason: followOutcome(
          decided.closeReason,
          status.side,
          views,
          'closeReason',
        ),
      }
    : decided
  // A question's type and its question go together: where they merged apart into a ticket the
  // schema refuses, both come from the side whose type was kept.
  const typeSide = withStatus.type.side
  const apart =
    (files[typeSide].ticket.type === 'question') !==
    Option.isSome(files[withStatus.question.side].ticket.question)
  const settled = apart
    ? {
        ...withStatus,
        question: followOutcome(
          withStatus.question,
          typeSide,
          views,
          'question',
        ),
      }
    : withStatus

  const take = <F extends ClockedField>(field: F): Ticket[F] =>
    files[settled[field].side].ticket[field]
  const clockOf = (field: ClockedField): Hlc => settled[field].clock

  const ticket = new Ticket({
    id: ours.ticket.id,
    type: take('type'),
    title: take('title'),
    description: take('description'),
    design: take('design'),
    acceptance: take('acceptance'),
    status: take('status'),
    resolution: take('resolution'),
    priority: take('priority'),
    deferUntil: take('deferUntil'),
    assignee: take('assignee'),
    model: take('model'),
    metadata: take('metadata'),
    result: take('result'),
    question: take('question'),
    mergedCommit: take('mergedCommit'),
    closeReason: take('closeReason'),
    createdAt: DateTime.min(ours.ticket.createdAt, theirs.ticket.createdAt),
    updatedAt: DateTime.max(ours.ticket.updatedAt, theirs.ticket.updatedAt),
  })
  const clocks: Clocks = {
    type: clockOf('type'),
    title: clockOf('title'),
    description: clockOf('description'),
    design: clockOf('design'),
    acceptance: clockOf('acceptance'),
    status: clockOf('status'),
    resolution: clockOf('resolution'),
    priority: clockOf('priority'),
    deferUntil: clockOf('deferUntil'),
    assignee: clockOf('assignee'),
    model: clockOf('model'),
    metadata: clockOf('metadata'),
    result: clockOf('result'),
    question: clockOf('question'),
    mergedCommit: clockOf('mergedCommit'),
    closeReason: clockOf('closeReason'),
    reopened: laterOption(ours.clocks.reopened, theirs.clocks.reopened),
  }
  const file = new TicketFile({
    ticket,
    labels: mergeSet(
      Option.map(base, file => file.labels),
      ours.labels,
      theirs.labels,
    ),
    edges: mergeEdges(base, ours.edges, theirs.edges),
    notes: notesById([...ours.notes, ...theirs.notes]),
    clocks,
  })
  const conflicts = clockedFields
    .filter(field => settled[field].conflict)
    .map(field =>
      MergeConflict.Field({
        field,
        ours: views.ours[field].json,
        theirs: views.theirs[field].json,
      }),
    )
  return { file, conflicts }
}

/**
 * A field made to follow another's side: the value of `side`, at the later clock; a conflict when
 * the values differ and the side not kept changed it.
 */
const followOutcome = (
  outcome: FieldOutcome,
  side: Side,
  views: Record<Side, FieldViews>,
  field: ClockedField,
): FieldOutcome => {
  const kept = views[side][field]
  const dropped = views[other(side)][field]
  return {
    side,
    clock: later(kept.clock, dropped.clock),
    conflict:
      kept.text !== dropped.text &&
      (outcome.conflict || outcome.side === other(side)),
  }
}

const laterOption = (
  self: Option.Option<Hlc>,
  that: Option.Option<Hlc>,
): Option.Option<Hlc> =>
  Option.isNone(self)
    ? that
    : Option.isNone(that)
      ? self
      : Option.some(later(self.value, that.value))

// --- Entries ---------------------------------------------------------------------------------

const sameEntry = (a: Option.Option<Entry>, b: Option.Option<Entry>): boolean =>
  Option.isNone(a) || Option.isNone(b)
    ? Option.isNone(a) && Option.isNone(b)
    : Entry.$match(a.value, {
        Live: ({ file }) =>
          b.value._tag === 'Live' &&
          ticketFileText(file) === ticketFileText(b.value.file),
        Deleted: ({ tombstone }) =>
          b.value._tag === 'Deleted' &&
          HlcOrder(tombstone.clock, b.value.tombstone.clock) === 0,
      })

/** A ticket's entry merged, and its conflicts. */
export type MergedEntry = {
  readonly entry: Option.Option<Entry>
  readonly conflicts: ReadonlyArray<MergeConflict>
}

/**
 * One ticket merged three ways: its file, its tombstone, or neither, on each side. A side missing a
 * ticket the base has live keeps the base's (only a tombstone deletes a ticket, so a missing file never
 * wipes one); a side missing a tombstone the base has pruned it.
 */
export const mergeEntry = ({
  base,
  ours: oursSeen,
  theirs: theirsSeen,
  holder,
}: {
  readonly base: Option.Option<Entry>
  readonly ours: Option.Option<Entry>
  readonly theirs: Option.Option<Entry>
  readonly holder: Option.Option<EngineId>
}): MergedEntry => {
  const baseLive = Option.filter(base, entry => entry._tag === 'Live')
  const ours = Option.orElse(oursSeen, () => baseLive)
  const theirs = Option.orElse(theirsSeen, () => baseLive)
  if (sameEntry(ours, theirs) || sameEntry(theirs, base))
    return { entry: ours, conflicts: [] }
  if (sameEntry(ours, base)) return { entry: theirs, conflicts: [] }
  // Both sides changed the ticket.
  if (Option.isNone(ours) || Option.isNone(theirs))
    return { entry: Option.orElse(ours, () => theirs), conflicts: [] }
  const deletionLost = (
    live: Entry,
    deletedBy: Side,
    tombstone: Tombstone,
  ): MergedEntry => ({
    entry: Option.some(live),
    conflicts: [MergeConflict.Deletion({ deletedBy, tombstone })],
  })
  return Entry.$match(ours.value, {
    Live: o =>
      Entry.$match(theirs.value, {
        Live: t => {
          const merged = mergeTicketFile({
            base: Option.flatMap(base, entry =>
              entry._tag === 'Live' ? Option.some(entry.file) : Option.none(),
            ),
            ours: o.file,
            theirs: t.file,
            holder,
          })
          return {
            entry: Option.some(Entry.Live({ file: merged.file })),
            conflicts: merged.conflicts,
          }
        },
        // One deleted it, the other edited it: the edit is kept.
        Deleted: t => deletionLost(o, 'theirs', t.tombstone),
      }),
    Deleted: o =>
      Entry.$match(theirs.value, {
        Live: t => deletionLost(t, 'ours', o.tombstone),
        Deleted: t => ({
          entry: Option.some(
            HlcOrder(o.tombstone.clock, t.tombstone.clock) >= 0 ? o : t,
          ),
          conflicts: [],
        }),
      }),
  })
}

// --- The lease and meta.json -----------------------------------------------------------------

const sameLease = (a: RunLease, b: RunLease): boolean =>
  a.engine === b.engine &&
  a.run === b.run &&
  DateTime.Equivalence(a.startedAt, b.startedAt) &&
  DateTime.Equivalence(a.renewedAt, b.renewedAt) &&
  DateTime.Equivalence(a.expiresAt, b.expiresAt) &&
  a.name === b.name &&
  a.host === b.host

const sameOptionalLease = (
  a: Option.Option<RunLease>,
  b: Option.Option<RunLease>,
): boolean =>
  Option.isNone(a) || Option.isNone(b)
    ? Option.isNone(a) && Option.isNone(b)
    : sameLease(a.value, b.value)

/**
 * The run lease merged (spec §11.5). One side's change is kept. Where both changed it: the same run's
 * lease keeps its latest renewal; two runs' leases that cover the same time keep the earlier start
 * (ties by engine ID), and otherwise the later one, taken over after the other expired; a lease removed
 * on one side gives way to a lease another run took on the other.
 */
export const mergeLease = ({
  base,
  ours,
  theirs,
}: {
  readonly base: Option.Option<RunLease>
  readonly ours: Option.Option<RunLease>
  readonly theirs: Option.Option<RunLease>
}): Option.Option<RunLease> => {
  if (sameOptionalLease(theirs, base) || sameOptionalLease(ours, theirs))
    return ours
  if (sameOptionalLease(ours, base)) return theirs
  if (Option.isNone(ours) || Option.isNone(theirs)) {
    // One side removed the lease: it stays removed unless the other side's is another run's.
    const kept = Option.orElse(ours, () => theirs)
    const sameRun = Option.exists(kept, lease =>
      Option.exists(base, removed => removed.run === lease.run),
    )
    return sameRun ? Option.none() : kept
  }
  const o = ours.value
  const t = theirs.value
  if (o.run === t.run && o.engine === t.engine)
    return Option.some(
      DateTime.isGreaterThan(t.renewedAt, o.renewedAt) ||
        (DateTime.Equivalence(t.renewedAt, o.renewedAt) &&
          (DateTime.isGreaterThan(t.expiresAt, o.expiresAt) ||
            (DateTime.Equivalence(t.expiresAt, o.expiresAt) &&
              CodePoints(`${t.name} ${t.host}`, `${o.name} ${o.host}`) < 0)))
        ? t
        : o,
    )
  const overlap =
    DateTime.isLessThan(o.startedAt, t.expiresAt) &&
    DateTime.isLessThan(t.startedAt, o.expiresAt)
  const earlier =
    DateTime.isLessThan(o.startedAt, t.startedAt) ||
    (DateTime.Equivalence(o.startedAt, t.startedAt) &&
      CodePoints(`${o.engine} ${o.run}`, `${t.engine} ${t.run}`) <= 0)
  return Option.some(overlap === earlier ? o : t)
}

/** `meta.json` merged: one side's change; where both changed it, the newer layout, then the prefix first in code point order. */
export const mergeMeta = ({
  base,
  ours,
  theirs,
}: {
  readonly base: Option.Option<TicketsMeta>
  readonly ours: Option.Option<TicketsMeta>
  readonly theirs: Option.Option<TicketsMeta>
}): Option.Option<TicketsMeta> => {
  const same = (a: Option.Option<TicketsMeta>, b: Option.Option<TicketsMeta>) =>
    Option.isNone(a) || Option.isNone(b)
      ? Option.isNone(a) && Option.isNone(b)
      : a.value.layout === b.value.layout && a.value.prefix === b.value.prefix
  if (same(theirs, base) || same(ours, theirs)) return ours
  if (same(ours, base)) return theirs
  if (Option.isNone(ours) || Option.isNone(theirs))
    return Option.orElse(ours, () => theirs)
  const o = ours.value
  const t = theirs.value
  return Option.some(
    o.layout !== t.layout
      ? o.layout > t.layout
        ? o
        : t
      : CodePoints(o.prefix, t.prefix) <= 0
        ? o
        : t,
  )
}

// --- The whole ref ---------------------------------------------------------------------------

/** The tickets ref's state at a commit: `meta.json`, `lease.json`, and each ticket's file or tombstone. */
export type Snapshot = {
  readonly meta: Option.Option<TicketsMeta>
  readonly lease: Option.Option<RunLease>
  readonly entries: ReadonlyMap<TicketId, Entry>
}

/** A conflict on one ticket. */
export type TicketConflict = {
  readonly ticket: TicketId
  readonly conflict: MergeConflict
}

/** The ref merged, and the conflicts the merge resolved, ticket by ticket in code point order. */
export type MergedSnapshot = {
  readonly snapshot: Snapshot
  readonly conflicts: ReadonlyArray<TicketConflict>
}

/** Two sides of the ref merged against their merge base: the lease first, whose holder's claims win, then each ticket. */
export const mergeSnapshots = ({
  base,
  ours,
  theirs,
}: {
  readonly base: Snapshot
  readonly ours: Snapshot
  readonly theirs: Snapshot
}): MergedSnapshot => {
  const lease = mergeLease({
    base: base.lease,
    ours: ours.lease,
    theirs: theirs.lease,
  })
  const holder = Option.map(lease, lease => lease.engine)
  const ids = sortedUnique([
    ...base.entries.keys(),
    ...ours.entries.keys(),
    ...theirs.entries.keys(),
  ])
  const entries = new Map<TicketId, Entry>()
  const conflicts: Array<TicketConflict> = []
  for (const id of ids) {
    const merged = mergeEntry({
      base: Option.fromNullishOr(base.entries.get(id)),
      ours: Option.fromNullishOr(ours.entries.get(id)),
      theirs: Option.fromNullishOr(theirs.entries.get(id)),
      holder,
    })
    if (Option.isSome(merged.entry)) entries.set(id, merged.entry.value)
    for (const conflict of merged.conflicts)
      conflicts.push({ ticket: id, conflict })
  }
  return {
    snapshot: {
      meta: mergeMeta({
        base: base.meta,
        ours: ours.meta,
        theirs: theirs.meta,
      }),
      lease,
      entries,
    },
    conflicts,
  }
}
