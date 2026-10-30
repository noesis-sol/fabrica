import { Data, Effect, Option, Schema } from 'effect'
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
  run,
  stepTimeout,
  stopEngine,
  toolbox,
} from './packaged-app'

// The published app updating itself (spec §22.2, §22.5): an earlier release's app, installed as a user
// installs it and launched with its update checks on, finds the release just published in the public
// feeds (electron-updater, reading GitHub's latest release), downloads it, and installs it as it quits;
// launched again, the app is the new release. .github/workflows/release.yml's `update` job runs it, once
// the release is published, on each target's newest earlier app (scripts/earlier-app.ts), by
// vitest.update-smoke.config.ts, never by the unit suite.
//
// The app is installed into the test's home folder (packaged-app.ts), as its file's kind says:
// - Linux's AppImage is copied there; the update puts the new release's AppImage in its place, under the
//   new release's name (electron-updater's AppImageUpdater keeps a versioned file name versioned).
// - Windows's NSIS installer installs it there silently; as the app quits, the update's installer runs
//   silently into the same folder (the earlier install's, which it reads from the registry), and the test
//   waits for it, and every process it starts, to end. The app's TEMP and LOCALAPPDATA are in the home
//   folder (packaged-app.ts), so they all run from there.
// - A macOS zip is unpacked there; Squirrel.Mac fetches the update electron-updater downloaded only
//   after electron-updater says it is downloaded, so the test waits for Squirrel.Mac's own word before it
//   quits the app, then for its ShipIt to put the new release's bundle in place. Squirrel.Mac updates
//   only a signed app, to one signed by the same team: the workflow runs it only on signed releases.

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

/** How long the update has to be installed once the app has quit. */
const installTimeout = '5 minutes'

/** The earlier app's kind, which says how it is installed and how its update is. */
type AppKind = Data.TaggedEnum<{
  /** Linux's AppImage, run where it is. */
  AppImage: {}
  /** Windows's NSIS installer. */
  Nsis: {}
  /** A macOS zip, holding the app's bundle. */
  MacZip: {}
}>
const AppKind = Data.taggedEnum<AppKind>()

/** The kind of the app in `file`, as scripts/earlier-app.ts names its files; none for another file. */
const appKind = (file: string): Option.Option<AppKind> =>
  file.endsWith('.AppImage')
    ? Option.some(AppKind.AppImage())
    : file.endsWith('.exe')
      ? Option.some(AppKind.Nsis())
      : file.endsWith('.zip')
        ? Option.some(AppKind.MacZip())
        : Option.none()

/** The bundle a macOS app's executable is in. */
const macBundle = (folder: string) => NodePath.join(folder, 'Fabrica.app')

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

/**
 * The earlier app installed into `folder` from `file`, as a user installs it: its executable. The NSIS
 * installer runs with the app's environment, so it keeps to the home folder as the app does.
 */
const install = (options: {
  readonly kind: AppKind
  readonly file: string
  readonly folder: string
  readonly env: Readonly<Record<string, string>>
}): Effect.Effect<string> => {
  const { file, folder, env } = options
  return AppKind.$match(options.kind, {
    AppImage: () =>
      Effect.promise(async () => {
        const executable = NodePath.join(folder, NodePath.basename(file))
        await copyFile(file, executable)
        await chmod(executable, 0o755)
        return executable
      }),
    Nsis: () =>
      Effect.promise(async () => {
        const target = NodePath.join(folder, 'Fabrica')
        // NSIS reads the folder from `/D=` to the end of its command line, unquoted.
        await run(file, ['/S', `/D=${target}`], {
          env,
          windowsVerbatimArguments: true,
        })
        return NodePath.join(target, 'Fabrica.exe')
      }),
    MacZip: () =>
      Effect.promise(async () => {
        await run('/usr/bin/ditto', ['-x', '-k', file, folder])
        return NodePath.join(macBundle(folder), 'Contents', 'MacOS', 'Fabrica')
      }),
  })
}

/** Where the main process keeps what Squirrel.Mac said, for the test to read. */
const squirrelKey = 'fabricaUpdateSmokeSquirrel'

/** Squirrel.Mac's word on the update, as main records it. */
const SquirrelWord = Schema.Union([
  Schema.Literals(['waiting', 'ready']),
  Schema.TemplateLiteral(['failed: ', Schema.String]),
])
const decodeSquirrelWord = Schema.decodeUnknownSync(SquirrelWord)

/**
 * Records in main when Squirrel.Mac has the update, its `update-downloaded`, or fails: it fetches the
 * update only once electron-updater has downloaded it, so this is followed from launch, long before.
 */
const followSquirrel = (electron: ElectronApplication) =>
  Effect.promise(() =>
    electron.evaluate(({ autoUpdater }, key) => {
      Reflect.set(globalThis, key, 'waiting')
      autoUpdater.once('update-downloaded', () => {
        Reflect.set(globalThis, key, 'ready')
      })
      autoUpdater.once('error', (error: Error) => {
        Reflect.set(globalThis, key, `failed: ${error.message}`)
      })
    }, squirrelKey),
  )

