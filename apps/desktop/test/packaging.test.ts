import { Effect } from 'effect'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { describe, expect, layer } from '@effect/vitest'
import { Toolbox, layerToolbox, runCommand, tempFolder } from '@fabrica/testkit'

import { Embedded, embeddedEngine, stageEngine } from '../build/engine'

// The engine the packaged app embeds (spec §22.2, §7.6): which one each app gets, and how
// electron-builder's beforePack hook stages it from the engine build's output, an unpacked
// distribution for macOS and Linux, the Linux x64 release's files for Windows. The engine build's
// output is a fixture: an archive laid out as the build lays one out, made with the toolbox's tar.

const version = '1.2.0'

/** The engine build's output in `out`: `target`'s archive, holding its launcher, and checksums.txt. */
const engineOut = (target: string, signed: boolean) =>
  Effect.gen(function* () {
    const tools = yield* Toolbox
    const root = yield* tempFolder('pack')
    const out = NodePath.join(root, 'out')
    const name = `fabrica-${version}-${target}`
    const launcher = NodePath.join(root, 'tree', name, 'bin', 'fabrica')
    yield* Effect.promise(async () => {
      await mkdir(NodePath.dirname(launcher), { recursive: true })
      await mkdir(out)
      await writeFile(launcher, '#!/bin/sh\n')
      await writeFile(NodePath.join(out, 'checksums.txt'), 'sums\n')
      if (signed) {
        await writeFile(NodePath.join(out, 'checksums.txt.sig'), 'sig')
      }
    })
    yield* runCommand({
      command: 'tar',
      args: [
        '-czf',
        NodePath.join(out, `${name}.tar.gz`),
        '-C',
        NodePath.join(root, 'tree'),
        name,
      ],
      cwd: root,
      env: tools.env(),
    })
    return { root, out, env: tools.env() }
  })

describe('the engine each app embeds', () => {
  layer(layerToolbox({ tools: ['tar', 'gzip'] }))(it => {
    it('is its own platform’s on macOS and Linux, and the Linux x64 release on Windows', () => {
      expect(embeddedEngine('darwin', 'arm64')).toEqual(
        Embedded.Unpacked({ target: 'darwin-arm64' }),
      )
      expect(embeddedEngine('darwin', 'x64')).toEqual(
        Embedded.Unpacked({ target: 'darwin-x64' }),
      )
      expect(embeddedEngine('linux', 'arm64')).toEqual(
        Embedded.Unpacked({ target: 'linux-arm64' }),
      )
      expect(embeddedEngine('linux', 'x64')).toEqual(
        Embedded.Unpacked({ target: 'linux-x64' }),
      )
      expect(embeddedEngine('win32', 'x64')).toEqual(
        Embedded.Release({ target: 'linux-x64' }),
      )
    })

    it('is none for an app the spec doesn’t build', () => {
      expect(() => embeddedEngine('win32', 'arm64')).toThrow(/win32-arm64/)
      expect(() => embeddedEngine('linux', 'armv7l')).toThrow(/linux-armv7l/)
      expect(() => embeddedEngine('darwin', 'universal')).toThrow(
        /darwin-universal/,
      )
    })

    it.effect('is unpacked in place of what was staged before', () =>
      Effect.gen(function* () {
        const { root, out, env } = yield* engineOut('linux-arm64', false)
        const stage = NodePath.join(root, 'stage')
        yield* Effect.promise(async () => {
          await mkdir(stage)
          await writeFile(NodePath.join(stage, 'stale'), 'from the last pack')
        })
        yield* Effect.promise(() =>
          stageEngine({
            engine: embeddedEngine('linux', 'arm64'),
            version,
            out,
            stage,
            env,
          }),
        )
        expect(
          yield* Effect.promise(() => readdir(stage, { recursive: true })),
        ).toEqual(
          expect.arrayContaining(['bin', NodePath.join('bin', 'fabrica')]),
        )
        expect(yield* Effect.promise(() => readdir(stage))).toEqual(['bin'])
      }),
    )

    it.effect(
      'for Windows, is the release’s archive, checksums and signature',
      () =>
        Effect.gen(function* () {
          const { root, out, env } = yield* engineOut('linux-x64', true)
          const stage = NodePath.join(root, 'stage')
          yield* Effect.promise(() =>
            stageEngine({
              engine: embeddedEngine('win32', 'x64'),
              version,
              out,
              stage,
              env,
            }),
          )
          expect(
            (yield* Effect.promise(() => readdir(stage))).toSorted(),
          ).toEqual([
            'checksums.txt',
            'checksums.txt.sig',
            `fabrica-${version}-linux-x64.tar.gz`,
          ])
          expect(
            yield* Effect.promise(() =>
              readFile(NodePath.join(stage, 'checksums.txt'), 'utf8'),
            ),
          ).toBe('sums\n')
        }),
    )

    it.effect(
      'for Windows, has no signature where the release wasn’t signed',
      () =>
        Effect.gen(function* () {
          const { root, out, env } = yield* engineOut('linux-x64', false)
          const stage = NodePath.join(root, 'stage')
          yield* Effect.promise(() =>
            stageEngine({
              engine: embeddedEngine('win32', 'x64'),
              version,
              out,
              stage,
              env,
            }),
          )
          expect(
            (yield* Effect.promise(() => readdir(stage))).toSorted(),
          ).toEqual(['checksums.txt', `fabrica-${version}-linux-x64.tar.gz`])
        }),
    )

    it.effect(
      'fails, saying how to build it, where the engine wasn’t built',
      () =>
        Effect.gen(function* () {
          const { root, out, env } = yield* engineOut('linux-x64', false)
          const failure = yield* Effect.promise(() =>
            stageEngine({
              engine: embeddedEngine('darwin', 'arm64'),
              version,
              out,
              stage: NodePath.join(root, 'stage'),
              env,
            }).then(
              () => 'staged',
              (error: unknown) =>
                error instanceof Error ? error.message : String(error),
            ),
          )
          expect(failure).toContain(
            'pnpm --filter @fabrica/engine-app dist darwin-arm64',
          )
        }),
    )
  })
})
