import { Schema } from 'effect'

// The clock's Messages (spec §18.3, H80).

export const messages = {
  /** The clock's tick: the time now, in the viewer's zone. */
  Ticked: { now: Schema.DateTimeZoned },
}