const squirrelWord = (electron: ElectronApplication) =>
  Effect.promise(async () =>
    decodeSquirrelWord(
      await electron.evaluate(
        (_, key) => Reflect.get(globalThis, key),
        squirrelKey,
      ),
    ),
  )

/** The executables of the processes running a file under `folder`, by Windows's process list. */
const windowsProcessesUnder = (folder: string) =>
  Effect.promise(async () => {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ' +
          '$_.ExecutablePath.StartsWith($env:FABRICA_UNDER, [System.StringComparison]::OrdinalIgnoreCase) } | ' +
          'ForEach-Object { $_.ExecutablePath }',
      ],
      { env: { ...host, FABRICA_UNDER: folder } },
    )
    return stdout
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(line => line !== '')
  })

/** The version a macOS bundle's Info.plist names; none while ShipIt has the bundle out of place. */
const bundleVersion = (bundle: string) =>
  Effect.promise(() =>
    run('/usr/bin/plutil', [
      '-extract',
      'CFBundleShortVersionString',
      'raw',
      '-o',
      '-',
      NodePath.join(bundle, 'Contents', 'Info.plist'),
    ]).then(
      ({ stdout }) => Option.some(stdout.trim()),
      () => Option.none<string>(),
    ),
  )

/** The AppImages in `folder`, by name. */
const appImages = (folder: string) =>
  Effect.promise(async () =>
    (await readdir(folder)).filter(name => name.endsWith('.AppImage')).sort(),
  )

const appVersion = (electron: ElectronApplication) =>
  Effect.promise(() => electron.evaluate(({ app }) => app.getVersion()))

/**
 * The app's executable once the update the app downloaded is installed, after it quit: the AppImage put
 * in its place, the installer's run ended, the bundle replaced.
 */
const installed = (options: {
  readonly kind: AppKind
  readonly executable: string
  readonly folder: string
  readonly home: string
}): Effect.Effect<string> => {
  const { executable, folder, home } = options
  return AppKind.$match(options.kind, {
    AppImage: () =>
      Effect.gen(function* () {
        const appImagesThere = yield* appImages(folder)
        expect(appImagesThere).toHaveLength(1)
        expect(appImagesThere).not.toContain(NodePath.basename(executable))
        const [updated = ''] = appImagesThere
        return NodePath.join(folder, updated)
      }),
    Nsis: () =>
      Effect.gen(function* () {
        const left = yield* eventually(
          windowsProcessesUnder(home),
          running => running.length === 0,
          installTimeout,
        )
        expect(left, "the update's installer still runs").toEqual([])
        return executable
      }),
    MacZip: () =>
      Effect.gen(function* () {
        const bundleSays = yield* eventually(
          bundleVersion(macBundle(folder)),
          Option.exists(said => said === version),
          installTimeout,
        )
        expect(bundleSays, "ShipIt didn't put the update in place").toEqual(
          Option.some(version),
        )
        return executable
      }),
  })
}

const kind = appKind(earlierApp)

describe('the published app', () => {
  it('names the app to update and the version it updates to', () => {
    expect(earlierApp, 'FABRICA_UPDATE_APP names no app').not.toBe('')
    expect(
      Option.isSome(kind),
      `FABRICA_UPDATE_APP names no AppImage, NSIS installer or zip: ${earlierApp}`,
    ).toBe(true)
    expect(version, 'FABRICA_UPDATE_VERSION names no version').not.toBe('')
  })

  layer(toolbox)(it => {
    it.effect('updates itself to the release just published', () =>
      Effect.gen(function* () {
        const tools = yield* Toolbox
        const home = yield* homeFolder
        const env = yield* appEnv({ tools, home, host })
        const appKindOf = yield* Effect.fromOption(kind)
        const folder = NodePath.join(home, 'Applications')
        yield* Effect.promise(() => mkdir(folder))
        const executable = yield* install({
          kind: appKindOf,
          file: earlierApp,
          folder,
          env,
        })
        const mac = AppKind.$is('MacZip')(appKindOf)

        const earlier = yield* launchApp({ executable, args: [], env })
        if (mac) {
          yield* followSquirrel(earlier.electron)
        }
        const before = yield* appVersion(earlier.electron)
        expect(before).not.toBe(version)
        const status = yield* eventually(
          updateStatus(earlier.electron),
          settled,
          downloadTimeout,
        )
        expect(status).toEqual(UpdateStatus.cases.Ready.make({ version }))
        if (mac) {
          const word = yield* eventually(
            squirrelWord(earlier.electron),
            said => said !== 'waiting',
            downloadTimeout,
          )
          expect(word).toBe('ready')
        }
        // Quitting installs the update.
        yield* Effect.promise(() => earlier.electron.close())
        yield* stopEngine(earlier.engine, env)

        const updated = yield* installed({
          kind: appKindOf,
          executable,
          folder,
          home,
        })
        const later = yield* launchApp({
          executable: updated,
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
