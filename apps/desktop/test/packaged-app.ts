import { Duration, Effect, Layer, Option, Schedule } from 'effect'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'
import { promisify } from 'node:util'
import { _electron } from 'playwright-core'

import { Toolbox, type Tools, layerToolbox } from '@fabrica/testkit'

import { appId, userDataSwitch } from '../src/main/dataFolder'

// What the packaged app's tests share (spec §22.3, §24): the smoke test (smoke.test.ts) and the update
// test (update-smoke.test.ts) each launch a packaged app through Playwright's Electron support, in a home
// folder of the test's, with the data folders under it, so it reaches no engine of the machine's and
// leaves nothing behind; on POSIX its PATH is a toolbox holding git, which the engine runs. On macOS the
// app's own data folder is named by `--user-data-dir` (dataFolderArgs): Electron's appData there is the
// user's whatever HOME says, and an app of the user's running, or another test's, would hold the single-
// instance lock in it, so the app under test quits at launch, or waits 20 s on a holder that doesn't answer.

declare module 'vitest' {
  export interface ProvidedContext {
    /** The host's variables the app can't start without (vitest.smoke.config.ts). */
    smokeHost: Record<string, string>
  }
}

export const posix = process.platform !== 'win32'

/** How long the app has to show its console, reach its engine, or leave no process behind, each. */
export const stepTimeout = 60_000

export const run = promisify(execFile)

/**
 * The test's home folder: short on POSIX, since the engine's socket is under it on macOS, and a socket's
 * path has a length limit (104 bytes), which the system's temp folder there leaves too little of.
 */
export const homeFolder = Effect.acquireRelease(
  Effect.promise(async () =>
    realpath(
      await mkdtemp(NodePath.join(posix ? '/tmp' : tmpdir(), 'fabrica-smoke-')),
    ),
  ),
  home =>
    Effect.promise(() => rm(home, { recursive: true, force: true })).pipe(
      Effect.ignore,
    ),
)

/**
 * The app's environment: the toolbox's on POSIX, the host's few variables the app can't start without
 * (`host`, read by the test's config), and the folders in `home`.
 */
export const appEnv = (options: {
  readonly tools: Tools
  readonly home: string
  readonly host: Readonly<Record<string, string>>
}): Effect.Effect<Readonly<Record<string, string>>> =>
  Effect.promise(async () => {
    const { tools, home, host } = options
    if (!posix) {
      return {
        ...host,
        USERPROFILE: home,
        APPDATA: NodePath.join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: NodePath.join(home, 'AppData', 'Local'),
        TEMP: home,
        TMP: home,
      }
    }
    const runtime = NodePath.join(home, 'run')
    await mkdir(runtime, { mode: 0o700 })
    return {
      ...tools.env(),
      ...host,
      HOME: home,
      XDG_CONFIG_HOME: NodePath.join(home, '.config'),
      XDG_DATA_HOME: NodePath.join(home, '.local', 'share'),
      XDG_CACHE_HOME: NodePath.join(home, '.cache'),
      XDG_RUNTIME_DIR: runtime,
    }
  })

/**
 * The switches that keep the app's own data folder in `home` (src/main/dataFolder.ts): on macOS, the folder
 * the app would have with `home` its user's; elsewhere none, appEnv's folders doing it.
 */
export const dataFolderArgs = (home: string): ReadonlyArray<string> =>
  process.platform === 'darwin'
    ? [
        `--${userDataSwitch}=${NodePath.join(home, 'Library', 'Application Support', appId)}`,
      ]
    : []

/** The packaged app `executable` launched with `args`, killed with the scope if the test didn't close it. */
export const launch = (options: {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
}) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const electron = await _electron.launch({
        executablePath: options.executable,
        args: [...options.args],
        env: options.env,
        // The app's renderer is sandboxed (§20.1): Playwright leaves Linux's sandbox on only so.
        chromiumSandbox: true,
        timeout: stepTimeout,
      })
      return { electron, main: electron.process() }
    }),
    ({ main }) =>
      Effect.sync(() => {
        if (main.exitCode === null && main.signalCode === null) {
          main.kill()
        }
      }),
  )

/**
 * `check`'s value once it holds, checked every 100 ms; after `within` (a step's time by default), its
 * value then, for the test to fail on. On the live clock: under the TestClock `it.effect` gives by default,
 * a check that doesn't hold at once is never checked again, and the test waits out its timeout.
 */
export const eventually = <A>(
  check: Effect.Effect<A>,
  holds: (value: A) => boolean,
  within: Duration.Input = stepTimeout,
): Effect.Effect<A> =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced('100 millis'), until: holds }),
    Effect.timeoutOption(within),
    Effect.flatMap(
      Option.match({ onSome: Effect.succeed, onNone: () => check }),
    ),
  )

/** Stops the engine through the bundled `fabrica engine stop`, as its user would; one gone already is left. */
export const stopEngine = (
  launcher: string,
  env: Readonly<Record<string, string>>,
): Effect.Effect<void> =>
  Effect.promise(() =>
    run(launcher, ['engine', 'stop'], { env }).then(
      () => undefined,
      () => undefined,
    ),
  )

/** The toolbox the app's PATH is on POSIX; none on Windows, where there is no engine to keep from the host's. */
export const toolbox: Layer.Layer<Toolbox, unknown> = posix
  ? layerToolbox({ tools: ['git'] })
  : Layer.succeed(Toolbox)({ bin: '', home: '', env: () => ({}) })
