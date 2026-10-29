import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

import { EngineId, ProjectId, TicketId } from '../ids'
import { EngineSettings, Platform } from '../settings'
import { Text } from '../ticket'
import { Bytes, Count, Moment, Ordinal, optional } from './common'
import { resume, streamItem } from './stream'
import {
  ClientHello,
  EngineHello,
  ProtocolVersion,
  ReleaseVersion,
  VersionMismatch,
} from './version'

// The Engine group (spec §8.1): the handshake, the engine's version, status and settings, stopping
// and updating it, and the streams of its status and its host's load (§7.4, §18.3).

/** The kernel's word on memory: macOS's memory pressure, Linux's pressure-stall information. */
export const MemoryPressure = Schema.Literals(['normal', 'warn', 'critical'])
export type MemoryPressure = typeof MemoryPressure.Type

/** One worker's process tree's memory. */
export class WorkerMemory extends Schema.Class<WorkerMemory>('WorkerMemory')({
  project: ProjectId,
  ticket: TicketId,
  bytes: Bytes,
}) {}

/** A sample of the engine host's load (§7.4): the console's system stats describe it, never the app's machine. */
export class HostLoad extends Schema.Class<HostLoad>('HostLoad')({
  sampledAt: Moment,
  memory: Schema.Struct({
    used: Bytes,
    total: Bytes,
    pressure: MemoryPressure,
  }),
  swapping: Schema.Boolean,
  /** The 1-minute load average. */
  load1: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  cores: Ordinal,
  /** Cores busy at the sample. */
  busyCores: Count,
  workers: Schema.Array(WorkerMemory),
  /** The merge check's process tree, while one runs. */
  mergeCheck: Schema.OptionFromNullOr(Bytes),
}) {}

/** The machine the engine runs on. */
export class EngineHost extends Schema.Class<EngineHost>('EngineHost')({
  platform: Platform,
  arch: Text,
  hostname: Text,
  cores: Ordinal,
}) {}

/** The engine's own version and the protocol versions it speaks. */
export class EngineVersion extends Schema.Class<EngineVersion>('EngineVersion')(
  {
    release: ReleaseVersion,
    protocol: ProtocolVersion,
    supported: Schema.NonEmptyArray(ProtocolVersion),
  },
) {}

/** The engine's state, as the Engines screen shows it (§18.4). */
export class EngineStatus extends Schema.Class<EngineStatus>('EngineStatus')({
  id: EngineId,
  release: ReleaseVersion,
  startedAt: Moment,
  host: EngineHost,
  projects: Count,
  runs: Count,
  /** Workers live across every run, against `machine_workers` (§7.3). */
  liveWorkers: Count,
  machineWorkers: Ordinal,
  clients: Count,
  /** Winding its runs down before it stops or updates (§7.1, §9.2). */
  stopping: Schema.Boolean,
}) {}

/** The update the engine took on. */
export class UpdateStarted extends Schema.Class<UpdateStarted>('UpdateStarted')(
  {
    from: ReleaseVersion,
    to: ReleaseVersion,
  },
) {}

/** The update couldn't be had or verified. */
export class UpdateFailed extends Schema.TaggedError<UpdateFailed>()(
  'UpdateFailed',
  { reason: Text },
) {}

/** The handshake: every connection's first request (§8.4). */
export const Connect = Rpc.make('engine.connect', {
  payload: ClientHello,
  success: EngineHello,
  error: VersionMismatch,
})

export const EngineRpcs = RpcGroup.make(
  Connect,
  Rpc.make('engine.version', { success: EngineVersion }),
  Rpc.make('engine.status', { success: EngineStatus }),
  Rpc.make('engine.settings', { success: EngineSettings }),
  /** Winds the runs down and stops the engine (§7.1). */
  Rpc.make('engine.stop'),
  /** Updates the engine to `to`, or the latest release, once its runs are wound down (§9.2). */
  Rpc.make('engine.update', {
    payload: { to: optional(ReleaseVersion) },
    success: UpdateStarted,
    error: UpdateFailed,
  }),
  Rpc.make('engine.watchStatus', {
    payload: { resume },
    success: streamItem(EngineStatus, EngineStatus),
    stream: true,
  }),
  Rpc.make('engine.watchLoad', {
    payload: { resume },
    success: streamItem(HostLoad, HostLoad),
    stream: true,
  }),
)
