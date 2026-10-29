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
} from './setup'
export { Step, makeMachine, stepName } from './steps'
export type { MergeConfig, MergeTurn } from './turn'
