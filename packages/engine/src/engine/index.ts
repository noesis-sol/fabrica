// The engine daemon (spec §7.1, §7.2, §8.2): its data folder, lock, database, lifetimes, the Engine
// service, `fabrica serve` and `fabrica bridge`.
export { BridgeFailed, type BridgeOptions, runBridge } from './bridge'
export {
  StoredSettingsInvalid,
  engineDatabaseLayer,
  engineMigrations,
} from './database'
export { EngineAlreadyRunning, LockFailed, acquireEngineLock } from './lock'
export {
  DataFolderFailed,
  EngineFiles,
  type EnginePaths,
  type HostPlaces,
  UnsupportedPlatform,
  enginePaths,
  pathsIn,
  prepareFolders,
} from './paths'
export {
  EngineScopes,
  type EngineScopesShape,
  engineScopesLayer,
} from './scopes'
export {
  type DaemonServices,
  type ServeOptions,
  serveEngine,
  startEngine,
} from './serve'
export {
  Engine,
  EngineEnd,
  type EngineFacts,
  type EngineShape,
  engineLayer,
} from './service'
