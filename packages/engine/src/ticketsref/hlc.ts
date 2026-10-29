import { Order, Schema, SchemaTransformation } from 'effect'

import { EngineId } from '@fabrica/contracts'

import { CodePoints } from './code-points'

// Hybrid logical clocks (spec §11.3, H32). Each field of a ticket on the tickets ref carries the clock
// of its last change: the wall time in milliseconds, a counter, and the ID of the engine that made it.
// An engine's clock never runs behind any clock it has merged, so a host whose wall clock is behind
// still orders its changes after what it has seen; clocks are ordered by wall time, then counter, then
// engine ID, so every engine orders the same two clocks the same way. Pure: the wall time is passed in.

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** A hybrid logical clock. */
export class Hlc extends Schema.Class<Hlc>('Hlc')({
  /** Milliseconds since the epoch. */
  wall: Count,
  /** Orders the changes made in the same millisecond, or while the wall clock was behind. */
  counter: Count,
  engine: EngineId,
}) {}

const hlcText = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*):(\S+)$/u

/** A clock as the ref writes it: `<wall>:<counter>:<engine>`, such as `1793275200000:0:fe-laptop`. */
export const HlcFromString = Schema.String.check(
  Schema.isPattern(hlcText, {
    expected: 'a clock "<wall>:<counter>:<engine>"',
  }),
).pipe(
  Schema.decodeTo(
    Hlc,
    SchemaTransformation.transform({
      decode: text => {
        const [, wall = '0', counter = '0', engine = ''] =
          hlcText.exec(text) ?? []
        return { wall: Number(wall), counter: Number(counter), engine }
      },
      encode: ({ wall, counter, engine }) => `${wall}:${counter}:${engine}`,
    }),
  ),
)

/** Clocks in the order of their changes: wall time, then counter, then engine ID. */
export const HlcOrder: Order.Order<Hlc> = Order.combineAll([
  Order.mapInput(Order.Number, (clock: Hlc) => clock.wall),
  Order.mapInput(Order.Number, (clock: Hlc) => clock.counter),
  Order.mapInput(CodePoints, (clock: Hlc) => clock.engine),
])

/** The later of two clocks. */
export const later = (self: Hlc, that: Hlc): Hlc =>
  HlcOrder(self, that) >= 0 ? self : that

/**
 * The clock an engine issues a change at: its wall time, or, when that isn't past the last clock it
 * issued or merged, that clock's wall time with the counter moved on. Always past `last`.
 */
export const tick = ({
  engine,
  last,
  now,
}: {
  readonly engine: EngineId
  readonly last: Hlc
  readonly now: number
}): Hlc =>
  now > last.wall
    ? new Hlc({ wall: now, counter: 0, engine })
    : new Hlc({ wall: last.wall, counter: last.counter + 1, engine })

/** The first clock an engine has, before it has issued or merged any. */
export const zero = (engine: EngineId): Hlc =>
  new Hlc({ wall: 0, counter: 0, engine })
