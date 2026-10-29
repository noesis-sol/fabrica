import { Schema } from 'effect'

// What every group of the protocol shares. A moment is a `DateTime.Utc`, encoded as milliseconds since
// the epoch, as the work graph keeps it; clients show it in the viewer's zone (spec §7.7). A request's
// optional parameter is a key the client may leave out (`OptionFromOptionalKey`); a value the engine
// has none of is `null` (`OptionFromNullOr`), as in the ticket model.

/** A moment, encoded as milliseconds since the epoch. */
export const Moment = Schema.DateTimeUtcFromMillis

/** A count: a whole number, 0 or more. */
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** A place, an attempt or a number of things asked for: counted from 1. */
export const Ordinal = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** Money, in US dollars, never negative. */
export const Usd = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

/** Bytes, a whole number, 0 or more. */
export const Bytes = Count

/** A duration in whole milliseconds (H55: every interval and rate is a whole number of them). */
export const Millis = Count

/** A name with no whitespace: a token's, a credential's. */
export const Name = Schema.String.check(Schema.isPattern(/^\S+$/u))

/** How a client names itself to the engine, and how the engine says who answered first (spec §8.5). */
export const ClientName = Schema.String.check(
  Schema.isPattern(/^[^\n\r]*\S[^\n\r]*$/u),
)
export type ClientName = typeof ClientName.Type

/** An optional request parameter: a key the client may leave out. */
export const optional = Schema.OptionFromOptionalKey
