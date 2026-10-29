import { Effect, type Scope } from 'effect'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { KitFailed } from './errors'

/** A new empty folder, removed with everything in it as the scope closes; its real path, links resolved. */
export const tempFolder = (
  prefix: string,
): Effect.Effect<string, KitFailed, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () =>
        realpath(await mkdtemp(NodePath.join(tmpdir(), `fabrica-${prefix}-`))),
      catch: cause =>
        new KitFailed({
          operation: 'make a temp folder',
          path: tmpdir(),
          cause,
        }),
    }),
    path =>
      Effect.promise(() => rm(path, { recursive: true, force: true })).pipe(
        Effect.ignore,
      ),
  )
