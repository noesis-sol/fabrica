import { Schema } from 'effect'

import {
  EngineId,
  ProtocolVersion,
  ReleaseVersion,
  UpdateSide,
} from '@fabrica/contracts'

// The connection's Messages: its lifecycle, and the engine ports main hands the page (spec §9.1).

export const messages = {
  ConnectedToEngine: {
    engine: EngineId,
    release: ReleaseVersion,
    protocol: ProtocolVersion,
  },
  LostEngine: {},
  ReleasedEngine: {},
  FailedToConnect: { reason: Schema.String },
  /** The connection was refused in a way trying again won't mend: ssh refused the engine's host. */
  StoppedConnecting: { reason: Schema.String },
  /** The user asked to try a connection that stopped again. */
  RequestedReconnect: {},
  RefusedByEngine: {
    client: ProtocolVersion,
    engine: ProtocolVersion,
    update: UpdateSide,
  },
  WaitedToReconnect: {},
  /** Main handed the page a new engine port, the connection's dead with the relay that served it. */
  ReplacedEnginePort: {},
}
