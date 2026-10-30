import { Effect, Schema } from 'effect'

import {
  type FingerprintAnswer,
  type PairAnswer,
  PairRequest,
  TlsEndpoint,
} from '@fabrica/client'

import { channels } from '../../preload/api'
import type { MainContext } from '../context'
import type { IpcRegistrar } from '../ipc'

// Pairing with an engine over TLS (spec §9.3), as the page asks: the fingerprint of the certificate it
// presents read at a first pairing, and the pairing the user agreed to held by ../pairing.

/** What main does for a pairing. */
export interface TlsPairingActions {
  /** The fingerprint of the certificate the engine at an endpoint presents, at a first pairing (§9.3). */
  readonly readFingerprint: (
    endpoint: TlsEndpoint,
  ) => Promise<FingerprintAnswer>
  /** Holds the pairing the user agreed to, its token kept once the engine is. */
  readonly pairEngine: (request: PairRequest) => Promise<PairAnswer>
}

const decodeEndpoint = Schema.decodeUnknownOption(Schema.Tuple([TlsEndpoint]))
const decodePair = Schema.decodeUnknownOption(Schema.Tuple([PairRequest]))

/** Registers the pairing's channels on `ipc`, answered by `actions`. */
export const tlsPairingChannels = (
  ipc: IpcRegistrar,
  actions: TlsPairingActions,
): void => {
  ipc.onRequest(channels.readFingerprint, decodeEndpoint, ([endpoint]) =>
    actions.readFingerprint(endpoint),
  )
  ipc.onRequest(channels.pairEngine, decodePair, ([request]) =>
    actions.pairEngine(request),
  )
}

/** Registers the pairing on `ipc`, held by the app's pairings. */
export const registerTlsPairing = (
  ipc: IpcRegistrar,
  { pairings }: MainContext,
): void =>
  tlsPairingChannels(ipc, {
    readFingerprint: endpoint =>
      Effect.runPromise(pairings.readFingerprint(endpoint)),
    pairEngine: request => Effect.runPromise(pairings.pair(request)),
  })
