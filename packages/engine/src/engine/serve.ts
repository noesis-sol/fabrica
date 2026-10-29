import { Context, Effect, Layer } from 'effect'
import type { SqlClient } from 'effect/sql'

import type { SqliteClient } from '@effect/sql-sqlite-node'

import { Git, hostLayer as hostGitLayer } from '../git'
import { Projects, layer as projectsLayer } from '../projects/service'
import { localRpcServer, removeStaleSocket } from '../rpc/server'
import { Updater, layerRefusing } from '../update/service'
import { engineDatabaseLayer } from './database'
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
// the new engine once the lock is released (§9.2).

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

export interface ServeOptions extends EngineFacts {
  readonly paths: EnginePaths
  /** The engine's Git: git on its host (`hostLayer`) where none is given; a test gives its own. */
  readonly git?: Layer.Layer<Git>
  /** What installs the engine's updates (§9.2); where none is given, the engine refuses every update. */
  readonly update?: Layer.Layer<Updater>
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
  const engine = yield* Layer.build(engineLayer(options)).pipe(
    Effect.provide(database),
  )
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
  )
  yield* Layer.buildWithScope(
    localRpcServer(options.paths.socket),
    Context.get(scopes, EngineScopes).servers,
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
  return yield* engine.stopRequested
})
