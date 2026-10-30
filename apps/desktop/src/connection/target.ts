import { Schema } from 'effect'

import { SshDestination, TlsEndpoint, WslDistro } from '@fabrica/client'
import { CertificateFingerprint } from '@fabrica/contracts'

// The engine the connection process relays a page's port to (spec §8.2), as main names it with the
// port it brokers: the local engine's socket, the SSH bridge, the WSL2 bridge, or an engine paired over
// TLS, with the fingerprint pinned at its pairing and its token, which main reads from the app's secret
// storage. It crosses to the connection process encoded, the token as text, and is decoded there.

export const ConnectionTarget = Schema.TaggedUnion({
  /** The local engine's socket. */
  LocalSocket: { path: Schema.NonEmptyString },
  /** An engine through the SSH stdio bridge: `ssh <destination> fabrica bridge`. */
  Ssh: { destination: SshDestination },
  /** An engine in a WSL2 distribution, through its bridge: `wsl.exe -d <distro> -- fabrica bridge`. */
  Wsl: { distro: WslDistro },
  /** An engine paired over TLS (§9.3): a WebSocket to its listener, its certificate checked against the pin. */
  Tls: {
    ...TlsEndpoint.fields,
    fingerprint: CertificateFingerprint,
    token: Schema.RedactedFromValue(Schema.NonEmptyString),
  },
  /** No engine can be reached from this machine yet: every connection fails, saying why. */
  Unavailable: { reason: Schema.String },
  /**
   * The engine can't be reached in a way trying again won't mend (a paired engine whose token the app
   * can't read): every connection is refused, saying why.
   */
  Refused: { reason: Schema.String },
})
export type ConnectionTarget = typeof ConnectionTarget.Type

/** A target as it crosses to the connection process. */
export const encodeTarget = Schema.encodeSync(ConnectionTarget)
