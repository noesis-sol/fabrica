import { Effect, Option, Result } from 'effect'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, layer } from '@effect/vitest'

import {
  Toolbox,
  layerToolbox,
  runCommandExit,
  tempFolder,
} from '../packages/testkit/src/index.ts'
import { MergeFailure, mergeFeeds, readFeed, writeFeed } from './mac-feed'

// The macOS app's update feed (spec §22.2, §22.5): the latest-mac.yml each architecture's run writes,
// merged into the one the release publishes, listing every architecture's zip.

/** A latest-mac.yml as electron-builder writes it for one architecture's run. */
const feedText = ({
  version,
  arch,
  date,
}: {
  readonly version: string
  readonly arch: string
  readonly date: string
}) => `version: ${version}
files:
  - url: Fabrica-${version}-mac-${arch}.zip
    sha512: ${arch}Sum+/==
    size: 123
    blockMapSize: 45
path: Fabrica-${version}-mac-${arch}.zip
sha512: ${arch}Sum+/==
releaseDate: '${date}'
`

const x64 = feedText({
  version: '0.1.0',
  arch: 'x64',
  date: '2026-10-30T10:00:00.000Z',
})
const arm64 = feedText({
  version: '0.1.0',
  arch: 'arm64',
  date: '2026-10-30T11:00:00.000Z',
})

const feed = (text: string) =>
  Option.getOrThrowWith(readFeed(text), () => new Error('not a feed'))

describe('merging the macOS feeds', () => {
  it('lists every feed’s files under the first feed’s fields', () => {
    const merged = Result.getOrThrow(mergeFeeds([feed(x64), feed(arm64)]))
    expect(merged).toEqual({
      version: '0.1.0',
      files: [
        {
          url: 'Fabrica-0.1.0-mac-x64.zip',
          sha512: 'x64Sum+/==',
          size: 123,
          blockMapSize: 45,
        },
        {
          url: 'Fabrica-0.1.0-mac-arm64.zip',
          sha512: 'arm64Sum+/==',
          size: 123,
          blockMapSize: 45,
        },
      ],
      path: 'Fabrica-0.1.0-mac-x64.zip',
      sha512: 'x64Sum+/==',
      releaseDate: '2026-10-30T10:00:00.000Z',
    })
  })

  it('writes a feed that reads back as it was, its date a quoted string', () => {
    const merged = Result.getOrThrow(mergeFeeds([feed(x64), feed(arm64)]))
    const text = writeFeed(merged)
    expect(text).toContain('releaseDate: "2026-10-30T10:00:00.000Z"')
    expect(readFeed(text)).toEqual(Option.some(merged))
  })

  it('refuses feeds of different versions', () => {
    const older = feedText({
      version: '0.0.9',
      arch: 'arm64',
      date: '2026-10-29T10:00:00.000Z',
    })
    expect(mergeFeeds([feed(x64), feed(older)])).toEqual(
      Result.fail(MergeFailure.Versions({ versions: ['0.1.0', '0.0.9'] })),
    )
  })

  it('refuses a file two feeds list', () => {
    expect(mergeFeeds([feed(x64), feed(x64)])).toEqual(
      Result.fail(MergeFailure.SameFile({ url: 'Fabrica-0.1.0-mac-x64.zip' })),
    )
  })

  it('refuses no feed', () => {
    expect(mergeFeeds([])).toEqual(Result.fail(MergeFailure.NoFeed()))
  })

  it('reads no feed from a file of another shape', () => {
    expect(readFeed('version: 0.1.0\nfiles: []\n')).toEqual(Option.none())
    expect(readFeed('version: [\n')).toEqual(Option.none())
  })
})

const repository = join(import.meta.dirname, '..')

layer(layerToolbox({ tools: ['node'] }))('the script', it => {
  const script = (cwd: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const tools = yield* Toolbox
      return yield* runCommandExit({
        command: 'node',
        args: [join(repository, 'scripts', 'mac-feed.ts'), ...args],
        cwd,
        env: tools.env({}),
      })
    })

  it.effect('writes the merged feed, or says why it can’t', () =>
    Effect.gen(function* () {
      const root = yield* tempFolder('mac-feed')
      yield* Effect.promise(async () => {
        await writeFile(join(root, 'x64.yml'), x64)
        await writeFile(join(root, 'arm64.yml'), arm64)
        await writeFile(join(root, 'other.yml'), 'name: other\n')
      })
      const merged = yield* script(root, [
        'latest-mac.yml',
        'x64.yml',
        'arm64.yml',
      ])
      expect(merged).toEqual({
        code: 0,
        stdout:
          'latest-mac.yml: version 0.1.0, Fabrica-0.1.0-mac-x64.zip, Fabrica-0.1.0-mac-arm64.zip\n',
        stderr: '',
      })
      const written = yield* Effect.promise(() =>
        readFile(join(root, 'latest-mac.yml'), 'utf8'),
      )
      expect(
        Option.map(readFeed(written), feed => feed.files.map(f => f.url)),
      ).toEqual(
        Option.some([
          'Fabrica-0.1.0-mac-x64.zip',
          'Fabrica-0.1.0-mac-arm64.zip',
        ]),
      )
      const same = yield* script(root, ['out.yml', 'x64.yml', 'x64.yml'])
      expect(same).toEqual({
        code: 1,
        stdout: '',
        stderr: 'mac-feed: two feeds list Fabrica-0.1.0-mac-x64.zip\n',
      })
      const other = yield* script(root, ['out.yml', 'x64.yml', 'other.yml'])
      expect(other).toEqual({
        code: 1,
        stdout: '',
        stderr:
          'mac-feed: other.yml is no update feed electron-builder wrote\n',
      })
      const usage = yield* script(root, ['out.yml'])
      expect(usage.code).toBe(2)
    }),
  )
})
