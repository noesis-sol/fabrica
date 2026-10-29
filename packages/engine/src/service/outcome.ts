import { Data, Schema } from 'effect'

// What the login service's commands come to (spec §7.1, §19): each a schema, since `fabrica service`
// prints them as JSON with `--json`, and the tagged unions among them matched exhaustively.

/** The service manager the login service is installed with. */
export const ServiceManager = Schema.Literals(['launchd', 'systemd'])
export type ServiceManager = typeof ServiceManager.Type

/**
 * What enabling the user's linger came to (§7.1), so a systemd user unit runs without a login session.
 * Enabling one's own needs no sudo where polkitd runs; without it, logind refuses, and the remedy is
 * the command that enables it with sudo.
 */
export const Linger = Schema.TaggedUnion({
  Enabled: {},
  Refused: { reason: Schema.String, remedy: Schema.String },
})
export type Linger = typeof Linger.Type

/** The login service installed and started. */
export const ServiceInstalled = Schema.TaggedUnion({
  launchd: { file: Schema.String, command: Schema.Array(Schema.String) },
  systemd: {
    file: Schema.String,
    command: Schema.Array(Schema.String),
    linger: Linger,
  },
})
export type ServiceInstalled = typeof ServiceInstalled.Type

/** The login service stopped and its file removed. */
export const ServiceUninstalled = Schema.Struct({
  manager: ServiceManager,
  file: Schema.String,
  /** Whether there was a service to remove. */
  removed: Schema.Boolean,
})
export type ServiceUninstalled = typeof ServiceUninstalled.Type

/** The service as its manager has it. */
export const ServiceState = Schema.TaggedUnion({
  /** The engine runs as the service, with this process ID. */
  Running: { pid: Schema.Int },
  /** The manager has the service but no engine runs: `state` is the manager's word for it. */
  Stopped: { state: Schema.String },
  /** The manager doesn't have the service. */
  NotLoaded: {},
})
export type ServiceState = typeof ServiceState.Type

/** `fabrica service status`'s answer. */
export const ServiceStatus = Schema.Struct({
  manager: ServiceManager,
  file: Schema.String,
  /** Whether the service's file is there. */
  installed: Schema.Boolean,
  state: ServiceState,
})
export type ServiceStatus = typeof ServiceStatus.Type

/** The launcher the service would run isn't there: the engine isn't installed (§9.2). */
export class LauncherMissing extends Data.TaggedError('LauncherMissing')<{
  readonly launcher: string
}> {
  override get message() {
    return `${this.launcher} isn't an executable file: install the engine with its install script, which links fabrica there, before the login service`
  }
}

/** A step of the login service's command failed: `step` is what it did, `reason` what was said. */
export class ServiceFailed extends Data.TaggedError('ServiceFailed')<{
  readonly step: string
  readonly reason: string
}> {
  override get message() {
    return `the login service couldn't ${this.step}: ${this.reason}`
  }
}
