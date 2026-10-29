import { Schema } from 'effect'

import { SshDestination } from '@fabrica/client'

// The engine the connection process relays a page's port to (spec §8.2), as main names it with the
// port it brokers: the local engine's socket, or the SSH bridge; the WSL2 bridge and TLS join them in M4.

export const ConnectionTarget = Schema.TaggedUnion({
  /** The local engine's socket. */
  LocalSocket: { path: Schema.NonEmptyString },
  /** An engine through the SSH stdio bridge: `ssh <destination> fabrica bridge`. */
  Ssh: { destination: SshDestination },
  /** No engine can be reached from this machine yet: every connection fails, saying why. */
  Unavailable: { reason: Schema.String },
})
export type ConnectionTarget = typeof ConnectionTarget.Type
