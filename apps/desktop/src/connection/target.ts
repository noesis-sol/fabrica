import { Schema } from 'effect'

// The engine the connection process relays a page's port to (spec §8.2), as main names it with the
// port it brokers. The local engine's socket now; the SSH and WSL2 bridges and TLS join it in M4.

export const ConnectionTarget = Schema.TaggedUnion({
  /** The local engine's socket. */
  LocalSocket: { path: Schema.NonEmptyString },
  /** No engine can be reached from this machine yet: every connection fails, saying why. */
  Unavailable: { reason: Schema.String },
})
export type ConnectionTarget = typeof ConnectionTarget.Type
