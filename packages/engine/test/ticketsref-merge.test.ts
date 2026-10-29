import { DateTime, Effect, Option } from 'effect'
import * as fc from 'fast-check'

import { describe, expect, it } from '@effect/vitest'
import {
  Assignee,
  EngineId,
  LabelName,
  Note,
  NoteId,
  RunId,
  SessionId,
  Ticket,
  TicketId,
  type TicketStatus,
} from '@fabrica/contracts'

import {
  type ClockedField,
  Entry,
  Hlc,
  HlcOrder,
  MergeConflict,
  RunLease,
  type Snapshot,
  TicketFile,
  Tombstone,
  byClockedField,
  clockedFields,
  decodeTicketFile,
  encodeTicketFile,
  mergeEntry,
  mergeLease,
  mergeSnapshots,
  mergeTicketFile,
  ticketFileText,
} from '../src/ticketsref'
import {
  baseArb,
  editArb,
  engineArb,
  hlcArb,
  subject,
  threeWayArb,
} from './ticketsref-arbitraries'

// The tickets ref's three-way merge (spec §11.4, §11.7), property-tested (§24): symmetric, merging
// with the base changes nothing, no note is lost, the merged clocks never run behind either side's;
// and each rule by example: one side's change, plain fields by clock and engine ID, status by
// precedence and a reopen by its clock, a claim under an expired lease losing, labels and edges as
// sets, a deletion against an edit losing with a conflict, the run lease.

const text = ticketFileText

const swapped = (conflict: MergeConflict): MergeConflict =>
  MergeConflict.$match(conflict, {
    Field: ({ field, ours, theirs }) =>
      MergeConflict.Field({ field, ours: theirs, theirs: ours }),
    Deletion: ({ deletedBy, tombstone }) =>
      MergeConflict.Deletion({
        deletedBy: deletedBy === 'ours' ? 'theirs' : 'ours',
        tombstone,
      }),
  })

