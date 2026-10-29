// The merge queue (spec §13.7): finished tickets' merges onto Base, one at a time, as named steps.
export * from './outcome'
export {
  type MergeLine,
  MergeQueue,
  type MergeQueueShape,
  layer,
  make,
} from './queue'
export {
  MergeSetup,
  type MergeSetupShape,
  SetupOutcome,
  isSetupFile,
  noSetup,
  setupFilesBrought,
} from './setup'
export { Step, makeMachine, stepName } from './steps'
export { MachineHold, type MergeTrain, makeTrain } from './train'
export type { MergeConfig, MergeTurn } from './turn'
