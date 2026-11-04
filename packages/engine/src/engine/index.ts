// The engine daemon (spec §7.1, §7.2, §8.2): its data folder, lock, database, lifetimes, the Engine
// service, `fabrica serve` and `fabrica bridge`.
export {
  BridgeFailed,
  type BridgeOptions,
  EngineReached,
  EngineStartFailed,
  type ReachOptions,
  reachEngine,
  runBridge,
  startDetached,
} from './bridge'
export {
  type Live,
  MachineBudget,
  type MachineBudgetShape,
  type RunSeat,
  coreShare,
  makeMachineBudget,
  withCommandShare,
  workerShare,
} from './budget'
export {
  StoredSettingsInvalid,
  engineDatabaseLayer,
  engineMigrations,
} from './database'
export {
  type CoreTimes,
  type KernelReading,
  LOAD_INTERVAL,
  LoadProcesses,
  LoadReads,
  LoadSampler,
  type LoadSamplerShape,
  SampledTree,
  layerLoadSampler,
  layerNodeLoadReads,
  parseDarwinKernel,
  parseLinuxKernel,
} from './load'
export {
  EngineAlreadyRunning,
  FileLockFailed,
  LockFailed,
  acquireEngineLock,
  acquireFileLock,
} from './lock'
export {
  DataFolderFailed,
  EngineFiles,
  type EnginePaths,
  type HostPlaces,
  UnsupportedPlatform,
  enginePaths,
  userConfigFolder,
  pathsIn,
  prepareFolders,
} from './paths'
export { type ListenSettings, absoluteListenPaths } from './listen-settings'
export {
  EngineScopes,
  type EngineScopesShape,
  engineScopesLayer,
} from './scopes'
export {
  type DaemonServices,
  type RunHostingNeeds,
  type ServeOptions,
  StartingSettings,
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
