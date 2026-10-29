import type { UpdateStatus } from '../preload/api'

// Where the app's update stands (spec §22.2), held in main and pushed to the page as it changes.
// The updater sets it; a build without one keeps it Unavailable.

/** The current update status, and its changes. */
export interface UpdateStatusCell {
  readonly get: () => UpdateStatus
  readonly set: (status: UpdateStatus) => void
  /** Calls `listener` with each status set from now; the function returned stops it. */
  readonly subscribe: (listener: (status: UpdateStatus) => void) => () => void
}

/** A cell holding `initial`. */
export const makeUpdateStatusCell = (
  initial: UpdateStatus,
): UpdateStatusCell => {
  let current = initial
  const listeners = new Set<(status: UpdateStatus) => void>()
  return {
    get: () => current,
    set: status => {
      current = status
      for (const listener of listeners) {
        listener(status)
      }
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
