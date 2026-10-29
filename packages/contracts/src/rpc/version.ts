import { Result, Schema } from 'effect'

import { EngineId } from '../ids'
import { ClientName } from './common'

// The protocol's version (spec §8.4). At connect, client and engine exchange theirs; the engine
// speaks its current version and the one before, so a client one version behind still connects. A
// client too old for the engine, or an engine too old for the client, is told which of the two to
// update (§9.2). `engine.connect` and these schemas keep their shape in every version, so any client
// can be told so.

/** A protocol version: a whole number, counted from 1. */
export const ProtocolVersion = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
)
export type ProtocolVersion = typeof ProtocolVersion.Type

/** The version this package's protocol is. Raise it when a change would break a client one version behind. */
export const protocolVersion: ProtocolVersion = 1

/** A release of the engine or a client: `<major>.<minor>.<patch>`, with a pre-release where it has one. */
export const ReleaseVersion = Schema.String.check(
  Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
)
export type ReleaseVersion = typeof ReleaseVersion.Type

/** What a client is. */
export const ClientKind = Schema.Literals(['app', 'cli', 'other'])
export type ClientKind = typeof ClientKind.Type

/** What a client says of itself as it connects. */
export class ClientHello extends Schema.Class<ClientHello>('ClientHello')({
  name: ClientName,
  kind: ClientKind,
  release: ReleaseVersion,
  protocol: ProtocolVersion,
}) {}

/** The engine's answer to a client it takes: the version they speak, and the engine's own. */
export class EngineHello extends Schema.Class<EngineHello>('EngineHello')({
  protocol: ProtocolVersion,
  engine: EngineId,
  release: ReleaseVersion,
}) {}

/** Which side must be updated for the two to talk. */
export const UpdateSide = Schema.Literals(['client', 'engine'])
export type UpdateSide = typeof UpdateSide.Type

/** The client and the engine share no version: `update` says which is too old. */
export class VersionMismatch extends Schema.TaggedError<VersionMismatch>()(
  'VersionMismatch',
  {
    client: ProtocolVersion,
    engine: ProtocolVersion,
    update: UpdateSide,
  },
) {}

/** The versions an engine at `current` speaks: `current` and the one before (§8.4). */
export const supportedVersions = (
  current: ProtocolVersion,
): ReadonlyArray<ProtocolVersion> =>
  current > 1 ? [current, current - 1] : [current]

/** The version a client and an engine speak, or which of them must be updated. */
export const negotiate = (versions: {
  readonly client: ProtocolVersion
  readonly engine: ProtocolVersion
}): Result.Result<ProtocolVersion, VersionMismatch> =>
  supportedVersions(versions.engine).includes(versions.client)
    ? Result.succeed(versions.client)
    : Result.fail(
        new VersionMismatch({
          ...versions,
          update: versions.client < versions.engine ? 'client' : 'engine',
        }),
      )