describe('the merge of a ticket file (properties)', () => {
  it('is symmetric: swapping the sides swaps the conflicts and nothing else', () => {
    fc.assert(
      fc.property(threeWayArb, ({ base, ours, theirs, holder }) => {
        for (const withBase of [Option.some(base), Option.none()]) {
          const one = mergeTicketFile({ base: withBase, ours, theirs, holder })
          const other = mergeTicketFile({
            base: withBase,
            ours: theirs,
            theirs: ours,
            holder,
          })
          expect(text(one.file)).toBe(text(other.file))
          expect(one.conflicts).toEqual(other.conflicts.map(swapped))
        }
      }),
    )
  })

  it('changes nothing when one side is the base', () => {
    fc.assert(
      fc.property(threeWayArb, ({ base, ours, holder }) => {
        const mine = mergeTicketFile({
          base: Option.some(base),
          ours,
          theirs: base,
          holder,
        })
        expect(text(mine.file)).toBe(text(ours))
        expect(mine.conflicts).toEqual([])
        const fetched = mergeTicketFile({
          base: Option.some(base),
          ours: base,
          theirs: ours,
          holder,
        })
        expect(text(fetched.file)).toBe(text(ours))
        expect(fetched.conflicts).toEqual([])
      }),
    )
  })

  it('is idempotent: a side merged with itself is itself', () => {
    fc.assert(
      fc.property(threeWayArb, ({ base, ours, holder }) => {
        const merged = mergeTicketFile({
          base: Option.some(base),
          ours,
          theirs: ours,
          holder,
        })
        expect(text(merged.file)).toBe(text(ours))
        expect(merged.conflicts).toEqual([])
      }),
    )
  })

  it('loses no note, and keeps every clock at the later of the two sides', () => {
    fc.assert(
      fc.property(threeWayArb, ({ base, ours, theirs, holder }) => {
        const { file } = mergeTicketFile({
          base: Option.some(base),
          ours,
          theirs,
          holder,
        })
        const kept = new Set(file.notes.map(note => note.id))
        for (const note of [...ours.notes, ...theirs.notes])
          expect(kept.has(note.id)).toBe(true)
        for (const field of clockedFields) {
          expect(
            HlcOrder(file.clocks[field], ours.clocks[field]),
          ).toBeGreaterThanOrEqual(0)
          expect(
            HlcOrder(file.clocks[field], theirs.clocks[field]),
          ).toBeGreaterThanOrEqual(0)
        }
      }),
    )
  })

  it('keeps a field one side changed, and records a conflict only where both changed it', () => {
    fc.assert(
      fc.property(threeWayArb, ({ base, ours, theirs, holder }) => {
        const { file, conflicts } = mergeTicketFile({
          base: Option.some(base),
          ours,
          theirs,
          holder,
        })
        const followers = new Set<ClockedField>([
          'resolution',
          'closeReason',
          'question',
        ])
        const changed = (side: TicketFile, field: ClockedField) =>
          HlcOrder(side.clocks[field], base.clocks[field]) !== 0
        const conflicted = new Set(
          conflicts.flatMap(conflict =>
            conflict._tag === 'Field' ? [conflict.field] : [],
          ),
        )
        for (const field of clockedFields) {
          const oursChanged = changed(ours, field)
          const theirsChanged = changed(theirs, field)
          // A field taken along with another (a close's resolution and reason with its status, a
          // question with its type) may give up a change only one side made, and says so.
          if (conflicted.has(field))
            expect(
              (oursChanged && theirsChanged) ||
                ((oursChanged || theirsChanged) && followers.has(field)),
            ).toBe(true)
          if (oursChanged && !theirsChanged && !conflicted.has(field))
            expect(HlcOrder(file.clocks[field], ours.clocks[field])).toBe(0)
        }
      }),
    )
  })

  it('makes a file that encodes and decodes back to itself', () => {
    fc.assert(
      fc.property(threeWayArb, ({ base, ours, theirs, holder }) => {
        const { file } = mergeTicketFile({
          base: Option.some(base),
          ours,
          theirs,
          holder,
        })
        const decoded = Effect.runSync(
          decodeTicketFile(Effect.runSync(encodeTicketFile(file))),
        )
        expect(text(decoded)).toBe(text(file))
      }),
    )
  })
})

// --- Examples ---------------------------------------------------------------------------------

const fa = EngineId.make('fe-a')
const fb = EngineId.make('fe-b')
const hlc = (wall: number, engine: EngineId, counter = 0) =>
  new Hlc({ wall, counter, engine })
const at = DateTime.makeUnsafe('2026-10-29T12:00:00.000Z')
const label = (name: string) => LabelName.make(name)
const id = (text: string) => TicketId.make(text)

/** The base ticket: open, unassigned, its every field last changed at 100 on fe-a. */
const baseFile = new TicketFile({
  ticket: new Ticket({
    id: subject,
    type: 'task',
    title: 'The base title',
    description: Option.none(),
    design: Option.none(),
    acceptance: Option.none(),
    status: 'open',
    resolution: Option.none(),
    priority: 2,
    deferUntil: Option.none(),
    assignee: Option.none(),
    model: Option.none(),
    metadata: {
      files: Option.none(),
      spec: Option.none(),
      predicted_files: Option.none(),
      result_kind: Option.none(),
    },
    result: Option.none(),
    question: Option.none(),
    mergedCommit: Option.none(),
    closeReason: Option.none(),
    createdAt: at,
    updatedAt: at,
  }),
  labels: [label('a'), label('b')],
  edges: {
    blocks: [id('fa-a1')],
    discovered_from: [],
    parent: [],
    related: [],
  },
  notes: [],
  clocks: { ...byClockedField(() => hlc(100, fa)), reopened: Option.none() },
})

