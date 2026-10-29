import { Effect, Layer, Option, Schedule, Schema } from 'effect'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'
import { promisify } from 'node:util'
import { type ElectronApplication, _electron } from 'playwright-core'
import { inject } from 'vitest'

import { describe, expect, it, layer } from '@effect/vitest'
import { Toolbox, type Tools, layerToolbox } from '@fabrica/testkit'

import { bundledLauncher } from '../src/main/local-engine'
import { noUpdateCheck } from '../src/main/updates'

// The packaged app's smoke test (spec §22.3, §24): one artifact's app, driven through Playwright's
// Electron support as a user would, the build under test as it ships, fuses and all (spike
// fab-mgi.2.6). It is run by vitest.smoke.config.ts on the app it names, never by the unit suite.
//
// - It launches, and shows the console.
// - On macOS and Linux, it starts its bundled engine, none answering, and reaches it: the engine counts
//   the app's connection among its clients. The Windows app reaches its engine in WSL2 (§7.6), which it
//   doesn't do yet (fab-mgi.6.7).
// - It closes cleanly: once the app has quit and the engine it started is stopped, none of their
//   processes is left.
//
// Opening a fixture repository through the console waits on the console surviving the engine's
// answers to what it doesn't serve yet (fab-mgi.87), and running one ticket to its merge with a stub
// model on the run loop and the model proxy (fab-mgi.88).
//
// The app runs in a home folder of the test's, with the data folders under it, so it reaches no
// engine of the machine's and leaves nothing behind; on POSIX its PATH is a toolbox holding git, which the
// engine runs. The
// app's processes are waited for by polling: they aren't the test's children, so no event tells of
// their exit.

declare module 'vitest' {
  export interface ProvidedContext {
    /** The packaged app's executable. */
    smokeApp: string
    /** The host's variables the app can't start without (vitest.smoke.config.ts). */
    smokeHost: Record<string, string>
  }
}

const app = inject('smokeApp')
const host = inject('smokeHost')
const posix = process.platform !== 'win32'

/** How long the app has to show its console, reach its engine, or leave no process behind, each. */
const stepTimeout = 60_000

const run = promisify(execFile)

/**
 * The test's home folder: short on POSIX, since the engine's socket is under it on macOS, and a socket's
 * path has a length limit (104 bytes), which the system's temp folder there leaves too little of.
 */
const homeFolder = Effect.acquireRelease(
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

/** The app's environment: the toolbox's on POSIX, the host's few variables, and the folders in `home`. */
const appEnv = (
  tools: Tools,
  home: string,
): Effect.Effect<Readonly<Record<string, string>>> =>
  Effect.promise(async () => {
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

/** The app launched, killed with the scope if the test didn't close it. */
const launch = (env: Readonly<Record<string, string>>) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const electron = await _electron.launch({
        executablePath: app,
        args: [`--${noUpdateCheck}`],
        env,
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

/** The app's processes as Electron counts them: main, the renderer, the GPU and utility processes. */
const appProcesses = (electron: ElectronApplication) =>
  Effect.promise(() =>
    electron.evaluate(({ app }) => app.getAppMetrics().map(({ pid }) => pid)),
  )

/** Whether the process `pid` is alive. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The command lines of the processes that run a file under any of `folders`. */
const processesUnder = (folders: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const { stdout } = await run('/bin/ps', ['-A', '-o', 'pid=,command='])
    return stdout
      .split('\n')
      .filter(line => folders.some(folder => line.includes(folder)))
  })

/** `check`'s value once it holds, checked every 100 ms; after a minute, its value then, for the test to fail on. */
const eventually = <A>(
  check: Effect.Effect<A>,
  holds: (value: A) => boolean,
): Effect.Effect<A> =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced('100 millis'), until: holds }),
    Effect.timeoutOption(stepTimeout),
    Effect.flatMap(
      Option.match({ onSome: Effect.succeed, onNone: () => check }),
    ),
  )

const EngineClients = Schema.fromJsonString(
  Schema.Struct({ clients: Schema.Number }),
)
const decodeClients = Schema.decodeUnknownOption(EngineClients)

/** How many clients the engine counts, through the bundled `fabrica engine status`: none while it doesn't answer. */
const engineClients = (
  launcher: string,
  env: Readonly<Record<string, string>>,
): Effect.Effect<Option.Option<number>> =>
  Effect.promise(() =>
    run(launcher, ['engine', 'status', '--json'], { env }).then(
      ({ stdout }) =>
        Option.map(decodeClients(stdout), ({ clients }) => clients),
      () => Option.none<number>(),
    ),
  )

/** Stops the engine through the bundled `fabrica engine stop`, as its user would; one gone already is left. */
const stopEngine = (
  launcher: string,
  env: Readonly<Record<string, string>>,
): Effect.Effect<void> =>
  Effect.promise(() =>
    run(launcher, ['engine', 'stop'], { env }).then(
      () => undefined,
      () => undefined,
    ),
  )

const toolbox: Layer.Layer<Toolbox, unknown> = posix
  ? layerToolbox({ tools: ['git'] })
  : Layer.succeed(Toolbox)({ bin: '', home: '', env: () => ({}) })

describe('the packaged app', () => {
  it('names the app to test', () => {
    expect(app, 'FABRICA_SMOKE_APP names no app').not.toBe('')
  })

  layer(toolbox)(it => {
    it.effect(
      'launches, reaches its engine and closes with no process left',
      () =>
        Effect.gen(function* () {
          const tools = yield* Toolbox
          const home = yield* homeFolder
          const env = yield* appEnv(tools, home)
          const { electron } = yield* launch(env)
          const page = yield* Effect.promise(() => electron.firstWindow())
          yield* Effect.promise(() =>
            page
              .locator('header[aria-label="Title bar"]')
              .waitFor({ timeout: stepTimeout }),
          )
          const resources = yield* Effect.promise(() =>
            electron.evaluate(() => process.resourcesPath),
          )
          // The engine runs from the app's resources, so the app's folder holds every process of both.
          const appFolder = NodePath.dirname(resources)

          const engine = posix
            ? Option.some(bundledLauncher(resources))
            : Option.none<string>()
          if (Option.isSome(engine)) {
            // Stopped whatever the test finds, so a failed run leaves no engine behind.
            yield* Effect.addFinalizer(() => stopEngine(engine.value, env))
            // The app's connection, and the CLI's own asking.
            const clients = yield* eventually(
              engineClients(engine.value, env),
              clients => Option.getOrElse(clients, () => 0) >= 2,
            )
            expect(clients).toEqual(Option.some(2))
          }

          const processes = yield* appProcesses(electron)
          expect(processes.length).toBeGreaterThan(1)
          yield* Effect.promise(() => electron.close())
          // Closing the app leaves its engine running (§7.1): it is stopped as the user would stop it.
          if (Option.isSome(engine)) {
            yield* stopEngine(engine.value, env)
          }
          const left = yield* eventually(
            Effect.map(
              posix ? processesUnder([appFolder, home]) : Effect.succeed([]),
              lines => [
                ...processes
                  .filter(alive)
                  .map(pid => `${pid} (one of the app's)`),
                ...lines,
              ],
            ),
            lines => lines.length === 0,
          )
          expect(left).toEqual([])
        }),
    )
  })
})
