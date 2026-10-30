import { Effect, Option } from 'effect'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, layer } from '@effect/vitest'

import {
  Toolbox,
  layerToolbox,
  runCommandExit,
  tempFolder,
} from '../packages/testkit/src/index.ts'
import {
  EarlierApp,
  type Release,
  appAssetName,
  earlierApp,
  outputLines,
  readReleases,
} from './earlier-app'

// The earlier release whose app the release's update test updates (spec §22.2, §22.5): the newest
// published one below the release's version with the target's app, or a reason to skip the test.

/** A published release of `version`, with the app's files where `app` says so. */
const release = (
  version: string,
  options: {
    readonly app?: boolean
    readonly draft?: boolean
    readonly prerelease?: boolean
  } = {},
): Release => ({
  tag: `v${version}`,
  draft: options.draft ?? false,
  prerelease: options.prerelease ?? false,
  assets: [
    `fabrica-${version}-linux-x64.tar.gz`,
    'checksums.txt',
    ...(options.app === false
      ? []
      : [
          appAssetName('linux-x64', version),
          `Fabrica-${version}-linux-arm64.AppImage`,
          appAssetName('windows-x64', version),
          appAssetName('macos-x64', version),
          appAssetName('macos-arm64', version),
        ]),
  ],
})

describe('earlierApp', () => {
  it('finds the newest earlier release with the AppImage', () => {
    expect(
      earlierApp({
        version: '0.10.0',
        target: 'linux-x64',
        releases: [
          release('0.10.0'),
          release('0.2.0'),
          release('0.9.0'),
          release('0.9.1-rc.1', { prerelease: true }),
          release('0.1.0'),
        ],
      }),
    ).toEqual(
      EarlierApp.Found({
        tag: 'v0.9.0',
        asset: 'Fabrica-0.9.0-linux-x86_64.AppImage',
      }),
    )
  })

  it('passes over releases without the app, drafts, pre-releases and later versions', () => {
    expect(
      earlierApp({
        version: '1.2.0',
        target: 'linux-x64',
        releases: [
          release('1.3.0'),
          release('1.1.0', { app: false }),
          release('1.0.9', { draft: true }),
          release('1.0.8-rc.1', { prerelease: true }),
          release('1.0.0'),
        ],
      }),
    ).toEqual(
      EarlierApp.Found({
        tag: 'v1.0.0',
        asset: 'Fabrica-1.0.0-linux-x86_64.AppImage',
      }),
    )
  })

  it('has nothing to update before the second release that publishes the app', () => {
    expect(
      earlierApp({
        version: '0.2.0',
        target: 'linux-x64',
        releases: [release('0.2.0'), release('0.1.0', { app: false })],
      }),
    ).toEqual(EarlierApp.NoEarlierApp())
    expect(
      earlierApp({ version: '0.1.0', target: 'windows-x64', releases: [] }),
    ).toEqual(EarlierApp.NoEarlierApp())
  })

  it('skips a pre-release, which the app never updates to', () => {
    expect(
      earlierApp({
        version: '0.2.0-rc.1',
        target: 'macos-arm64',
        releases: [release('0.1.0')],
      }),
    ).toEqual(EarlierApp.PreRelease())
  })

  it("finds each target's own app, the Windows installer and a macOS architecture's zip", () => {
    const releases = [
      release('0.3.0'),
      release('0.2.0'),
      {
        ...release('0.1.0', { app: false }),
        assets: [appAssetName('macos-arm64', '0.1.0')],
      },
    ]
    expect(
      earlierApp({ version: '0.3.0', target: 'windows-x64', releases }),
    ).toEqual(
      EarlierApp.Found({ tag: 'v0.2.0', asset: 'Fabrica-0.2.0-win-x64.exe' }),
    )
    expect(
      earlierApp({ version: '0.3.0', target: 'macos-x64', releases }),
    ).toEqual(
      EarlierApp.Found({ tag: 'v0.2.0', asset: 'Fabrica-0.2.0-mac-x64.zip' }),
    )
    expect(
      earlierApp({ version: '0.2.0', target: 'macos-arm64', releases }),
    ).toEqual(
      EarlierApp.Found({ tag: 'v0.1.0', asset: 'Fabrica-0.1.0-mac-arm64.zip' }),
    )
    expect(
      earlierApp({ version: '0.2.0', target: 'macos-x64', releases }),
    ).toEqual(EarlierApp.NoEarlierApp())
  })
})

