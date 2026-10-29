import { Effect, Option } from 'effect'
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, layer } from '@effect/vitest'
import { Toolbox, runCommand, tempFolder } from '@fabrica/testkit'

import { duckDbNative, npmPin, sizeOf } from '../build/distribution'
import packageJson from '../package.json' with { type: 'json' }
import { DISTRIBUTION_LAYOUT, ENGINE_TARGETS } from '../src/layout'
import {
  Built,
  installedBindings,
  layerBuilt,
  repository,
} from './built-distribution'

// DuckDB in the engine distribution (spec §21, §22.4): its packages copied beside the bundle, with the
// target's native package, of which pnpm installs only the host's, fetched as pnpm-lock.yaml pins it.
// The distribution is built once for the file, as built-distribution.ts says.

/** A query run on the distribution's Node from the bundle's folder, where the engine's import of DuckDB resolves. */
const query = `
const { DuckDBInstance } = await import('@duckdb/node-api')
const instance = await DuckDBInstance.create(':memory:')
const connection = await instance.connect()
const reader = await connection.runAndReadAll('SELECT 42 AS answer')
console.log(JSON.stringify(reader.getRowObjectsJson()))
connection.closeSync()
instance.closeSync()
`

layer(layerBuilt, { timeout: '3 minutes' })(
  'DuckDB in the engine distribution',
  it => {
    it.effect('ships DuckDB at the version apps/engine pins', () =>
      Effect.gen(function* () {
        const { root } = yield* Built
        const manifest = yield* Effect.promise(() =>
          readFile(
            join(root, DISTRIBUTION_LAYOUT.duckDb, 'package.json'),
            'utf8',
          ),
        )
        expect(JSON.parse(manifest)).toMatchObject({
          name: '@duckdb/node-api',
          version: packageJson.dependencies['@duckdb/node-api'],
        })
      }),
    )

    it.effect("carries the target's native package, and no other", () =>
      Effect.gen(function* () {
        const { root, target } = yield* Built
        const { natives } = yield* installedBindings
        const native = duckDbNative(target)
        const entries = yield* Effect.promise(() =>
          readdir(
            join(
              root,
              DISTRIBUTION_LAYOUT.duckDbFolder,
              'node_modules',
              '.pnpm',
            ),
          ),
        )
        expect(
          entries.filter(entry => entry.startsWith('@duckdb+node-bindings-')),
        ).toEqual([`${native.replace('/', '+')}@${natives[native]}`])
      }),
    )

    it.effect("counts DuckDB's part of the unpacked distribution", () =>
      Effect.gen(function* () {
        const { made } = yield* Built
        expect(made.duckDbBytes).toBeGreaterThan(0)
        expect(made.duckDbBytes).toBeLessThan(made.unpackedBytes)
      }),
    )

    it.effect(
      "answers a query on the distribution's Node, from the bundle's folder",
      () =>
        Effect.gen(function* () {
          const { root } = yield* Built
          const tools = yield* Toolbox
          const out = yield* runCommand({
            command: join(root, DISTRIBUTION_LAYOUT.node),
            args: ['--input-type=module', '--eval', query],
            cwd: join(root, DISTRIBUTION_LAYOUT.duckDbFolder),
            env: tools.env(),
          })
          expect(JSON.parse(out)).toEqual([{ answer: 42 }])
        }),
    )
  },
)

describe('sizeOf', () => {
  it.effect(
    'counts a link to a folder as itself, as pnpm links its packages',
    () =>
      Effect.gen(function* () {
        const [linked, measured] = yield* Effect.all([
          tempFolder('dist-size'),
          tempFolder('dist-size'),
        ])
        const [alone, withLink] = yield* Effect.promise(async () => {
          await mkdir(join(measured, 'package'))
          await writeFile(
            join(measured, 'package', 'library'),
            'x'.repeat(4096),
          )
          const before = await sizeOf(measured)
          await writeFile(join(linked, 'library'), 'x'.repeat(4096))
          await symlink(linked, join(measured, 'link'))
          return [before, await sizeOf(measured)] as const
        })
        expect(alone).toBeGreaterThan(4096)
        expect(withLink - alone).toBe(linked.length)
      }),
  )
})

describe('npmPin', () => {
  it.effect(
    "reads DuckDB's native package for every engine target from pnpm-lock.yaml",
    () =>
      Effect.gen(function* () {
        const [lock, { natives }] = yield* Effect.all([
          Effect.promise(() =>
            readFile(join(repository, 'pnpm-lock.yaml'), 'utf8'),
          ),
          installedBindings,
        ])
        for (const target of ENGINE_TARGETS) {
          const name = duckDbNative(target)
          const version = natives[name] ?? ''
          const pin = Option.getOrThrow(npmPin(lock, { name, version }))
          expect(pin.url).toBe(
            `https://registry.npmjs.org/${name}/-/node-bindings-${target}-${version}.tgz`,
          )
          expect(pin.hash).toBe('sha512')
          expect(pin.checksum).toMatch(/^[0-9a-f]{128}$/)
        }
      }),
  )

  it("reads a package's integrity as hex, and finds none for a version it lacks", () => {
    const integrity = Buffer.alloc(64, 0xab).toString('base64')
    const lock = [
      'packages:',
      '',
      "  '@scope/thing@1.0.0':",
      `    resolution: {integrity: sha512-${integrity}}`,
      '',
      'snapshots:',
      '',
      "  '@scope/thing@1.0.0':",
      '    optional: true',
    ].join('\n')
    expect(npmPin(lock, { name: '@scope/thing', version: '1.0.0' })).toEqual(
      Option.some({
        url: 'https://registry.npmjs.org/@scope/thing/-/thing-1.0.0.tgz',
        hash: 'sha512',
        checksum: 'ab'.repeat(64),
      }),
    )
    expect(npmPin(lock, { name: '@scope/thing', version: '2.0.0' })).toEqual(
      Option.none(),
    )
  })
})