/** `file` with `changes` to its ticket, each changed field at `clock`, and its lists as `lists` has them. */
const edited = (
  file: TicketFile,
  clock: Hlc,
  changes: Partial<Pick<Ticket, ClockedField>>,
  lists: Partial<Pick<TicketFile, 'labels' | 'edges' | 'notes'>> & {
    readonly reopened?: Hlc
  } = {},
): TicketFile =>
  new TicketFile({
    ticket: new Ticket({ ...file.ticket, ...changes }),
    labels: lists.labels ?? file.labels,
    edges: lists.edges ?? file.edges,
    notes: lists.notes ?? file.notes,
    clocks: {
      ...byClockedField(field =>
        Object.hasOwn(changes, field) ? clock : file.clocks[field],
      ),
      reopened:
        lists.reopened === undefined
          ? file.clocks.reopened
          : Option.some(lists.reopened),
    },
  })

const merge = (
  ours: TicketFile,
  theirs: TicketFile,
  holder: Option.Option<EngineId> = Option.none(),
) => mergeTicketFile({ base: Option.some(baseFile), ours, theirs, holder })

describe('the merge of a ticket file (examples)', () => {
  it('takes a change made on one side only, whatever its clock', () => {
    const ours = edited(baseFile, hlc(150, fa), { title: 'Ours' })
    const theirs = edited(baseFile, hlc(900, fb), { priority: 0 })
    const { file, conflicts } = merge(ours, theirs)
    expect(file.ticket.title).toBe('Ours')
    expect(file.ticket.priority).toBe(0)
    expect(file.clocks.title).toEqual(hlc(150, fa))
    expect(file.clocks.priority).toEqual(hlc(900, fb))
    expect(conflicts).toEqual([])
  })

  it('gives a plain field both changed to the later clock, a tie to the later engine ID, and records the conflict', () => {
    const ours = edited(baseFile, hlc(300, fa), { title: 'Ours' })
    const theirs = edited(baseFile, hlc(200, fb), { title: 'Theirs' })
    const { file, conflicts } = merge(ours, theirs)
    expect(file.ticket.title).toBe('Ours')
    expect(file.clocks.title).toEqual(hlc(300, fa))
    expect(conflicts).toEqual([
      MergeConflict.Field({ field: 'title', ours: 'Ours', theirs: 'Theirs' }),
    ])
    // Same wall time and counter: fe-b sorts after fe-a.
    const tie = merge(
      edited(baseFile, hlc(300, fa), { title: 'Ours' }),
      edited(baseFile, hlc(300, fb), { title: 'Theirs' }),
    )
    expect(tie.file.ticket.title).toBe('Theirs')
    // A counter orders two changes in one millisecond.
    const counted = merge(
      edited(baseFile, hlc(300, fa, 2), { title: 'Ours' }),
      edited(baseFile, hlc(300, fb, 1), { title: 'Theirs' }),
    )
    expect(counted.file.ticket.title).toBe('Ours')
  })

  it('records no conflict where both made the same change', () => {
    const { file, conflicts } = merge(
      edited(baseFile, hlc(300, fa), { priority: 1 }),
      edited(baseFile, hlc(200, fb), { priority: 1 }),
    )
    expect(file.ticket.priority).toBe(1)
    expect(file.clocks.priority).toEqual(hlc(300, fa))
    expect(conflicts).toEqual([])
  })

  it('gives status both changed by precedence: closed, in progress, deferred, open', () => {
    const order: ReadonlyArray<TicketStatus> = [
      'closed',
      'in_progress',
      'deferred',
    ]
    const inProgress = edited(baseFile, hlc(150, fa), { status: 'in_progress' })
    for (const [higher, lower] of [
      ['closed', 'in_progress'],
      ['in_progress', 'deferred'],
      ['closed', 'deferred'],
    ] as const) {
      expect(order.indexOf(higher)).toBeLessThan(order.indexOf(lower))
      // The lower status at the later clock still loses.
      const { file } = merge(
        edited(inProgress, hlc(200, fa), { status: higher }),
        edited(inProgress, hlc(900, fb), { status: lower }),
      )
      expect(file.ticket.status).toBe(higher)
    }
    // Released (back to open) on one side, deferred on the other: deferred.
    const released = mergeTicketFile({
      base: Option.some(inProgress),
      ours: edited(inProgress, hlc(900, fa), { status: 'open' }),
      theirs: edited(inProgress, hlc(200, fb), { status: 'deferred' }),
      holder: Option.none(),
    })
    expect(released.file.ticket.status).toBe('deferred')
  })

  it("takes a close's resolution and reason with its status", () => {
    const { file, conflicts } = merge(
      edited(baseFile, hlc(200, fa), {
        status: 'closed',
        resolution: Option.some('done'),
        closeReason: Option.some('merged'),
      }),
      edited(baseFile, hlc(900, fb), {
        status: 'in_progress',
        closeReason: Option.some('their reason'),
      }),
    )
    expect(file.ticket.status).toBe('closed')
    expect(file.ticket.resolution).toEqual(Option.some('done'))
    expect(file.ticket.closeReason).toEqual(Option.some('merged'))
    expect(
      conflicts.map(conflict => conflict._tag === 'Field' && conflict.field),
    ).toEqual(['status', 'closeReason'])
  })

  it("lets a reopen after a close win over the other side's close by its clock", () => {
    const inProgress = edited(baseFile, hlc(150, fa), { status: 'in_progress' })
    const closedEarly = edited(inProgress, hlc(200, fa), { status: 'closed' })
    const reopenedAt = (wall: number) =>
      edited(
        closedEarly,
        hlc(wall, fa),
        { status: 'open' },
        {
          reopened: hlc(wall, fa),
        },
      )
    const closedThere = edited(inProgress, hlc(500, fb), { status: 'closed' })
    const later = mergeTicketFile({
      base: Option.some(inProgress),
      ours: reopenedAt(600),
      theirs: closedThere,
      holder: Option.none(),
    })
    expect(later.file.ticket.status).toBe('open')
    expect(later.file.clocks.reopened).toEqual(Option.some(hlc(600, fa)))
    const earlier = mergeTicketFile({
      base: Option.some(inProgress),
      ours: reopenedAt(400),
      theirs: closedThere,
      holder: Option.none(),
    })
    expect(earlier.file.ticket.status).toBe('closed')
  })

  it("gives a claim made under an expired lease to the lease holder's claim", () => {
    const claim = (engine: EngineId, session: string) =>
      Option.some(new Assignee({ engine, session: SessionId.make(session) }))
    const stale = edited(baseFile, hlc(900, fa), { assignee: claim(fa, 's-1') })
    const holders = edited(baseFile, hlc(200, fb), {
      assignee: claim(fb, 's-2'),
    })
    expect(merge(stale, holders, Option.some(fb)).file.ticket.assignee).toEqual(
      claim(fb, 's-2'),
    )
    expect(merge(holders, stale, Option.some(fb)).file.ticket.assignee).toEqual(
      claim(fb, 's-2'),
    )
    // With no lease held, the later clock.
    expect(merge(stale, holders).file.ticket.assignee).toEqual(claim(fa, 's-1'))
    // The holder's release, at the earlier clock, beats a claim under an expired lease too.
    const claimed = edited(baseFile, hlc(100, fb), {
      assignee: claim(fb, 's-2'),
    })
    for (const [ours, theirs] of [
      [
        edited(claimed, hlc(1500, fb), { assignee: Option.none() }),
        edited(claimed, hlc(2000, fa), { assignee: claim(fa, 's-1') }),
      ],
      [
        edited(claimed, hlc(2000, fa), { assignee: claim(fa, 's-1') }),
        edited(claimed, hlc(1500, fb), { assignee: Option.none() }),
      ],
    ] as const) {
      const released = mergeTicketFile({
        base: Option.some(claimed),
        ours,
        theirs,
        holder: Option.some(fb),
      })
      expect(released.file.ticket.assignee).toEqual(Option.none())
    }
    // And a release written under an expired lease loses to the holder's claim.
    const claimedByA = edited(baseFile, hlc(100, fa), {
      status: 'in_progress',
      assignee: claim(fa, 's-1'),
    })
    for (const [ours, theirs] of [
      [
        edited(claimedByA, hlc(1000, fb), { assignee: claim(fb, 's-2') }),
        edited(claimedByA, hlc(2000, fa), { assignee: Option.none() }),
      ],
      [
        edited(claimedByA, hlc(2000, fa), { assignee: Option.none() }),
        edited(claimedByA, hlc(1000, fb), { assignee: claim(fb, 's-2') }),
      ],
    ] as const) {
      const reclaimed = mergeTicketFile({
        base: Option.some(claimedByA),
        ours,
        theirs,
        holder: Option.some(fb),
      })
      expect(reclaimed.file.ticket.assignee).toEqual(claim(fb, 's-2'))
    }
  })

  it('merges labels and edges as sets against the base', () => {
    const ours = edited(
      baseFile,
      hlc(200, fa),
      {},
      {
        labels: [label('b'), label('c')],
        edges: { ...baseFile.edges, blocks: [] },
      },
    )
    const theirs = edited(
      baseFile,
      hlc(200, fb),
      {},
      {
        labels: [label('a'), label('b'), label('d')],
        edges: { ...baseFile.edges, blocks: [id('fa-a1'), id('fa-b2')] },
      },
    )
    const { file } = merge(ours, theirs)
    expect(file.labels).toEqual([label('b'), label('c'), label('d')])
    expect(file.edges.blocks).toEqual([id('fa-b2')])
    // With no base (the ticket made on both sides, by two imports), the union.
    const twoWay = mergeTicketFile({
      base: Option.none(),
      ours,
      theirs,
      holder: Option.none(),
    })
    expect(twoWay.file.labels).toEqual([
      label('a'),
      label('b'),
      label('c'),
      label('d'),
    ])
  })

  it('unions notes by ID', () => {
    const note = (noteId: string, body: string) =>
      new Note({
        id: NoteId.make(noteId),
        ticketId: subject,
        author: { _tag: 'maintainer' },
        body,
        at,
      })
    const ours = edited(
      baseFile,
      hlc(200, fa),
      {},
      {
        notes: [note('n-1', 'one'), note('n-2', 'two')],
      },
    )
    const theirs = edited(
      baseFile,
      hlc(200, fb),
      {},
      {
        notes: [note('n-2', 'two'), note('n-3', 'three')],
      },
    )
    expect(merge(ours, theirs).file.notes.map(note => note.id)).toEqual([
      'n-1',
      'n-2',
      'n-3',
    ])
  })

  it('keeps a question with its type', () => {
    fc.assert(
      fc.property(
        baseArb.chain(base =>
          fc.tuple(fc.constant(base), editArb(base), editArb(base), engineArb),
        ),
        ([base, ours, theirs, holder]) => {
          const { file } = mergeTicketFile({
            base: Option.some(base),
            ours,
            theirs,
            holder: Option.some(holder),
          })
          expect(file.ticket.type === 'question').toBe(
            Option.isSome(file.ticket.question),
          )
        },
      ),
    )
  })
})

