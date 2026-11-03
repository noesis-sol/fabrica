import { Effect, Option, Ref } from 'effect'

import type {
  HandBackKind,
  HandBacks,
  ProjectId,
  RunId,
  TicketId,
} from '@fabrica/contracts'

import { Telemetry, TelemetryRow } from '../telemetry'

// A ticket's hand-backs in the run (spec §13.7, §13.12, H65): each hand-back the merge queue gives is
// recorded in telemetry as a hand-back row tied to the run's project, the run and its ticket, and
// counted by kind for the records that end the ticket's part in the run (`closed`, `deferred`,
// `ticket_end`). The count is the queue's: a hand-back's attempt is its book's tally of that kind, so
// it is taken as given, never counted again here.

export interface HandBackTallyShape {
  /** The merge queue handed `ticket` back for its `attempt`th `kind`. */
  readonly given: (input: {
    readonly ticket: TicketId
    readonly kind: HandBackKind
    readonly attempt: number
  }) => Effect.Effect<void>
  /** The ticket's hand-backs in the run; none where it had none. */
  readonly of: (ticket: TicketId) => Effect.Effect<Option.Option<HandBacks>>
}

/** A record's `hand_backs` for `counts`, left out where the ticket had none. */
export const handBackFields = (
  counts: Option.Option<HandBacks>,
): { readonly hand_backs?: HandBacks } =>
  Option.match(counts, {
    onNone: () => ({}),
    onSome: hand_backs => ({ hand_backs }),
  })

/** The hand-backs of `run`, recorded into telemetry. */
export const makeHandBackTally = Effect.fn('HandBackTally.make')(
  function* (tie: { readonly project: ProjectId; readonly run: RunId }) {
    const telemetry = yield* Telemetry
    const counts = yield* Ref.make<ReadonlyMap<TicketId, HandBacks>>(new Map())
    return {
      given: ({ ticket, kind, attempt }) =>
        Effect.andThen(
          Ref.update(counts, all => {
            const before = all.get(ticket) ?? { resolve: 0, fix: 0 }
            return new Map(all).set(ticket, {
              ...before,
              [kind]: Math.max(before[kind], attempt),
            })
          }),
          telemetry.record(
            TelemetryRow.HandBack({
              project: tie.project,
              run: tie.run,
              ticket,
              kind,
            }),
          ),
        ),
      of: ticket =>
        Effect.map(Ref.get(counts), all =>
          Option.fromNullishOr(all.get(ticket)),
        ),
    } satisfies HandBackTallyShape
  },
)
