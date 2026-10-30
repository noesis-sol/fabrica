import { createRequire } from 'node:module'

// The Electron the tests that draw in a window run (test/look.test.ts, test/monaco-diff.test.ts), and
// the ui project's global setup, which installs it before any test file runs. Electron's package
// installs its binary the first time it is loaded, not when pnpm installs it, so in a worktree pnpm has
// just set up (tutti's merge check's) two files loading it side by side both unzipped it into the same
// folder, and one failed outside its tests ("File exists", then "Electron failed to install correctly")
// and passed on its rerun (fab-adb). Loaded once here first, it is installed before they start.

/** Where Electron's binary is: what its package gives Node, installing it where it isn't yet. */
export const electronBinary = (): string => {
  const path: unknown = createRequire(import.meta.url)('electron')
  if (typeof path !== 'string') {
    throw new Error("electron's package gave no binary's path")
  }
  return path
}

/**
 * The global setup: installs Electron. One it can't install (offline, its download not cached) fails
 * only the tests that run it, as they load it again and say why, not the project's other tests.
 */
export default (): void => {
  try {
    electronBinary()
  } catch {
    // The tests that need it fail on it themselves.
  }
}
