import { Schema } from 'effect'

// An SSH destination (spec §9.1), as "Add engine" takes it and the SSH bridge runs ssh with it. It has no
// Node in it, so the renderer checks one as the connection process does.

/** An SSH destination: `user@host`, a host of `~/.ssh/config`, or `ssh://[user@]host[:port]`. */
export const SshDestination = Schema.String.check(
  // No user or host starts with a dash, which ssh, or a command it runs with them, would read as an
  // option; no spaces or controls.
  Schema.isPattern(/^(?!-|.*(?:\/\/|@)-)[^\s\p{Cc}]+$/u),
)
export type SshDestination = typeof SshDestination.Type
