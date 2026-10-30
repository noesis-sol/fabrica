import { Data, Effect, type Option, Queue } from 'effect'

import type { StopKind, TicketId } from '@fabrica/contracts'

// What wakes the run (spec §13.2, tutti-rvzn.5, -gr4z.9): each change records why, and a look reads
// only what its reasons can have changed. A worker settling frees a slot and moves nothing in the
// work graph that the ready set reads, unless its ticket went back in the queue; a merge moves Base,
// and a change of the work graph by anyone but the run itself (a worker filing a ticket, the
// maintainer) moves the ready set.

export type WakeReason = Data.TaggedEnum<{
  /** The run started: the first look. */
  Started: {}
  /** A ticket's worker settled, or failed: its slot is free. */
  Settled: { readonly ticket: TicketId }
  /** A ticket's worker settled and the ticket went back in the queue, released: the ready set moved. */
  Requeued: { readonly ticket: TicketId }
  /** A ticket's turn in the merge queue ended: Base may have moved. */
  MergeEnded: { readonly ticket: TicketId }
  /** The work graph changed by another's hand than the run's. */
  TicketsChanged: {}
  /** Something stops the run: merging stopped, the work graph or git failed under it, a defect. */
  Stopped: {
    readonly kind: StopKind
    readonly ticket: Option.Option<TicketId>
    readonly detail: string
  }
}>
export const WakeReason = Data.taggedEnum<WakeReason>()

/** Whether a look woken for `reasons` reads the ready set again, rather than the one it read last. */
export const readsReady = (reasons: ReadonlyArray<WakeReason>): boolean =>
  reasons.some(reason =>
    WakeReason.$match(reason, {
      Started: () => true,
      Settled: () => false,
      Requeued: () => true,
      MergeEnded: () => true,
      TicketsChanged: () => true,
      Stopped: () => false,
    }),
  )

/** The run's wakes: any part of the run wakes it, and the loop takes every reason waiting at once. */
export interface Wakes {
  readonly wake: (reason: WakeReason) => Effect.Effect<void>
  /** Waits for a wake, then takes every reason waiting. */
  readonly next: Effect.Effect<ReadonlyArray<WakeReason>>
}

export const makeWakes = Effect.map(
  Queue.unbounded<WakeReason>(),
  (queue): Wakes => ({
    wake: reason => Effect.asVoid(Queue.offer(queue, reason)),
    next: Effect.map(Queue.takeAll(queue), reasons => [...reasons]),
  }),
)
