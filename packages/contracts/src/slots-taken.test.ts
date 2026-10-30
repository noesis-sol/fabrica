import { describe, expect, it } from '@effect/vitest'

import { TicketId } from './ids'
import { Phase, WaitFor, slotsTakenBy } from './phases'

// The run's slots (spec §13.4, H56): a worker or a verifier at work takes one; up to `concurrent`
// tickets past their work, hand-backs among them, take none, and each beyond takes one (orchestra-z8lr).

const working = Phase.cases.working.make({})
const verifying = Phase.cases.verifying.make({ round: 1 })
const waitingToMerge = Phase.cases.waiting_to_merge.make({ place: 1 })
const merging = Phase.cases.merging.make({ step: 'check' })
const resolving = Phase.cases.resolving.make({ attempt: 1 })
const fixing = Phase.cases.fixing.make({ attempt: 1 })
const queued = Phase.cases.queued.make({})
const waiting = Phase.cases.waiting.make({
  for: WaitFor.cases.merge.make({ tickets: [TicketId.make('fa-1')] }),
})
const asked = Phase.cases.asked.make({ question: TicketId.make('fa-2') })

describe('the slots taken', () => {
  it('counts a slot for each worker and verifier at work, none for a ticket out of one', () => {
    expect(slotsTakenBy([working, verifying, queued, waiting, asked], 2)).toBe(
      2,
    )
  })

  it('counts none for up to concurrent tickets past their work, hand-backs among them', () => {
    expect(slotsTakenBy([waitingToMerge, merging], 2)).toBe(0)
    expect(slotsTakenBy([resolving, fixing, working], 2)).toBe(1)
  })

  it('counts one for each ticket past its work beyond concurrent', () => {
    expect(
      slotsTakenBy([waitingToMerge, merging, resolving, fixing, working], 2),
    ).toBe(3)
    expect(slotsTakenBy([waitingToMerge, waitingToMerge, fixing], 1)).toBe(2)
  })
})
