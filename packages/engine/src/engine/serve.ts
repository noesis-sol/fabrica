import { Context, Effect, Layer, Option, Scope } from 'effect'
import type { SqlClient } from 'effect/sql'
import * as NodePath from 'node:path'

import type { SqliteClient } from '@effect/sql-sqlite-node'
import { type ListenAddress, formatListenAddress } from '@fabrica/contracts'

import { Git, hostLayer as hostGitLayer } from '../git'
import { Projects, layer as projectsLayer } from '../projects/service'
import {
  CertificateFailed,
  engineCertificate,
  readCertificate,
} from '../rpc/certificate'
import { localRpcServer, removeStaleSocket } from '../rpc/server'
import { listenTls } from '../rpc/tls'
import { PairingTokens, pairingTokensLayer } from '../rpc/tokens'
import { Updater, layerRefusing } from '../update/service'
import { engineDatabaseLayer, storedEngineSettings } from './database'
import { acquireEngineLock } from './lock'
import { EngineFiles, type EnginePaths, prepareFolders } from './paths'
import { EngineScopes, engineScopesLayer } from './scopes'
import { Engine, type EngineFacts, engineLayer } from './service'

// The engine daemon (spec §7.1, §7.2, §8.2): `fabrica serve`. It makes its folders, takes the
// single-instance lock (a second engine fails here, saying so), opens and migrates engine.db, and
// serves the protocol on the local socket until it is asked to stop or its scope is interrupted
// (SIGTERM). Its scope then ends in order: the engine says it is stopping, the runs wind down, then
// the agents end, then the servers; then the projects' work graphs close, then the database, and the
// lock goes last. Asked to restart into an update, it says so as it returns, for its caller to start
// the new engine once the lock is released (§9.2). Where `fabrica serve --listen` or the engine's
// `listen` setting gives an address, it listens there over TLS too (§9.3), with the certificate they
// give or its own, the flags over the settings.

/**
 * The daemon's services, which every group's handler file may use as it builds its handlers and the
 * service layers it provides itself: the Engine, its lifetimes (a run's resources go in
 * `EngineScopes.runs`), its files, engine.db (`SqlClient`), whose tables their groups' handlers
 * read and write, its Git, its projects with their work graphs, and its Updater. A handler file that
 * needs another service provides it in its own file.
 */
export type DaemonServices =
  | Engine
  | EngineScopes
  | EngineFiles
  | SqlClient.SqlClient
  | SqliteClient.SqliteClient
  | Git
  | Projects
  | Updater
  | PairingTokens

/** The TLS listener's settings (§9.3), as the engine's settings and `fabrica serve`'s flags name them. */
export interface ListenSettings {
  readonly listen: Option.Option<ListenAddress>
  /** The certificate's PEM file; none: the engine's own. */
  readonly listen_certificate: Option.Option<string>
  /** Its private key's PEM file. */
  readonly listen_key: Option.Option<string>
}

const noListen: ListenSettings = {
  listen: Option.none(),
  listen_certificate: Option.none(),
  listen_key: Option.none(),
}

export interface ServeOptions extends EngineFacts {
  readonly paths: EnginePaths
  /** The engine's Git: git on its host (`hostLayer`) where none is given; a test gives its own. */
  readonly git?: Layer.Layer<Git>
  /** What installs the engine's updates (§9.2); where none is given, the engine refuses every update. */
  readonly update?: Layer.Layer<Updater>
  /** `fabrica serve`'s flags for the TLS listener, each over the engine's setting of the same name. */
  readonly listen?: ListenSettings
}

/** The listener's settings: each flag given, else the engine's setting; none from settings that don't decode. */
const listenSettings = Effect.fn('Engine.listenSettings')(function* (
  flags: ListenSettings,
) {
  const stored = yield* storedEngineSettings().pipe(
    Effect.map((settings): ListenSettings => ({
      listen: settings.listen,
      listen_certificate: settings.listen_certificate,
      listen_key: settings.listen_key,
    })),
    Effect.catchTag('StoredSettingsInvalid', error =>
      Effect.as(
        Effect.logWarning(
          `the TLS listener's settings weren't read: ${error.message}`,
        ),
        noListen,
      ),
    ),
  )
  return {
    listen: Option.orElse(flags.listen, () => stored.listen),
    listen_certificate: Option.orElse(
      flags.listen_certificate,
      () => stored.listen_certificate,
    ),
    listen_key: Option.orElse(flags.listen_key, () => stored.listen_key),
  } satisfies ListenSettings
})

