import { Context, Effect, Layer } from 'effect'

import { localRpcServer, removeStaleSocket } from '../rpc/server'
import { engineDatabaseLayer } from './database'
import { acquireEngineLock } from './lock'
import { type EnginePaths, prepareFolders } from './paths'
import { EngineScopes, engineScopesLayer } from './scopes'
import { Engine, type EngineFacts, engineLayer } from './service'

// The engine daemon (spec §7.1, §7.2, §8.2): `fabrica serve`. It makes its folders, takes the
// single-instance lock (a second engine fails here, saying so), opens and migrates engine.db, and
// serves the protocol on the local socket until it is asked to stop or its scope is interrupted
// (SIGTERM). Its scope then ends in order: the engine says it is stopping, the runs wind down, then
// the agents end, then the servers; then the database closes and the lock goes last.

export interface ServeOptions extends EngineFacts {
  readonly paths: EnginePaths
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
  const scopes = yield* Layer.build(engineScopesLayer)
  const engine = yield* Layer.build(engineLayer(options)).pipe(
    Effect.provide(database),
  )
  yield* Layer.buildWithScope(
    localRpcServer(options.paths.socket),
    Context.get(scopes, EngineScopes).servers,
  ).pipe(Effect.provide(engine))
  return Context.get(engine, Engine)
})

/** Runs the engine until it is asked to stop (`engine.stop`) or interrupted. */
export const serveEngine = Effect.fn('Engine.serve')(function* (
  options: ServeOptions,
) {
  const engine = yield* startEngine(options)
  yield* Effect.logInfo(`the engine serves ${options.paths.socket}`)
  yield* engine.stopRequested
})