describe('the merge of a ticket entry', () => {
  const tombstone = (wall: number, engine: EngineId) =>
    new Tombstone({ id: subject, clock: hlc(wall, engine) })
  const live = (file: TicketFile) => Option.some(Entry.Live({ file }))
  const deleted = (wall: number, engine: EngineId) =>
    Option.some(Entry.Deleted({ tombstone: tombstone(wall, engine) }))
  const none = Option.none<Entry>()
  const mergeOf = (
    base: Option.Option<Entry>,
    ours: Option.Option<Entry>,
    theirs: Option.Option<Entry>,
  ) => mergeEntry({ base, ours, theirs, holder: Option.none() })

  it('keeps an edit against a deletion, with a conflict', () => {
    const edit = edited(baseFile, hlc(200, fb), { title: 'Edited' })
    const merged = mergeOf(live(baseFile), deleted(300, fa), live(edit))
    expect(merged.entry).toEqual(live(edit))
    expect(merged.conflicts).toEqual([
      MergeConflict.Deletion({
        deletedBy: 'ours',
        tombstone: tombstone(300, fa),
      }),
    ])
  })

  it("deletes a ticket the other side didn't change", () => {
    const merged = mergeOf(live(baseFile), live(baseFile), deleted(300, fa))
    expect(merged.entry).toEqual(deleted(300, fa))
    expect(merged.conflicts).toEqual([])
  })

  it('never removes a ticket for a missing file', () => {
    const edit = edited(baseFile, hlc(200, fb), { title: 'Edited' })
    expect(mergeOf(live(baseFile), none, live(baseFile)).entry).toEqual(
      live(baseFile),
    )
    expect(mergeOf(live(baseFile), none, live(edit)).entry).toEqual(live(edit))
  })

  it('keeps the later of two deletions, and lets a pruned tombstone go', () => {
    expect(
      mergeOf(live(baseFile), deleted(300, fa), deleted(200, fb)).entry,
    ).toEqual(deleted(300, fa))
    expect(mergeOf(deleted(300, fa), none, deleted(300, fa)).entry).toEqual(
      none,
    )
  })

  it('is symmetric, and changes nothing merged with the base (properties)', () => {
    const entryArb = (base: TicketFile) =>
      fc.oneof(
        fc.constant(none),
        fc.constant(live(base)),
        editArb(base).map(live),
        hlcArb.map(clock =>
          Option.some(
            Entry.Deleted({ tombstone: new Tombstone({ id: subject, clock }) }),
          ),
        ),
      )
    fc.assert(
      fc.property(
        baseArb.chain(base =>
          fc.tuple(entryArb(base), entryArb(base), entryArb(base)),
        ),
        ([base, ours, theirs]) => {
          const entryText = (entry: Option.Option<Entry>) =>
            Option.match(entry, {
              onNone: () => 'none',
              onSome: Entry.$match({
                Live: ({ file }) => text(file),
                Deleted: ({ tombstone }) =>
                  `deleted ${tombstone.clock.wall}:${tombstone.clock.counter}:${tombstone.clock.engine}`,
              }),
            })
          const one = mergeOf(base, ours, theirs)
          const other = mergeOf(base, theirs, ours)
          expect(entryText(one.entry)).toBe(entryText(other.entry))
          expect(one.conflicts).toEqual(other.conflicts.map(swapped))
          const withBase = mergeOf(base, ours, base)
          // A missing side keeps the base's live ticket.
          const expected =
            Option.isNone(ours) &&
            Option.exists(base, entry => entry._tag === 'Live')
              ? base
              : ours
          expect(entryText(withBase.entry)).toBe(entryText(expected))
          expect(withBase.conflicts).toEqual([])
        },
      ),
    )
  })
})

