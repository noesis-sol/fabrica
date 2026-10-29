import { Data, Effect } from 'effect'

import type { Ticket, TicketId, TicketStatus } from '@fabrica/contracts'

// The ready rule and why a ticket waits (spec §13.3). A stub: the work graph's store calls these, and
// the ticket that builds the rule fills them in.

/** The ready rule isn't built yet. */
export class ReadyNotBuilt extends Data.TaggedError('ReadyNotBuilt')<{
  readonly operation: 'ready' | 'why'
}> {
  override get message() {
    return `the ready rule isn't built yet (${this.operation})`
  }
}

/** Why a ticket isn't ready, one reason each. */
export type WaitReason = Data.TaggedEnum<{
  /** It isn't open: in progress, deferred or closed. */
  NotOpen: { readonly status: TicketStatus }
}>
export const WaitReason = Data.taggedEnum<WaitReason>()

/** The tickets ready to dispatch, most urgent first. */
export const readyTickets = (): Effect.Effect<
  ReadonlyArray<Ticket>,
  ReadyNotBuilt
> => Effect.fail(new ReadyNotBuilt({ operation: 'ready' }))

/** Each reason the ticket isn't ready; none when it is. */
export const whyWaiting = (
  _id: TicketId,
): Effect.Effect<ReadonlyArray<WaitReason>, ReadyNotBuilt> =>
  Effect.fail(new ReadyNotBuilt({ operation: 'why' }))
