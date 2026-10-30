import { Schema } from 'effect'

import { EngineName, KeepAnswer, KnownEnginesAnswer } from '@fabrica/client'
import {
  EngineId,
  ProtocolVersion,
  ReleaseVersion,
  UpdateSide,
} from '@fabrica/contracts'

// The known engines on other hosts' Messages, and each one's connection (spec §9.1).

export const messages = {
  /** The known engines, as the app's state holds them (§9.1). */
  LoadedKnownEngines: { answer: KnownEnginesAnswer },
  /** A known engine kept in the app's state, or why it wasn't. */
  CompletedKeepEngine: { name: EngineName, answer: KeepAnswer },
  /** The known engine named `name` took the app's hello. */
  ConnectedToRemote: {
    name: EngineName,
    engine: EngineId,
    release: ReleaseVersion,
    protocol: ProtocolVersion,
  },
  /** The known engine's link was lost; its client is reconnecting. */
  LostRemote: { name: EngineName },
  /** The known engine couldn't be reached; another attempt follows. */
  FailedToConnectRemote: { name: EngineName, reason: Schema.String },
  /** The known engine's connection was refused in a way trying again won't mend: ssh refused its host. */
  StoppedConnectingRemote: { name: EngineName, reason: Schema.String },
  /** The known engine and the app share no protocol version. */
  RefusedByRemote: {
    name: EngineName,
    client: ProtocolVersion,
    engine: ProtocolVersion,
    update: UpdateSide,
  },
}
