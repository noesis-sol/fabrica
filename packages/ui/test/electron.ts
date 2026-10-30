import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron } from 'playwright-core'

// The Electron the tests that draw in a window run (test/look.test.ts, test/monaco-diff.test.ts), and
// the ui project's global setup, which installs it before any test file runs. Electron's package
// installs its binary the first time it is loaded, not when pnpm installs it, so in a worktree pnpm has
// just set up (tutti's merge check's) two files loading it side by side both unzipped it into the same
// folder, and one failed outside its tests ("File exists", then "Electron failed to install correctly")
// and passed on its rerun (fab-adb). Loaded once here first, it is installed before they start.
//
// Each Electron runs on a profile folder of its own (its user data, Chromium's --user-data-dir), not
// Electron's default in the home folder, which every test's Electron in every worktree shared, with
// the locks Chromium holds on its stores there. And it is ended, not asked to quit: Playwright's close
// waits on Electron's app.quit() with no limit, and a quit that takes 0.3 s at a load of 100 now and
// then never ended, failing the file's afterAll outside its tests (fab-adb). The tests need nothing of
// a graceful quit, their profile is thrown away, and Chromium's helper processes end with it.

/** Where Electron's binary is: what its package gives Node, installing it where it isn't yet. */
export const electronBinary = (): string => {
  const path: unknown = createRequire(import.meta.url)('electron')
  if (typeof path !== 'string') {
    throw new Error("electron's package gave no binary's path")
  }
  return path
}

/** An Electron started, and its quit: its process killed, then its profile folder removed. */
export interface Launched {
  readonly app: ElectronApplication
  readonly quit: () => Promise<void>
}

/** Starts Electron with `args` (its switches and the main script) on a profile folder of its own. */
export const launchElectron = async (
  args: ReadonlyArray<string>,
): Promise<Launched> => {
  const profile = mkdtempSync(join(tmpdir(), 'fabrica-electron-'))
  const removeProfile = () => rmSync(profile, { recursive: true, force: true })
  try {
    const app = await _electron.launch({
      executablePath: electronBinary(),
      args: [`--user-data-dir=${profile}`, ...args],
    })
    return {
      app,
      quit: async () => {
        const child = app.process()
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit')
          child.kill('SIGKILL')
          await exited
        }
        removeProfile()
      },
    }
  } catch (error) {
    removeProfile()
    throw error
  }
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