describe('outputLines', () => {
  it("writes the step's outputs", () => {
    expect(
      outputLines({
        app: EarlierApp.Found({
          tag: 'v0.1.0',
          asset: appAssetName('linux-x64', '0.1.0'),
        }),
        version: '0.2.0',
        target: 'linux-x64',
      }),
    ).toBe('tag=v0.1.0\nasset=Fabrica-0.1.0-linux-x86_64.AppImage\n')
    expect(
      outputLines({
        app: EarlierApp.PreRelease(),
        version: '0.2.0-rc.1',
        target: 'linux-x64',
      }),
    ).toMatch(/^skip=0\.2\.0-rc\.1 is a pre-release[^\n]*\n$/u)
    expect(
      outputLines({
        app: EarlierApp.NoEarlierApp(),
        version: '0.1.0',
        target: 'windows-x64',
      }),
    ).toMatch(
      /^skip=no release before 0\.1\.0 has the app's Windows x64 installer: [^\n]*\n$/u,
    )
  })
})

describe('readReleases', () => {
  it("reads gh api's lines, and refuses what isn't a release", () => {
    expect(
      readReleases(
        '{"tag":"v0.1.0","draft":false,"prerelease":false,"assets":["a"]}\n\n',
      ),
    ).toEqual(
      Option.some([
        { tag: 'v0.1.0', draft: false, prerelease: false, assets: ['a'] },
      ]),
    )
    expect(readReleases('{"tag":"v0.1.0"}\n')).toEqual(Option.none())
    expect(readReleases('not json\n')).toEqual(Option.none())
  })
})

const repository = join(import.meta.dirname, '..')

layer(layerToolbox({ tools: ['node'] }))('the script', it => {
  const script = (cwd: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const tools = yield* Toolbox
      return yield* runCommandExit({
        command: 'node',
        args: [join(repository, 'scripts', 'earlier-app.ts'), ...args],
        cwd,
        env: tools.env({}),
      })
    })

  it.effect('prints the outputs for the releases gh api lists', () =>
    Effect.gen(function* () {
      const root = yield* tempFolder('earlier-app')
      yield* Effect.promise(() =>
        writeFile(
          join(root, 'releases.jsonl'),
          [release('0.2.0'), release('0.1.0')]
            .map(entry => `${JSON.stringify(entry)}\n`)
            .join(''),
        ),
      )
      expect(
        yield* script(root, ['0.2.0', 'releases.jsonl', 'linux-x64']),
      ).toEqual({
        code: 0,
        stdout: 'tag=v0.1.0\nasset=Fabrica-0.1.0-linux-x86_64.AppImage\n',
        stderr: '',
      })
      expect(
        yield* script(root, ['0.2.0', 'releases.jsonl', 'macos-arm64']),
      ).toEqual({
        code: 0,
        stdout: 'tag=v0.1.0\nasset=Fabrica-0.1.0-mac-arm64.zip\n',
        stderr: '',
      })
      expect(yield* script(root, ['0.2.0', 'none.jsonl', 'linux-x64'])).toEqual(
        {
          code: 1,
          stdout: '',
          stderr: 'earlier-app: none.jsonl lists no releases as gh api does\n',
        },
      )
      const usage = yield* script(root, ['0.2.0', 'releases.jsonl'])
      expect(usage.code).toBe(2)
      const unknown = yield* script(root, [
        '0.2.0',
        'releases.jsonl',
        'linux-armv7l',
      ])
      expect(unknown.code).toBe(2)
      expect(unknown.stderr).toContain(
        'linux-x64|windows-x64|macos-x64|macos-arm64',
      )
    }),
  )
})
