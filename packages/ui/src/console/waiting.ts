import { Array, Option } from 'effect'

import { Phase, type TicketId, WaitFor } from '@fabrica/contracts'

// Why a ticket in the queue waits, in words, as the log says it (spec §18.3, H81): the one place the
// console words it, so the stats row's hover and Up next say the same of a ticket. A ticket ready for
// a slot doesn't wait for anything else; one held back carries its words from the engine; one put back
// in the queue is said from what it waits for.

/** `fa-12`, `fa-12 and fa-13`, `fa-12, fa-13 and fa-14`. */
const ticketList = (tickets: Array.NonEmptyReadonlyArray<TicketId>): string =>
  tickets.length === 1
    ? Array.headNonEmpty(tickets)
    : `${Array.initNonEmpty(tickets).join(', ')} and ${Array.lastNonEmpty(tickets)}`

/** What a ticket back in the queue waits for, in words. */
export const waitForWords: (waitFor: WaitFor) => string = WaitFor.match({
  merge: ({ tickets }) => `waits for ${ticketList(tickets)} to merge`,
  setup: () => 'waits to retry: its setup failed',
  probe: () => 'waits for the environment probe',
})

/** Why a ticket in the queue waits for more than a free slot, in words; none for any other phase. */
export const waitingWords = (phase: Phase): Option.Option<string> =>
  Phase.match(phase, {
    queued: () => Option.none(),
    held_back: ({ detail }) => Option.some(detail),
    waiting: ({ for: waitFor }) => Option.some(waitForWords(waitFor)),
    working: () => Option.none(),
    verifying: () => Option.none(),
    waiting_to_merge: () => Option.none(),
    merging: () => Option.none(),
    resolving: () => Option.none(),
    fixing: () => Option.none(),
    asked: () => Option.none(),
    set_aside: () => Option.none(),
    stopped: () => Option.none(),
    merged: () => Option.none(),
    no_change: () => Option.none(),
  })