/**
 * The listener's certificate: the user's, where both its files are given (a relative path is taken
 * from where the engine runs), else the engine's own.
 */
const listenerCertificate = (paths: EnginePaths, settings: ListenSettings) => {
  const absolute = Option.map((path: string) => NodePath.resolve(path))
  const certificate = absolute(settings.listen_certificate)
  const key = absolute(settings.listen_key)
  if (Option.isSome(certificate) && Option.isSome(key))
    return readCertificate({ certificate: certificate.value, key: key.value })
  if (Option.isSome(certificate) || Option.isSome(key))
    return Effect.fail(
      new CertificateFailed({
        reason:
          'listen_certificate and listen_key are given together, or neither is',
      }),
    )
  return engineCertificate({
    certificate: paths.certificate,
    key: paths.certificateKey,
  })
}

/** Starts the engine in the current scope and returns it once its socket takes connections. */
export const startEngine = Effect.fn('Engine.start')(function* (
  options: ServeOptions,
) {
  yield* prepareFolders(options.paths)
  yield* acquireEngineLock(options.paths)
  yield* removeStaleSocket(options.paths.socket)
  const database = yield* Layer.build(
    engineDatabaseLayer(options.paths.database),
  )
  const files = Context.make(EngineFiles, options.paths)
  const git = yield* Layer.build(options.git ?? hostGitLayer)
  // Built before the scopes, so the work graphs close after the runs, the agents and the servers.
  const projects = yield* Layer.build(projectsLayer).pipe(
    Effect.provide(Context.mergeAll(database, files, git)),
  )
  const scopes = yield* Layer.build(engineScopesLayer)
  const servers = Context.get(scopes, EngineScopes).servers
  const tokens = yield* Layer.build(pairingTokensLayer).pipe(
    Effect.provide(database),
  )
  const listen = yield* listenSettings(options.listen ?? noListen).pipe(
    Effect.provide(database),
  )
  const listener = yield* Effect.transposeOption(
    Option.map(listen.listen, address =>
      listenerCertificate(options.paths, listen).pipe(
        Effect.flatMap(certificate => listenTls({ address, certificate })),
        Scope.provide(servers),
        Effect.provide(tokens),
      ),
    ),
  )
  const engine = yield* Layer.build(
    engineLayer(
      options,
      Option.map(listener, ({ endpoint }) => endpoint),
    ),
  ).pipe(Effect.provide(database))
  const updater = yield* Layer.build(
    options.update ??
      layerRefusing('this engine was started with nowhere to install updates'),
  )
  const services: Context.Context<DaemonServices> = Context.mergeAll(
    database,
    scopes,
    engine,
    files,
    git,
    projects,
    updater,
    tokens,
  )
  yield* Layer.buildWithScope(
    localRpcServer(
      options.paths.socket,
      Option.map(listener, ({ server }) => server),
    ),
    servers,
  ).pipe(Effect.provide(services))
  return Context.get(engine, Engine)
})

/**
 * Runs the engine until it is asked to stop (`engine.stop`, `engine.update`) or interrupted; returns
 * what it was asked to do once its scope has ended.
 */
export const serveEngine = Effect.fn('Engine.serve')(function* (
  options: ServeOptions,
) {
  const engine = yield* startEngine(options)
  yield* Effect.logInfo(`the engine serves ${options.paths.socket}`)
  if (Option.isSome(engine.listening)) {
    const { address, fingerprint } = engine.listening.value
    yield* Effect.logInfo(
      `the engine listens on ${formatListenAddress(address)} over TLS; its certificate's SHA-256 fingerprint is ${fingerprint}`,
    )
  }
  return yield* engine.stopRequested
})
