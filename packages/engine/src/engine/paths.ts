import { Context, Data, Effect, Option, Result } from 'effect'
import { chmod, lstat, mkdir } from 'node:fs/promises'
import * as NodePath from 'node:path'

// The engine's data folder and its files (spec §7.2, §8.2, §20.2): where they are on each platform,
// and the folders made so only the engine's user can enter them. The host's facts (its platform, the
// home folder, the environment) are given, never read here.

/** What the engine's paths are found from. */
export interface HostPlaces {
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly environment: Readonly<Record<string, string | undefined>>
}

/** The engine's files. */
export interface EnginePaths {
  /** `<data>`: the engine's data folder. */
  readonly data: string
  /** `<data>/engine.db`: projects, tokens (hashed), settings. */
  readonly database: string
  /** `<data>/engine.lock`: the single-instance lock. */
  readonly lock: string
  /** The local RPC socket's folder: `<data>`, or `$XDG_RUNTIME_DIR/fabrica` on Linux. */
  readonly socketFolder: string
  /** The local RPC socket, mode 0600. */
  readonly socket: string
  /** `<data>/logs`: the engine's own log's folder. */
  readonly logs: string
  /** `<data>/tls-certificate.pem`: the TLS listener's own certificate, where the user gives none (§9.3). */
  readonly certificate: string
  /** `<data>/tls-key.pem`: its private key, mode 0600. */
  readonly certificateKey: string
  /** `<data>/telemetry.db`: the telemetry rows (§21). */
  readonly telemetry: string
  /** `<data>/telemetry.duckdb`: the telemetry query layer (§21). */
  readonly telemetryQueries: string
}

/** The running engine's files, for the services and handlers that use them. */
export class EngineFiles extends Context.Service<EngineFiles, EnginePaths>()(
  '@fabrica/engine/EngineFiles',
) {}

/** A platform the engine doesn't run on: the engine is POSIX-only (§4). */
export class UnsupportedPlatform extends Data.TaggedError(
  'UnsupportedPlatform',
)<{ readonly platform: string }> {
  override get message() {
    return `the engine runs on macOS and Linux, not ${this.platform}`
  }
}

/** A folder of the engine's that couldn't be made, or is something else than a folder of the engine user's. */
export class DataFolderFailed extends Data.TaggedError('DataFolderFailed')<{
  readonly folder: string
  readonly reason: string
}> {
  override get message() {
    return `the engine's folder ${this.folder} couldn't be used: ${this.reason}`
  }
}

/** A variable's value, where it is set to an absolute path; the XDG specification ignores any other. */
export const absoluteVariable = (
  environment: HostPlaces['environment'],
  name: string,
): Option.Option<string> =>
  Option.filter(
    Option.fromUndefinedOr(environment[name]),
    value => value !== '' && NodePath.isAbsolute(value),
  )

/** The engine's files with its data folder at `data` and its socket in `socketFolder`. */
export const pathsIn = (options: {
  readonly data: string
  readonly socketFolder: string
}): EnginePaths => ({
  data: options.data,
  database: NodePath.join(options.data, 'engine.db'),
  lock: NodePath.join(options.data, 'engine.lock'),
  socketFolder: options.socketFolder,
  socket: NodePath.join(options.socketFolder, 'engine.sock'),
  logs: NodePath.join(options.data, 'logs'),
  certificate: NodePath.join(options.data, 'tls-certificate.pem'),
  certificateKey: NodePath.join(options.data, 'tls-key.pem'),
  telemetry: NodePath.join(options.data, 'telemetry.db'),
  telemetryQueries: NodePath.join(options.data, 'telemetry.duckdb'),
})

/**
 * The engine's files on a host (§7.2): `~/Library/Application Support/fabrica/` on macOS,
 * `$XDG_DATA_HOME/fabrica/` on Linux (`~/.local/share` where it isn't set), the socket under
 * `$XDG_RUNTIME_DIR/fabrica/` on Linux where that is set (§8.2).
 */
export const enginePaths = (
  host: HostPlaces,
): Result.Result<EnginePaths, UnsupportedPlatform> => {
  switch (host.platform) {
    case 'darwin': {
      const data = NodePath.join(
        host.home,
        'Library',
        'Application Support',
        'fabrica',
      )
      return Result.succeed(pathsIn({ data, socketFolder: data }))
    }
    case 'linux': {
      const data = NodePath.join(
        Option.getOrElse(
          absoluteVariable(host.environment, 'XDG_DATA_HOME'),
          () => NodePath.join(host.home, '.local', 'share'),
        ),
        'fabrica',
      )
      const socketFolder = Option.match(
        absoluteVariable(host.environment, 'XDG_RUNTIME_DIR'),
        {
          onNone: () => data,
          onSome: runtime => NodePath.join(runtime, 'fabrica'),
        },
      )
      return Result.succeed(pathsIn({ data, socketFolder }))
    }
    default:
      return Result.fail(new UnsupportedPlatform({ platform: host.platform }))
  }
}

/** Makes `folder` (and its parents) where it is missing, and leaves it mode 0700: only its user enters it. */
const privateFolder = Effect.fn('Engine.privateFolder')(function* (
  folder: string,
) {
  const failed = (reason: unknown) =>
    new DataFolderFailed({
      folder,
      reason: reason instanceof Error ? reason.message : String(reason),
    })
  yield* Effect.tryPromise({
    try: () => mkdir(folder, { recursive: true, mode: 0o700 }),
    catch: failed,
  })
  const info = yield* Effect.tryPromise({
    try: () => lstat(folder),
    catch: failed,
  })
  if (!info.isDirectory()) return yield* failed('it is not a folder')
  if (info.uid !== process.getuid?.()) {
    return yield* failed('it belongs to another user')
  }
  yield* Effect.tryPromise({
    try: () => chmod(folder, 0o700),
    catch: failed,
  })
})

/** Makes the data folder, its logs folder and the socket's folder, each only the engine's user can enter (§20.2). */
export const prepareFolders = Effect.fn('Engine.prepareFolders')(function* (
  paths: EnginePaths,
) {
  yield* privateFolder(paths.data)
  const inside = [paths.logs, paths.socketFolder].filter(
    folder => folder !== paths.data,
  )
  yield* Effect.forEach(inside, privateFolder, { concurrency: 'unbounded' })
})
