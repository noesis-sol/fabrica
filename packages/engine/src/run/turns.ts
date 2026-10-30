import { Clock, Effect, Option, Ref, Schema, Stream } from 'effect'

import { ModelName, type SessionId, type TicketId } from '@fabrica/contracts'

import type { PiEvent } from '../agent'
import { type CostAccount, spendFields } from '../cost'
import type { RunLog } from '../runlog'
import { record } from './records'

// A session's `turn` records (spec §13.12, §14.4): each turn of its agent, from its start to its
// settle, with its model round-trips, how long it took, the model its last answer named (the one the
// session was given where none did), and its share of the session's spend, taken from the run's cost
// account as the turn ends. A turn its session's close cuts short, or its agent's exit, is written then.

/** A turn begun and not yet written. */
interface Going {
  /** When it began, in epoch ms. */
  readonly since: number
  readonly roundTrips: number
  readonly model: ModelName
}

/** The model an answer of the agent's names, as `<provider>/<model>`; none for another message. */
const answeredBy = (
  event: Extract<PiEvent, { readonly type: 'message_end' }>,
): Option.Option<ModelName> => {
  const { role, provider, model } = event.message
  if (role !== 'assistant' || provider === undefined || model === undefined)
    return Option.none()
  const name = model.startsWith(`${provider}/`) ? model : `${provider}/${model}`
  return Schema.is(ModelName)(name) ? Option.some(name) : Option.none()
}

/** Whose turns a session's `turn` records are, and where they are written. */
export interface TurnsOf {
  readonly log: RunLog['Service']
  readonly cost: CostAccount
  /** The session's ticket; none for a session of no ticket's. */
  readonly ticket: Option.Option<TicketId>
  readonly session: SessionId
  /** The model the session was given. */
  readonly model: ModelName
}

/** A session's turn records: each of its agent's events `heard` in order, and `closed` as the session ends. */
export interface TurnRecorder {
  readonly heard: (event: PiEvent) => Effect.Effect<void>
  /** Writes the turn going, if one is. */
  readonly closed: Effect.Effect<void>
}

/** The turn records of `input.session`. */
export const makeTurnRecorder = Effect.fn('Run.makeTurnRecorder')(function* (
  input: TurnsOf,
) {
  const going = yield* Ref.make(Option.none<Going>())

  const written = (turn: Going) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const spent = yield* input.cost.takeTurn(input.session)
      yield* record(input.log, {
        kind: 'turn',
        ...Option.match(input.ticket, {
          onNone: () => ({}),
          onSome: ticket => ({ ticket }),
        }),
        session: input.session,
        model: turn.model,
        ...spendFields(spent),
        turns: turn.roundTrips,
        duration_ms: Math.max(0, now - turn.since),
      })
    })

  /**
   * The turn going, ended: written, and none going. Whole, the session's close waiting on it: taken and
   * not written, it would be lost, and a record cut short is in the stream's file and not its feed.
   */
  const ended = Effect.uninterruptible(
    Effect.flatMap(
      Ref.getAndSet(going, Option.none()),
      Option.match({ onNone: () => Effect.void, onSome: written }),
    ),
  )

  const heard = (event: PiEvent): Effect.Effect<void> => {
    switch (event.type) {
      case 'agent_start':
        return Effect.flatMap(Clock.currentTimeMillis, since =>
          Ref.update(going, now =>
            Option.isSome(now)
              ? now
              : Option.some({ since, roundTrips: 0, model: input.model }),
          ),
        )
      case 'turn_end':
        return Ref.update(
          going,
          Option.map(turn => ({ ...turn, roundTrips: turn.roundTrips + 1 })),
        )
      case 'message_end':
        return Option.match(answeredBy(event), {
          onNone: () => Effect.void,
          onSome: model =>
            Ref.update(
              going,
              Option.map(turn => ({ ...turn, model })),
            ),
        })
      case 'agent_settled':
        return ended
      default:
        return Effect.void
    }
  }

  return { heard, closed: ended } satisfies TurnRecorder
})

/** Writes a `turn` record for each turn of the agent whose `events` are given, for as long as the scope is open. */
export const recordTurns = Effect.fn('Run.recordTurns')(function* (
  input: TurnsOf & { readonly events: Stream.Stream<PiEvent> },
) {
  const recorder = yield* makeTurnRecorder(input)
  yield* input.events.pipe(
    Stream.runForEach(recorder.heard),
    Effect.ensuring(recorder.closed),
    Effect.forkScoped,
  )
})
