// Checks and setups (spec §13.6–§13.9): running a project's command in a worktree, and what it came to.
export * from './command'
export * from './outcome'
export {
  type CheckInput,
  Checks,
  type ChecksShape,
  layer,
  make,
} from './service'
