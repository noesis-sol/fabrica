import { Data, type DateTime, Option } from 'effect'

import type { TicketId, TicketStatus } from '@fabrica/contracts'

// What `tickets.update` does to a ticket's status and its time to defer until (spec §11.1), by the
// status it holds: the one rule, for the handler that does it and for the merge conflicts that offer it.
// A time to defer until defers the ticket; clearing it clears a deferred ticket's time.

export type StatusChange = Data.TaggedEnum<{
  /** Nothing to do: the status stays, and no time is written. */
  None: {}
  Refused: { readonly reason: string }
  Reopen: {}
  Undefer: {}
  Defer: { readonly until: Option.Option<DateTime.Utc> }
}>
export const StatusChange = Data.taggedEnum<StatusChange>()

/** What asking for `status` or `deferUntil`, either left out, does to `id`, which holds `current`. */
export const statusChangeOf = ({
  id,
  current,
  status,
  deferUntil,
}: {
  readonly id: TicketId
  readonly current: TicketStatus
  readonly status?: 'open' | 'deferred' | undefined
  readonly deferUntil?: Option.Option<DateTime.Utc> | undefined
}): StatusChange => {
  if (status === 'open') {
    switch (current) {
      case 'closed':
        return StatusChange.Reopen()
      case 'deferred':
        return StatusChange.Undefer()
      case 'in_progress':
        return StatusChange.Refused({
          reason: `can't reopen ${id}: it is in progress`,
        })
      case 'open':
        return StatusChange.None()
    }
  }
  const defers =
    status === 'deferred' ||
    (deferUntil !== undefined &&
      (Option.isSome(deferUntil) || current === 'deferred'))
  if (!defers) return StatusChange.None()
  return current === 'closed'
    ? StatusChange.Refused({ reason: `can't defer ${id}: it is closed` })
    : StatusChange.Defer({ until: deferUntil ?? Option.none() })
}
