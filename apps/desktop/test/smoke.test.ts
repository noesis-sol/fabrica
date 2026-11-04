import { Effect, Option, Schema } from 'effect'
import { mkdir, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
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
import { committed, stubModel } from './stub-model'

// The packaged app's smoke test (spec §22.3, §24): one artifact's app, driven through Playwright's
// Electron support as a user would, the build under test as it ships, fuses and all (spike
// fab-mgi.2.6). It is run by vitest.smoke.config.ts on the app it names, never by the unit suite.
//
// - It launches, and shows the console.
// - On macOS and Linux, it starts its bundled engine, none answering, and reaches it: the engine counts
//   the app's connection among its clients. It opens a fixture repository through the console (Add
//   project), and runs one ticket to its merge with a stub model (stub-model.ts): the real Pi, through the
//   engine's model proxy. The ticket is filed with the bundled CLI, as the console files none but a
//   worker's.
// - The Windows app adds its engine in WSL2 through the console (§7.6), installing the Linux distribution it
//   embeds, and reaches it, where it is told to (FABRICA_SMOKE_WSL, §22.3): on a signed release's call with
//   WSL2 ready, as the app installs only a signed engine, and otherwise downloads its version's release. The
//   project and the run are the engine's, which macOS and Linux test as it ships.
// - It closes cleanly: once the app has quit and the engine it started is stopped, none of their
//   processes is left.
//
// The app runs in a home folder of the test's (packaged-app.ts). The app's processes are waited for by
// polling: they aren't the test's children, so no event tells of their exit.

declare module 'vitest' {
  export interface ProvidedContext {
    /** The packaged app's executable. */
    smokeApp: string
    /** Whether the Windows app is to add its engine in WSL2: it has a signed engine, and WSL2 a distribution. */
    smokeWsl: boolean
  }
}

const app = inject('smokeApp')
const host = inject('smokeHost')
const wsl = inject('smokeWsl')

/** How long a ticket has to run to its merge, and the engine to unpack into WSL2. */
const longStepTimeout = 300_000

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

/** Runs `fabrica <args>` by the launcher, for its output. */
const fabrica = (
  launcher: string,
  env: Readonly<Record<string, string>>,
  ...args: ReadonlyArray<string>
) =>
  Effect.promise(() =>
    run(launcher, [...args], { env }).then(({ stdout }) => stdout.trim()),
  )

/** The sidebar's "Add project", which opens the Engines screen with its form. */
const openAddProject = (page: Page) =>
  Effect.promise(() =>
    page.getByRole('button', { name: 'Add project', exact: true }).click(),
  )

/** The fixture project's name. */
const fixtureName = 'fixture'

/**
 * A checkout on `main` with its settings committed: the stub's model, a check any tree passes, and no
 * verifier, as the stub plays a worker only. The user's name is `home`'s, as a commit needs one.
 */
const fixtureRepository = (options: {
  readonly home: string
  readonly env: Readonly<Record<string, string>>
  readonly provider: string
}) =>
  Effect.promise(async () => {
    const { home, env, provider } = options
    const checkout = NodePath.join(home, fixtureName)
    const settings = {
      concurrent: 1,
      model: `${provider}/stub`,
      check_own: 'git status --short',
      check_fast: 'git status --short',
      verifier: { enabled: false },
    }
    await mkdir(NodePath.join(checkout, '.fabrica'), { recursive: true })
    await Promise.all([
      writeFile(
        NodePath.join(home, '.gitconfig'),
        '[user]\n\tname = Smoke\n\temail = smoke@example.com\n',
      ),
      writeFile(
        NodePath.join(checkout, '.fabrica', 'settings.json'),
        `${JSON.stringify(settings, null, 2)}\n`,
      ),
      writeFile(
        NodePath.join(checkout, '.gitignore'),
        '.fabrica/run/\n.fabrica/fabrica.log\n',
      ),
    ])
    const git = (...args: ReadonlyArray<string>) =>
      run('git', args, { cwd: checkout, env })
    await git('init', '--quiet', '--initial-branch=main')
    await git('add', '--all')
    await git('commit', '--quiet', '--message', 'one')
    return checkout
  })

/** Adds the checkout at `path` through the console: its form, then its "Added <name>". */
const addProject = (page: Page, path: string) =>
  Effect.promise(async () => {
    const form = page.getByRole('form', { name: 'Add project' })
    await form.locator('#add-project-path').fill(path)
    await form.locator('#add-project-name').fill(fixtureName)
    await form.getByRole('button', { name: 'Add', exact: true }).click()
    await page
      .getByRole('status', { name: 'Added project' })
      .getByText(`Added ${fixtureName}`)
      .waitFor({ timeout: stepTimeout })
  })

/** Selects the project in the sidebar, goes back to the console and starts a run of its current tickets. */
const startRun = (page: Page) =>
  Effect.promise(async () => {
    await page
      .getByRole('button', { name: new RegExp(`^${fixtureName}, `, 'u') })
      .click()
    await page.keyboard.press('Escape')
    await page
      .getByRole('group', { name: 'Run controls' })
      .getByRole('button', { name: 'Start run' })
      .click({ timeout: stepTimeout })
    await page
      .getByRole('menuitem', { name: 'The current tickets' })
      .click({ timeout: stepTimeout })
  })

/**
 * The fixture opened and its one ticket run to its merge, through the console, by the bundled CLI
 * (`launcher`) where the console files no ticket; what came of it, for the test to check.
 */
const runTicket = (options: {
  readonly page: Page
  readonly launcher: string
  readonly env: Readonly<Record<string, string>>
  readonly home: string
}) =>
  Effect.gen(function* () {
    const { page, launcher, env, home } = options
    const stub = yield* stubModel
    const checkout = yield* fixtureRepository({
      home,
      env,
      provider: stub.provider,
    })
    yield* openAddProject(page)
    yield* addProject(page, checkout)
    yield* fabrica(
      launcher,
      env,
      'tickets',
      'create',
      'Add the file',
      '--project',
      fixtureName,
    )
    yield* startRun(page)
    const status = () =>
      fabrica(launcher, env, 'run', 'status', '--project', fixtureName)
    const ended = yield* eventually(
      status(),
      line => /ended \S+ at /u.test(line),
      longStepTimeout,
    )
    // The console's row has heard the run's end too.
    yield* Effect.promise(() =>
      page
        .getByRole('button', {
          name: new RegExp(`^${fixtureName}, .*Idle`, 'u'),
        })
        .waitFor({ timeout: stepTimeout }),
    )
    const merged = yield* Effect.promise(() =>
      run('git', ['show', `main:${committed.file}`], {
        cwd: checkout,
        env,
      }).then(({ stdout }) => stdout.trim(), String),
    )
    return { ended, merged, called: stub.called, unserved: stub.unserved }
  })

/** `fabrica <args>` in the distribution, by the link its install makes (§9.2). */
const fabricaInWsl = (
  distro: string,
  env: Readonly<Record<string, string>>,
  ...args: ReadonlyArray<string>
) =>
  run(
    'wsl.exe',
    [
      '-d',
      distro,
      '--exec',
      'sh',
      '-c',
      'exec "$HOME/.local/bin/fabrica" "$@"',
      'sh',
      ...args,
    ],
    { env: { ...env, WSL_UTF8: '1' } },
  )

/** Adds the engine in WSL2 through the console, installing it, up to its "Installed": the distribution it chose. */
const addWslEngine = (page: Page) =>
  Effect.promise(async () => {
    await page
      .getByRole('button', { name: '+ Add engine' })
      .click({ timeout: stepTimeout })
    await page
      .getByRole('button', { name: 'In WSL2' })
      .click({ timeout: stepTimeout })
    // In its section: SSH's form has a "Check the host", and may be up still as the click's render waits.
    const check = page
      .getByRole('region', { name: 'Engine in WSL2' })
      .getByRole('button', { name: /^Check / })
    const label = await check.textContent({ timeout: stepTimeout })
    await check.click()
    await page
      .getByRole('button', { name: /^(Install|Update to) / })
      .click({ timeout: longStepTimeout })
    await page
      .getByRole('status')
      .getByText(/^Installed fabrica /u)
      .waitFor({ timeout: longStepTimeout })
    return (label ?? '').replace(/^Check /u, '')
  })

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

            const { ended, merged, called, unserved } = yield* runTicket({
              page,
              launcher: engine.value,
              env,
              home,
            })
            expect(ended).toMatch(/ended READY_EMPTY at /u)
            expect(merged).toBe(committed.text)
            expect(called).toEqual(['bash', 'check_own', 'finish'])
            expect(unserved).toEqual([])
          }

          const stopInWsl =
            !posix && wsl
              ? Option.some(
                  yield* Effect.gen(function* () {
                    yield* openAddProject(page)
                    const distro = yield* addWslEngine(page)
                    const stop = Effect.promise(() =>
                      fabricaInWsl(distro, env, 'engine', 'stop').then(
                        () => undefined,
                        () => undefined,
                      ),
                    )
                    yield* Effect.addFinalizer(() => stop)
                    // The console's own word for the app's connection: no other engine answers it here, and the
                    // keep-alive's asking (§7.6) makes the engine's count of clients say nothing of the app.
                    yield* Effect.promise(() =>
                      page
                        .locator('[data-engine-state="Up"]')
                        .first()
                        .waitFor({ timeout: longStepTimeout }),
                    )
                    const answered = yield* Effect.promise(() =>
                      fabricaInWsl(
                        distro,
                        env,
                        'engine',
                        'status',
                        '--json',
                      ).then(
                        ({ stdout }) => Option.isSome(decodeClients(stdout)),
                        () => false,
                      ),
                    )
                    expect(answered).toBe(true)
                    return stop
                  }),
                )
              : Option.none<Effect.Effect<void>>()

          const processes = yield* appProcesses(electron)
          expect(processes.length).toBeGreaterThan(1)
          yield* Effect.promise(() => electron.close())
          // Closing the app leaves its engine running (§7.1): it is stopped as the user would stop it.
          if (Option.isSome(engine)) {
            yield* stopEngine([engine.value], env)
          }
          if (Option.isSome(stopInWsl)) {
            yield* stopInWsl.value
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