describe('the run lease merged', () => {
  const lease = (
    engine: EngineId,
    run: string,
    started: number,
    renewed: number,
  ) =>
    new RunLease({
      engine,
      name: engine,
      host: `${engine}.local`,
      run: RunId.make(run),
      startedAt: DateTime.add(at, { minutes: started }),
      renewedAt: DateTime.add(at, { minutes: renewed }),
      expiresAt: DateTime.add(at, { minutes: renewed + 5 }),
    })
  const some = Option.some
  const both = (
    base: Option.Option<RunLease>,
    ours: Option.Option<RunLease>,
    theirs: Option.Option<RunLease>,
  ) => {
    const one = mergeLease({ base, ours, theirs })
    expect(mergeLease({ base, ours: theirs, theirs: ours })).toEqual(one)
    return one
  }

  it("keeps the latest renewal of one run's lease", () => {
    const held = lease(fa, 'r-1', 0, 0)
    expect(
      both(
        some(held),
        some(lease(fa, 'r-1', 0, 2)),
        some(lease(fa, 'r-1', 0, 1)),
      ),
    ).toEqual(some(lease(fa, 'r-1', 0, 2)))
    // Two renewals in one millisecond that differ only in the host: both sides keep the same one.
    const moved = new RunLease({ ...lease(fa, 'r-1', 0, 2), host: 'a.local' })
    expect(both(some(held), some(lease(fa, 'r-1', 0, 2)), some(moved))).toEqual(
      some(moved),
    ) // Name and host are compared one after the other, never run together.
    const spaced = new RunLease({
      ...lease(fa, 'r-1', 0, 2),
      name: 'a b',
      host: 'c',
    })
    const other = new RunLease({
      ...lease(fa, 'r-1', 0, 2),
      name: 'a',
      host: 'b c',
    })
    expect(both(some(held), some(spaced), some(other))).toEqual(some(other))
  })

  it('keeps the earlier start of two leases covering the same time', () => {
    expect(
      both(
        Option.none(),
        some(lease(fa, 'r-1', 0, 3)),
        some(lease(fb, 'r-2', 2, 2)),
      ),
    ).toEqual(some(lease(fa, 'r-1', 0, 3)))
  })

  it('keeps a lease taken over after the other expired', () => {
    const held = lease(fa, 'r-1', 0, 0)
    // fe-a renewed it at 1 (expiring at 6); fe-b took it over at 10, after it expired.
    expect(
      both(
        some(held),
        some(lease(fa, 'r-1', 0, 1)),
        some(lease(fb, 'r-2', 10, 10)),
      ),
    ).toEqual(some(lease(fb, 'r-2', 10, 10)))
  })

  it('keeps a removed lease removed, unless another run took it', () => {
    const held = lease(fa, 'r-1', 0, 0)
    expect(
      both(some(held), Option.none(), some(lease(fa, 'r-1', 0, 1))),
    ).toEqual(Option.none())
    expect(
      both(some(held), Option.none(), some(lease(fb, 'r-2', 6, 6))),
    ).toEqual(some(lease(fb, 'r-2', 6, 6)))
  })
})

