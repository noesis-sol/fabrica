import { Option, Schema } from 'effect'

import {
  CertificateFingerprint,
  EngineId,
  ProtocolVersion,
  formatListenAddress,
  parseListenAddress,
} from '@fabrica/contracts'

import { SshDestination } from './destination'
import { WslDistro } from './wsl-host'

// The engines the app knows (spec §9.1): a name, how to reach it, the engine's ID and protocol version.
// The app keeps them in its own state, its main process reading and writing them; the renderer asks
// for them and has one kept once Add engine installed it and its first hello came, so each crosses
// from one process to the other and is decoded there. This module has no Node in it.

/** The name the user gives an engine, unique among the app's. */
export const EngineName = Schema.NonEmptyString
export type EngineName = typeof EngineName.Type

/** A TCP port an engine's TLS listener is reached on. */
export const TlsPort = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 }),
)

/** Where an engine's TLS listener is reached: a host (a name, or an IPv4 or IPv6 address) and a port. */
export const TlsEndpoint = Schema.Struct({
  host: Schema.NonEmptyString,
  port: TlsPort,
})
export type TlsEndpoint = typeof TlsEndpoint.Type

const decodeEndpoint = Schema.decodeUnknownOption(TlsEndpoint)

/** The endpoint `host:port` or `[v6]:port` names; none for other text, or a port or host missing. */
export const parseTlsEndpoint = (text: string): Option.Option<TlsEndpoint> =>
  Option.flatMap(parseListenAddress(text.trim()), ({ host, port }) =>
    Option.flatMap(host, name => decodeEndpoint({ host: name, port })),
  )

/** An endpoint written as parseTlsEndpoint reads it. */
export const tlsEndpointText = ({ host, port }: TlsEndpoint): string =>
  formatListenAddress({ host: Option.some(host), port })

/** How the app reaches an engine (spec §8.2). */
export const EngineAddress = Schema.TaggedUnion({
  /** The engine on this machine, through its local socket. */
  Local: {},
  /** Through the SSH stdio bridge: `user@host`, or a host of `~/.ssh/config`. */
  Ssh: { destination: SshDestination },
  /** Through the bridge in a WSL2 distribution. */
  Wsl: { distro: WslDistro },
  /**
   * WebSocket over TLS, at `host:port`, its certificate trusted by the SHA-256 fingerprint the user
   * accepted at pairing (§9.3); its pairing token is kept apart, in the app's secret storage.
   */
  Tls: { ...TlsEndpoint.fields, fingerprint: CertificateFingerprint },
})
export type EngineAddress = typeof EngineAddress.Type

/** An engine the app knows. */
export class KnownEngine extends Schema.Class<KnownEngine>('KnownEngine')({
  name: EngineName,
  address: EngineAddress,
  engine: EngineId,
  protocol: ProtocolVersion,
}) {}

/** The known engines as the app's state holds them, or why they couldn't be read, in words. */
export const KnownEnginesAnswer = Schema.TaggedUnion({
  Read: { engines: Schema.Array(KnownEngine) },
  Failed: { reason: Schema.String },
})
export type KnownEnginesAnswer = typeof KnownEnginesAnswer.Type

/** Whether a known engine was kept in the app's state, or why it wasn't, in words. */
export const KeepAnswer = Schema.TaggedUnion({
  Kept: {},
  Failed: { reason: Schema.String },
})
export type KeepAnswer = typeof KeepAnswer.Type

/** The name Add engine gives an engine on `destination` where the user gives none: its host's. */
export const defaultEngineName = (destination: SshDestination): string =>
  destination
    .replace(/^ssh:\/\//u, '')
    .replace(/^[^@]*@/u, '')
    .replace(/:\d+$/u, '')

/** The name the app keeps the engine in the WSL2 distribution `distro` under: `WSL Ubuntu`. */
export const wslEngineName = (distro: WslDistro): EngineName => `WSL ${distro}`
