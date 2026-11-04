import { DateTime, Option, Schema } from 'effect'

import { describe, expect, it } from '@effect/vitest'
import {
  type LabelName,
  Phase,
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
import { type ReadyTicket, gate } from '../src/run/footprints-gate'

// What the gate says found no slot (spec §13.4, §14.3): the tickets nothing else holds back, which the
// machine budget holds a run for. One with no slot is taken for nothing, so nothing is held back for it.

const repository = makeRepository(['src/x.ts', 'src/y.ts'])
const apart = makeApartFiles({ unioned: [], checks: [], shared: [] })
const id = (n: number) => TicketId.make(`fa-${n}`)

const ready = (
  n: number,
  files: ReadonlyArray<string>,
  labels: ReadonlyArray<LabelName> = [],
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
      ticket: { ticket, labels },
      repository,
      declared: { declares: () => false },
    }),
    solo: labels.includes('solo'),
  }
}

const gated = (input: {
  readonly ready: ReadonlyArray<ReadyTicket>
  readonly free: number
  readonly parents?: ReadonlySet<TicketId>
  readonly running?: Parameters<typeof gate>[0]['running']
}) =>
  gate({
    parents: new Set(),
    running: [],
    mentions: noMentions,
    apart,
    ...input,
  })

describe('the tickets with no slot', () => {
  it('holds none back for one of them', () => {
    const result = gated({
      ready: [ready(1, ['src/x.ts']), ready(2, ['src/x.ts'])],
      free: 0,
    })
    expect(result.take).toEqual([])
    expect(result.held).toEqual([])
    expect(result.noSlot).toEqual([id(1), id(2)])
  })

  it('are those past the slots there are', () => {
    const result = gated({
      ready: [ready(1, ['src/x.ts']), ready(2, ['src/y.ts'])],
      free: 1,
    })
    expect(result.take.map(({ ticket }) => ticket.id)).toEqual([id(1)])
    expect(result.noSlot).toEqual([id(2)])
  })

  it("aren't those held back for another reason", () => {
    const one = ready(1, ['src/x.ts'])
    const result = gated({
      ready: [ready(2, ['src/x.ts']), ready(3, ['src/y.ts'])],
      free: 0,
      parents: new Set([id(3)]),
      running: [
        {
          ticket: id(1),
          phase: Phase.cases.working.make({}),
          footprint: one.footprint,
          solo: false,
        },
      ],
    })
    expect(result.noSlot).toEqual([])
    expect(result.held.map(({ reason }) => reason)).toEqual([
      'overlap',
      'parent',
    ])
  })

  it('count a solo ticket with nothing running but no slot', () => {
    const result = gated({ ready: [ready(1, [], ['solo'])], free: 0 })
    expect(result.take).toEqual([])
    expect(result.noSlot).toEqual([id(1)])
  })
})