describe('the ref merged', () => {
  it("merges the lease first, and gives its holder's claims the win", () => {
    const claim = (engine: EngineId) =>
      Option.some(new Assignee({ engine, session: SessionId.make('s-1') }))
    const other = id('fa-b2')
    const otherFile = new TicketFile({
      ...baseFile,
      ticket: new Ticket({ ...baseFile.ticket, id: other }),
      edges: { ...baseFile.edges, blocks: [] },
    })
    const held = new RunLease({
      engine: fb,
      name: 'server',
      host: 'server.local',
      run: RunId.make('r-2'),
      startedAt: at,
      renewedAt: at,
      expiresAt: DateTime.add(at, { minutes: 5 }),
    })
    const snapshot = (
      lease: Option.Option<RunLease>,
      entries: ReadonlyArray<readonly [TicketId, TicketFile]>,
    ): Snapshot => ({
      meta: Option.none(),
      lease,
      entries: new Map(
        entries.map(([ticket, file]) => [ticket, Entry.Live({ file })]),
      ),
    })
    const base = snapshot(Option.none(), [[subject, baseFile]])
    const ours = snapshot(Option.none(), [
      [subject, edited(baseFile, hlc(900, fa), { assignee: claim(fa) })],
    ])
    const theirs = snapshot(Option.some(held), [
      [subject, edited(baseFile, hlc(200, fb), { assignee: claim(fb) })],
      [other, otherFile],
    ])
    const { snapshot: merged, conflicts } = mergeSnapshots({
      base,
      ours,
      theirs,
    })
    expect(merged.lease).toEqual(Option.some(held))
    const entry = merged.entries.get(subject)
    expect(entry?._tag === 'Live' && entry.file.ticket.assignee).toEqual(
      claim(fb),
    )
    expect(merged.entries.get(other)).toEqual(Entry.Live({ file: otherFile }))
    expect(
      conflicts.map(({ ticket, conflict }) => [ticket, conflict._tag]),
    ).toEqual([[subject, 'Field']])
  })
})
