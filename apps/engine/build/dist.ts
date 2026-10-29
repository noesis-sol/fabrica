// `pnpm --filter @fabrica/engine-app dist [target…|all]`: builds the engine distribution (spec §22.1)
// for the targets it names, this host's when it names none, into `apps/engine/out`, and prints each
// archive's size, the unpacked distribution's, and DuckDB's part of it (§22.4, §22.5).
//
// Node runs this file itself, stripping its types: relative imports name their `.ts` files.

import { Console, Effect, Option } from 'effect'
import { readFile } from 'node:fs/promises'
import * as NodePath from 'node:path'
import { fileURLToPath } from 'node:url'

import { NodeRuntime } from '@effect/platform-node'

import { ENGINE_TARGETS, type EngineTarget } from '../src/layout.ts'
import { version } from '../src/version.ts'
import {
  DistributionFailed,
  DistributionFailure,
  buildDistribution,
  httpsDownload,
  nodePin,
} from './distribution.ts'

const app = NodePath.dirname(NodePath.dirname(fileURLToPath(import.meta.url)))
const repository = NodePath.dirname(NodePath.dirname(app))

const isTarget = (name: string): name is EngineTarget =>
  ENGINE_TARGETS.some(target => target === name)

/** The targets the arguments name: every one for `all`, this host's for none. */
const targetsOf = (
  args: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<EngineTarget>, string> => {
  const names =
    args.length === 0 ? [`${process.platform}-${process.arch}`] : args
  if (names.includes('all')) return Effect.succeed(ENGINE_TARGETS)
  const unknown = names.filter(name => !isTarget(name))
  return unknown.length === 0
    ? Effect.succeed(names.filter(isTarget))
    : Effect.fail(
        `no engine target ${unknown.join(', ')}; the targets are ${ENGINE_TARGETS.join(', ')}`,
      )
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`

const program = Effect.gen(function* () {
  const targets = yield* targetsOf(process.argv.slice(2))
  const [lock, lockfile] = yield* Effect.promise(() =>
    Promise.all([
      readFile(NodePath.join(repository, 'mise.lock'), 'utf8'),
      readFile(NodePath.join(repository, 'pnpm-lock.yaml'), 'utf8'),
    ]),
  )
  const out = NodePath.join(app, 'out')
  for (const target of targets) {
    const node = yield* Option.match(nodePin(lock, target), {
      onNone: () =>
        Effect.fail(
          new DistributionFailed({
            target,
            reason: DistributionFailure.NodeNotPinned({ platform: target }),
          }),
        ),
      onSome: Effect.succeed,
    })
    const made = yield* buildDistribution({
      target,
      version,
      node,
      lockfile,
      app,
      extension: NodePath.join(repository, 'packages', 'pi-extension'),
      out,
      download: httpsDownload,
      env: process.env,
    })
    yield* Console.log(
      `${NodePath.relative(repository, made.archive)}: ${megabytes(made.archiveBytes)}, unpacked ${megabytes(made.unpackedBytes)} (DuckDB ${megabytes(made.duckDbBytes)}), sha256 ${made.sha256}`,
    )
  }
  yield* Console.log(
    `${NodePath.relative(repository, NodePath.join(out, 'checksums.txt'))}: written`,
  )
})

program.pipe(
  Effect.tapError(error =>
    Console.error(
      `fabrica dist: ${typeof error === 'string' ? error : error.message}`,
    ),
  ),
  NodeRuntime.runMain({ disableErrorReporting: true }),
)
