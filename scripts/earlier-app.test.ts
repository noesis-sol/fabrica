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
  appImageName,
  earlierApp,
  outputLines,
  readReleases,
} from './earlier-app'

// The earlier release whose app the release's update test updates (spec §22.2, §22.5): the newest
// published one below the release's version with the Linux x64 AppImage, or a reason to skip the test.

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
      : [appImageName(version), `Fabrica-${version}-linux-arm64.AppImage`]),
  ],
})

describe('earlierApp', () => {
  it('finds the newest earlier release with the AppImage', () => {
    expect(
      earlierApp('0.10.0', [
        release('0.10.0'),
        release('0.2.0'),
        release('0.9.0'),
        release('0.9.1-rc.1', { prerelease: true }),
        release('0.1.0'),
      ]),
    ).toEqual(
      EarlierApp.Found({
        tag: 'v0.9.0',
        asset: 'Fabrica-0.9.0-linux-x86_64.AppImage',
      }),
    )
  })

  it('passes over releases without the app, drafts, pre-releases and later versions', () => {
    expect(
      earlierApp('1.2.0', [
        release('1.3.0'),
        release('1.1.0', { app: false }),
        release('1.0.9', { draft: true }),
        release('1.0.8-rc.1', { prerelease: true }),
        release('1.0.0'),
      ]),
    ).toEqual(
      EarlierApp.Found({
        tag: 'v1.0.0',
        asset: 'Fabrica-1.0.0-linux-x86_64.AppImage',
      }),
    )
  })

  it('has nothing to update before the second release that publishes the app', () => {
    expect(
      earlierApp('0.2.0', [release('0.2.0'), release('0.1.0', { app: false })]),
    ).toEqual(EarlierApp.NoEarlierApp())
    expect(earlierApp('0.1.0', [])).toEqual(EarlierApp.NoEarlierApp())
  })

  it('skips a pre-release, which the app never updates to', () => {
    expect(earlierApp('0.2.0-rc.1', [release('0.1.0')])).toEqual(
      EarlierApp.PreRelease(),
    )
  })
})

describe('outputLines', () => {
  it("writes the step's outputs", () => {
    expect(
      outputLines(
        EarlierApp.Found({ tag: 'v0.1.0', asset: appImageName('0.1.0') }),
        '0.2.0',
      ),
    ).toBe('tag=v0.1.0\nasset=Fabrica-0.1.0-linux-x86_64.AppImage\n')
    expect(outputLines(EarlierApp.PreRelease(), '0.2.0-rc.1')).toMatch(
      /^skip=0\.2\.0-rc\.1 is a pre-release[^\n]*\n$/u,
    )
    expect(outputLines(EarlierApp.NoEarlierApp(), '0.1.0')).toMatch(
      /^skip=no release before 0\.1\.0 [^\n]*\n$/u,
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
      expect(yield* script(root, ['0.2.0', 'releases.jsonl'])).toEqual({
        code: 0,
        stdout: 'tag=v0.1.0\nasset=Fabrica-0.1.0-linux-x86_64.AppImage\n',
        stderr: '',
      })
      expect(yield* script(root, ['0.2.0', 'none.jsonl'])).toEqual({
        code: 1,
        stdout: '',
        stderr: 'earlier-app: none.jsonl lists no releases as gh api does\n',
      })
      const usage = yield* script(root, ['0.2.0'])
      expect(usage.code).toBe(2)
    }),
  )
})
