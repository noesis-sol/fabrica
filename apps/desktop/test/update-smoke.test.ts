import { Effect, Schema } from 'effect'
import { chmod, copyFile, mkdir, readdir } from 'node:fs/promises'
import * as NodePath from 'node:path'
import type { ElectronApplication } from 'playwright-core'
import { inject } from 'vitest'

import { describe, expect, it, layer } from '@effect/vitest'
import { Toolbox } from '@fabrica/testkit'

import { bundledLauncher } from '../src/main/local-engine'
import { noUpdateCheck } from '../src/main/updates'
import { type FabricaApi, UpdateStatus } from '../src/preload/api'
import {
  appEnv,
  eventually,
  homeFolder,
  launch,
  stepTimeout,
  stopEngine,
  toolbox,
} from './packaged-app'

// The published app updating itself (spec §22.2, §22.5): an earlier release's AppImage, launched with
// its update checks on, finds the release just published in the public feeds (electron-updater, reading
// GitHub's latest release), downloads it, and installs it as it quits; launched again, the app is the new
// release. .github/workflows/release.yml's `update` job runs it, once the release is published, on the
// newest earlier release's Linux x64 AppImage (scripts/earlier-app.ts), by vitest.update-smoke.config.ts,
// never by the unit suite.
//
// The AppImage is copied into the test's home folder (packaged-app.ts), where the update puts the new
// release's AppImage in its place, under the new release's name (electron-updater's AppImageUpdater
// keeps a versioned file name versioned).

declare module 'vitest' {
  export interface ProvidedContext {
    /** The earlier release's AppImage. */
    updateApp: string
    /** The version the app updates to: the release just published. */
    updateVersion: string
  }
}

declare global {
  interface Window {
    readonly fabrica: FabricaApi
  }
}

const earlierApp = inject('updateApp')
const version = inject('updateVersion')
const host = inject('smokeHost')

/** How long the app has to find the release and download it. */
const downloadTimeout = '10 minutes'

const decodeStatus = Schema.decodeUnknownSync(UpdateStatus)

/** Where the app's update stands, as the page reads it from main. */
const updateStatus = (electron: ElectronApplication) =>
  Effect.promise(async () => {
    const page = await electron.firstWindow()
    return decodeStatus(
      await page.evaluate(() => window.fabrica.updateStatus()),
    )
  })

/** Whether the update has come to an end, downloaded or not. */
const settled = (status: UpdateStatus): boolean =>
  UpdateStatus.match(status, {
    Unavailable: () => true,
    Idle: () => false,
    Checking: () => false,
    UpToDate: () => true,
    Downloading: () => false,
    Ready: () => true,
    Failed: () => true,
  })

/** The app launched from `executable`, once it shows the console, and its bundled engine's launcher. */
const launchApp = (options: {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
}) =>
  Effect.gen(function* () {
    const { electron } = yield* launch(options)
    yield* Effect.promise(async () => {
      const page = await electron.firstWindow()
      await page
        .locator('header[aria-label="Title bar"]')
        .waitFor({ timeout: stepTimeout })
    })
    const resources = yield* Effect.promise(() =>
      electron.evaluate(() => process.resourcesPath),
    )
    const engine = bundledLauncher(resources)
    // Stopped whatever the test finds, so a failed run leaves no engine behind.
    yield* Effect.addFinalizer(() => stopEngine(engine, options.env))
    return { electron, engine }
  })

/** The AppImages in `folder`, by name. */
const appImages = (folder: string) =>
  Effect.promise(async () =>
    (await readdir(folder)).filter(name => name.endsWith('.AppImage')).sort(),
  )

const appVersion = (electron: ElectronApplication) =>
  Effect.promise(() => electron.evaluate(({ app }) => app.getVersion()))

describe('the published app', () => {
  it('names the app to update and the version it updates to', () => {
    expect(earlierApp, 'FABRICA_UPDATE_APP names no app').not.toBe('')
    expect(version, 'FABRICA_UPDATE_VERSION names no version').not.toBe('')
  })

  layer(toolbox)(it => {
    it.effect('updates itself to the release just published', () =>
      Effect.gen(function* () {
        const tools = yield* Toolbox
        const home = yield* homeFolder
        const env = yield* appEnv({ tools, home, host })
        const folder = NodePath.join(home, 'Applications')
        const executable = NodePath.join(folder, NodePath.basename(earlierApp))
        yield* Effect.promise(async () => {
          await mkdir(folder)
          await copyFile(earlierApp, executable)
          await chmod(executable, 0o755)
        })

        const earlier = yield* launchApp({ executable, args: [], env })
        const before = yield* appVersion(earlier.electron)
        expect(before).not.toBe(version)
        const status = yield* eventually(
          updateStatus(earlier.electron),
          settled,
          downloadTimeout,
        )
        expect(status).toEqual(UpdateStatus.cases.Ready.make({ version }))
        // Quitting installs the update: the new release's AppImage in place of this one.
        yield* Effect.promise(() => earlier.electron.close())
        yield* stopEngine(earlier.engine, env)

        const installed = yield* appImages(folder)
        expect(installed).toHaveLength(1)
        expect(installed).not.toContain(NodePath.basename(executable))
        const [updated = ''] = installed
        const later = yield* launchApp({
          executable: NodePath.join(folder, updated),
          args: [`--${noUpdateCheck}`],
          env,
        })
        expect(yield* appVersion(later.electron)).toBe(version)
        yield* Effect.promise(() => later.electron.close())
        yield* stopEngine(later.engine, env)
      }),
    )
  })
})
