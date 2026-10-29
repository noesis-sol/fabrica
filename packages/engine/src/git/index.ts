// Git and tickets' worktrees (spec §13.7, §10.2, §11.7, §20.2): the Git service and the Worktrees service.
export {
  type Commands,
  type GitCommand,
  type GitConfig,
  type GitExit,
  GIT_ENVIRONMENT,
  defaultConfig,
  makeCommands,
} from './command'
export * from './errors'
export * from './outcomes'
export * from './parse'
export { Git, type GitShape, layer, make } from './service'
export {
  Prepared,
  type TicketWorktree,
  type Worktree,
  type WorktreeHome,
  Worktrees,
  type WorktreesShape,
  besideCheckout,
  branchTicket,
  inFolder,
  layer as worktreesLayer,
  make as makeWorktrees,
  ticketBranch,
  worktreePath,
} from './worktrees'
