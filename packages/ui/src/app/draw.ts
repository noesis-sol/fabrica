import { Array, Duration, Effect, Option, Schema } from 'effect'

import { TranscriptItem } from '@fabrica/contracts'

// Streamed text drawn at most every `drawEvery` (spec §18.5, H79), for the Worker view's transcript and
// the talks' alike (the console's talk panel and the Talks screen). A frame that arrives while no draw's
// wait runs is drawn at once, and a wait started; a frame that arrives while it runs waits for its end,
// then goes on with every frame that came meanwhile, and the next wait starts. A wait that ends with
// nothing waiting lets the next frame be drawn at once.

/** The longest streamed text waits to be drawn, and the shortest time between two draws (§18.5). */
export const drawEvery = Duration.millis(33)

/** Whether a draw's wait runs: what arrives meanwhile waits for its end. */
export const Draw = Schema.Literals(['Idle', 'Waiting'])
export type Draw = typeof Draw.Type

/** A transcript's frames held back: those that arrived during a draw's wait, in order, and the wait. */
export const Held = Schema.Struct({
  /** Frames that arrived during a draw's wait, in order. */
  waiting: Schema.Array(TranscriptItem),
  draw: Draw,
})
export type Held = typeof Held.Type

/** Nothing held, and no wait running. */
export const idle: Held = { waiting: [], draw: 'Idle' }

const waitingDraw: Draw = 'Waiting'
const idleDraw: Draw = 'Idle'

/** What a frame, or a wait's end, comes to: what is held after it, and the frames to draw now, which start a wait. */
export interface Step {
  readonly held: Held
  readonly draw: Option.Option<Array.NonEmptyReadonlyArray<TranscriptItem>>
}

/** A frame of a transcript: drawn now where no wait runs, else held for the wait's end. */
export const received = (
  held: Held,
  items: Array.NonEmptyReadonlyArray<TranscriptItem>,
): Step =>
  held.draw === 'Idle'
    ? { held: { waiting: [], draw: waitingDraw }, draw: Option.some(items) }
    : {
        held: { waiting: [...held.waiting, ...items], draw: waitingDraw },
        draw: Option.none(),
      }

/** A draw's wait ended: the frames that came meanwhile are drawn, where any did. */
export const waited = (held: Held): Step =>
  Array.isReadonlyArrayNonEmpty(held.waiting)
    ? {
        held: { waiting: [], draw: waitingDraw },
        draw: Option.some(held.waiting),
      }
    : { held: { waiting: [], draw: idleDraw }, draw: Option.none() }

/** Waits `drawEvery`, then gives `message`: a draw's wait, for a Command's `execute`. */
export const waitToDraw = <Message>(message: Message): Effect.Effect<Message> =>
  Effect.as(Effect.sleep(drawEvery), message)
