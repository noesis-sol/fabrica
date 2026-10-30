import { Effect, Option, Schema } from 'effect'
import * as NodePath from 'node:path'
import type { ElectronApplication } from 'playwright-core'
import { inject } from 'vitest'

import { describe, expect, it, layer } from '@effect/vitest'
import { Toolbox } from '@fabrica/testkit'

import { noUpdateCheck } from '../src/main/updates'
import {
  appEngine,
  appEnv,
  dataFolderArgs,
  eventually,
  homeFolder,
  launch,
  posix,
  run,
  stepTimeout,
  stopEngine,
  toolbox,
} from './packaged-app'

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
// The app runs in a home folder of the test's (packaged-app.ts). The app's processes are waited for by
// polling: they aren't the test's children, so no event tells of their exit.

declare module 'vitest' {
  export interface ProvidedContext {
    /** The packaged app's executable. */
    smokeApp: string
  }
}

const app = inject('smokeApp')
const host = inject('smokeHost')

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

describe('the packaged app', () => {
  it('names the app to test', () => {
    expect(app, 'FABRICA_SMOKE_APP names no app').not.toBe('')
  })

  // The app and its engine run on the live clock, which eventually's checks wait on.
  layer(toolbox, { excludeTestServices: true })(it => {
    it.effect(
      'launches, reaches its engine and closes with no process left',
      () =>
        Effect.gen(function* () {
          const tools = yield* Toolbox
          const home = yield* homeFolder
          const env = yield* appEnv({ tools, home, host })
          const { electron } = yield* launch({
            executable: app,
            args: [`--${noUpdateCheck}`, ...dataFolderArgs(home)],
            env,
          })
          const page = yield* Effect.promise(() => electron.firstWindow())
          yield* Effect.promise(() =>
            page
              .locator('header[aria-label="Title bar"]')
              .waitFor({ timeout: stepTimeout }),
          )
          const resources = yield* Effect.promise(() =>
            electron.evaluate(() => process.resourcesPath),
          )
          // The engine runs from its copy under the home folder (§7.1), so the app's folder and the
          // home folder hold every process of both.
          const appFolder = NodePath.dirname(resources)

          const engine = posix
            ? Option.some((yield* appEngine({ electron, home })).installed)
            : Option.none<string>()
          if (Option.isSome(engine)) {
            // Stopped whatever the test finds, so a failed run leaves no engine behind.
            yield* Effect.addFinalizer(() => stopEngine([engine.value], env))
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
            yield* stopEngine([engine.value], env)
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
