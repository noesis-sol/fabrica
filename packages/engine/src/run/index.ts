// The run (spec §13): one run of a project, from its start checks to its end line and exit code.
export * from './config'
export { type RunControl, makeRunControl } from './control'
export {
  RunHosting,
  RunHostingShape,
  type RunServices,
  refusingRuns,
} from './hosting'
export { type RunEnd, runProject } from './loop'
export {
  type CitedSpec,
  type Dependency,
  type SpecSection,
  citedSections,
  firstPrompt,
  specSection,
} from './prompt'
export {
  type RunSnapshot,
  type RunStateShape,
  type TicketState,
  inPhase,
  inProgress,
  makeRunState,
  slotsTaken,
} from './state'
export {
  StartChecked,
  type Started,
  modelName,
  runStartChecks,
} from './start-checks'
export { WakeReason, readsReady } from './wakes'
export { WorkerEnd } from './worker'
